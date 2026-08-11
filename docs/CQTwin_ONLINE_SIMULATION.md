# CQTwin Online Simulation

This document describes how CQTwin runs an **online simulation** — a live,
event-driven run under one committed scheduling policy that, at every decision
point, also reports what a set of *advisory* policies would have done from the
same live state.

It is written as both a design reference and a usage guide. The feature is
**implemented and shipping**: drive it from a plain engine config with
`cqtwin online-run` (headless) or `cqtwin online-serve` (interactive socket), or
from the dashboard's **Online** tab — no extra wiring needed.

**Status legend (retained as design provenance):**

- **[EXISTS]** — a primitive already present in the engine; cited with file references.
- **[IMPLEMENTED]** — the advisory layer described here. It was added as glue over
  those primitives and now ships via `online-run`, `online-serve`, and the dashboard.

---

## 1) What "online simulation" means here

CQTwin is a discrete-event simulator. There are two independent axes people
mean by "online," and it is worth separating them:

1. **Online arrivals** — jobs become known to the scheduler only when they
   submit, not up front. The engine already works this way. **[EXISTS]**
2. **Online decision support** — while the run is in progress, evaluate
   alternative policies from the *current* live state (current queue + running
   jobs) and report each outcome, without changing the committed schedule.
   This is the advisory layer. **[IMPLEMENTED]**

This is **not** "trace replay" in the naive sense (load the whole trace, apply
one fixed policy start to finish, read results at the end). It is also **not**
a live production feed: the workload still comes from an SWF trace file. What is
online is (a) how arrivals enter the simulation and (b) the per-cycle
counterfactual reporting against the live state.

There is **no MCTS, no lookahead search, and no automatic policy switching.**
The committed policy always drives the run. Advisory policies are reported only.

---

## 2) Building blocks that already exist

The online-advisory feature is glue over primitives that are already present and
validated.

### 2.1 Online arrivals via just-in-time (JIT) submission **[EXISTS]**

The `Driver` constructs its `Simulator` with an **empty** job list and injects
each job only when its submit time is reached:

- `src/adapters/simulation/driver.cpp:20` — `sim_(std::vector<SimJob>{}, ...)`
- `src/adapters/simulation/driver.cpp:173` — `next_submit_event()` walks the
  submit-sorted job list one at a time and calls `sim_.register_job(j)`
- `src/adapters/simulation/driver.cpp:185` — `insert_pending_submits()` pushes
  Submit events only up to the time of the next simulator event

Consequence: at any scheduling cycle, the simulator's event queue and job map
contain **only jobs that have already arrived**. Future trace arrivals are not
present. This is what makes any state snapshot honestly "online" — a copy taken
mid-run cannot see the future.

### 2.2 Isolated state snapshots via `get_copy` **[EXISTS]**

- `src/adapters/simulation/simulator.h:39` — `Simulator get_copy(bool enable_logging = true) const;`

`get_copy` shares the read-only job catalog (`shared_ptr<const ...>`) but copies
the mutable state (nodes, event queue, wait queue, running/completed sets). A
copy can be advanced independently without touching the live run. Because of JIT
(2.1), the copy inherits only the currently-known jobs.

### 2.3 Pluggable scheduling and reusable dispatch **[EXISTS]**

Every `SchedulingCycle` event invokes a callback. The production dispatch path is:

- `src/adapters/simulation/legacy_dispatch.cpp:216` — `install_legacy_scheduling_callback()`
- `src/adapters/simulation/legacy_dispatch.cpp:175` — `dispatch_ordered_jobs()`
  (orders the queue via `policy->order(state)`, greedily starts jobs, applies
  backfill via `legacy_backfill_candidates()`)
- `src/core/state.h` — `State::sim` is a live `const Simulator*`, set at
  `src/adapters/simulation/legacy_dispatch.cpp:183`

Any advisory rollout can reuse `install_legacy_scheduling_callback` on a copy, so
simulated futures dispatch **identically** to the real run — no scheduling logic
is reimplemented.

### 2.4 The existing snapshot cousin: `ScenarioPreview` **[EXISTS]**

`ScenarioPreview` already forks a frozen state across two policies (baseline vs
preview) and reports per-job forecasts:

- `src/experiment/scenario_preview.cpp:527` — `run_scenario()` does
  `snapshot.get_copy(false)`, installs a policy, runs to completion, and collects
  per-job start/end/wait

The online-advisory feature generalizes this idea from *one frozen snapshot with
two policies* to *every cycle of a live run with N advisory policies*.

---

## 3) The online-advisory model

### 3.1 Behavior

1. The user picks **one committed policy** up front (a normal driver `type`).
2. The Driver runs the live online simulation under that policy. Jobs arrive via
   JIT, the committed policy dispatches, state advances. This is the real,
   unchanged trajectory.
3. At each scheduling cycle (optionally sampled — see `interval`), **before** the
   committed policy dispatches, the current pre-dispatch state is forked once per
   advisory policy. Each fork:
   - is a `get_copy(false)` of the live simulator,
   - runs under that advisory policy (via `install_legacy_scheduling_callback`),
   - advances only within a **bounded horizon** (a sim-time window from the
     current cycle),
   - yields a **projected average wait** for the jobs that were queued at that
     decision point.
4. The committed run then proceeds normally. Advisory results are logged; the
   live schedule is never altered.

### 3.2 Semantics you must understand to read the numbers

- **Advisory forks do not see future arrivals.** Because of JIT (2.1), a fork
  holds only the jobs known at the decision point. So an advisory projection
  answers: *"Given exactly what is queued and running right now, how would policy
  X clear it over the next H seconds?"* This is the correct online question. It
  will **not** equal an independent full-trace run of policy X, and it should not.
- **Projected wait is measured over the jobs in the queue at that cycle** — the
  jobs whose ordering the policy actually changes. (A completions-based or
  all-known-jobs variant is a one-line change if preferred.)
- **Scheduler view respects `SimMode`.** In `Normal` mode the fork schedules
  against requested walltime (`job_walltime_for`, `src/adapters/simulation/simulator.h:98`);
  jobs still occupy nodes for their true runtime (`job_duration_for`,
  `src/adapters/simulation/simulator.h:97`). `Perfect` mode uses runtime as
  walltime. The fork inherits the live run's mode automatically via `get_copy`.

### 3.3 Algorithm (per fired scheduling cycle)

```
at SchedulingCycle t, with live sim in pre-dispatch state:
    for each advisory spec (type, window, backfill):
        copy      = live.get_copy(false)
        install_legacy_scheduling_callback(copy, policy(spec), spec.backfill)
        queued    = copy.get_job_queue()          # jobs whose wait we score
        copy.inject_scheduling_cycle()
        while copy.has_events() and copy.next_event_time() <= t + horizon_seconds:
            copy.step()
        proj_avg_wait = mean over queued of (job_start_time - submit_time),
                        counting only those started within the horizon
        log(cycle, t, committed_policy, spec.type, proj_avg_wait, ...)
    # committed policy dispatches as usual; live run continues
```

The natural hook point is `Driver::process_scheduling_cycle_event()`
(`src/adapters/simulation/driver.cpp:264`), immediately before the committed
`sim_.step()` that fires the live callback — at that instant `sim_` *is* the
pre-dispatch live state.

---

## 4) How it is wired up

Four additive changes; the committed path and the existing test suite are
untouched.

### 4.1 Config struct

Add to `DriverConfig` (`src/adapters/simulation/driver.h`):

```cpp
struct AdvisoryPolicySpec {
    std::string type;                 // "fcfs", "wfp3", "sjf", "f1", ...
    int         window_size   = INT_MAX;
    bool        backfill      = false;
    int         backfill_mode = 0;    // 0=off, 1=EASY, 2=conservative
};

// ... inside DriverConfig:
std::vector<AdvisoryPolicySpec> advisory;              // empty = feature off
SimTime advisory_horizon_seconds = 86400;              // bounded horizon (24h)
int     advisory_interval        = 1;                  // fire every Nth cycle
```

### 4.2 Advisory evaluator

New `src/adapters/simulation/advisory.{h,cpp}`:

```cpp
struct AdvisoryResult {
    std::string type;
    double      proj_avg_wait   = 0.0;
    int         proj_jobs_done  = 0;
    int         queue_measured  = 0;
};

std::vector<AdvisoryResult>
evaluate_advisory(const Simulator& live_pre_dispatch,
                  const std::vector<AdvisoryPolicySpec>& specs,
                  SimTime horizon_seconds);
```

Implement exactly as in section 3.3, reusing `make_heuristic_policy`,
`install_legacy_scheduling_callback`, and `job_start_time`. The advisory policies
are independent, so the loop can be an OpenMP `parallel for` (OpenMP is already an
optional dependency in `CMakeLists.txt`).

### 4.3 Driver hook + output

- Call `evaluate_advisory` inside `Driver::process_scheduling_cycle_event()`
  when `config_.advisory` is non-empty and `cycle_number_ % advisory_interval == 0`.
- Open one more output file next to `performance.csv` / `events.csv`:
  `advisory.csv` with the long-format schema in section 5.2.

### 4.4 Config parsing

In `src/experiment/json_experiment.cpp:100` (the `drivers` loop), parse an
optional `advisory` object into `dc.advisory`, `dc.advisory_horizon_seconds`,
`dc.advisory_interval`.

### 4.5 Build + test

- Add `src/adapters/simulation/advisory.cpp` to both `CQTWIN_SOURCES` and
  `COMMON_SIM_SRCS` in `CMakeLists.txt`.
- Add `tests/test_advisory.cpp`: a small synthetic trace where FIFO and SJF order
  the queue differently, asserting `evaluate_advisory` returns the expected
  distinct projected waits and never mutates the live simulator.

---

## 5) How to use it

### 5.1 Config

Add an `advisory` block to any driver. The driver's own `type` is the committed
policy that actually runs; `advisory.policies` are reported only.

```json
{
  "output_dir": "data/native_results/polaris_online_demo",
  "swf_path": "data/InputFiles/polaris_norm.swf",
  "mode": "real",
  "drivers": [
    {
      "type": "wfp3",
      "tag": "polaris_online_demo",
      "backfilling": true,
      "legacy_backfill_mode": 2,
      "window_size": 64,

      "advisory": {
        "horizon_seconds": 86400,
        "interval": 1,
        "policies": [
          { "type": "fcfs" },
          { "type": "sjf", "window_size": 64 },
          { "type": "f1",  "window_size": 64, "backfilling": true, "legacy_backfill_mode": 2 }
        ]
      }
    }
  ]
}
```

Run it exactly like any other engine config:

```bash
./build/cqtwin run data/engine_runs/polaris_online_demo.json
```

The committed WFP3 run produces the usual `performance.csv` / `events.csv` and
per-job results; the advisory layer adds `advisory.csv`.

### 5.2 Output: `advisory.csv`

One row per (cycle, advisory policy):

```
cycle,sim_time,committed_policy,policy,proj_avg_wait,proj_jobs_completed,queue_measured
1,10230,wfp3,fcfs,14082.5,7,12
1,10230,wfp3,sjf,9640.0,9,12
1,10230,wfp3,f1,10110.0,8,12
2,10870,wfp3,fcfs,13120.0,5,9
...
```

Read it as: *"At cycle 1 (sim time 10230), the live run is committed to WFP3.
From this exact state, over the next 24h, FCFS would give the 12 queued jobs an
average wait of ~14083s, SJF ~9640s, F1 ~10110s."* The committed policy's own
realized numbers come from the normal per-job results, not this file.

### 5.3 Tuning cost

Cost per fired cycle is `len(policies) x horizon-steps`. Knobs:

- `advisory_interval` — sample cycles (e.g. `10` = evaluate every 10th cycle).
- `advisory_horizon_seconds` — shorter horizon = cheaper, more myopic.
- Number of advisory policies — keep the pool focused.
- OpenMP parallelizes the policy loop (see 4.2).

---

## 6) What this is and is not

| It is | It is not |
|---|---|
| Event-driven, JIT online arrivals | A live production/facility feed |
| One committed policy driving a real run | Automatic policy switching |
| Per-cycle advisory projections, reported only | MCTS or lookahead search |
| Bounded-horizon "clear the current backlog" numbers | A full-trace forecast per policy |
| Engine feature + `advisory.csv` | A dashboard feature (intentionally out of scope) |

To surface it in the browser later, a user would add: a `serve.py` endpoint to
launch the config and serve `advisory.csv`, and a panel in
`dashboard/js/operator.js` to render the per-cycle table. That is deliberately
left as a separate hook-up step.

---

## 7) Applicable entry point: the `online` request file

Sections 3–5 add the advisory layer onto a normal trace-replay driver. This
section defines the **purpose-built online entry point** so an operator runs
from the cluster's *current state* — no historical trace and no engine internals
required. The user hands the engine one file describing "now":

```
cqtwin online <online.json>
```

### 7.1 Request schema (annotated)

```json
{
  "output_dir": "data/online_results/polaris_now",
  "tag": "polaris_now",
  "mode": "real",

  "cluster": { "total_procs": 560 },

  "now": {
    "running": [
      { "id": 8001, "procs": 128, "walltime": 7200, "elapsed": 3600 },
      { "id": 8002, "procs": 256, "walltime": 3600, "elapsed": 600, "run_time": 3000 }
    ],
    "queued": [
      { "id": 9001, "procs": 256, "walltime": 3600, "waiting": 1200 },
      { "id": 9002, "procs": 64,  "walltime": 600,  "waiting": 300 }
    ]
  },

  "arrivals": { "swf_path": "data/InputFiles/incoming.swf" },

  "committed": {
    "policy": "wfp3", "window_size": 64, "backfilling": true, "legacy_backfill_mode": 2
  },

  "advisory": {
    "horizon_seconds": 86400,
    "interval": 1,
    "policies": [ {"type":"fcfs"}, {"type":"sjf","window_size":64}, {"type":"f1"} ]
  }
}
```

### 7.2 Fields

| Block | Field | Req | Type | Default | Meaning |
|---|---|---|---|---|---|
| top | `output_dir` | yes | str | — | results directory |
| top | `tag` | no | str | committed policy | run label / subdir |
| top | `mode` | no | str | `"real"` | real/prediction → Normal; perfect → Perfect |
| `cluster` | `total_procs` | yes | int | — | cluster capacity |
| `now.running[]` | `id` | yes | int | — | unique job id |
| | `procs` | yes | int | — | allocated processors |
| | `walltime` | yes | int (s) | — | requested walltime (scheduler's "frees-at" view) |
| | `elapsed` | no | int (s) | 0 | time already run (0 ≤ elapsed ≤ walltime) |
| | `run_time` | no | int (s) | `walltime` | true total runtime (eval/perfect); must be > `elapsed` |
| `now.queued[]` | `id` | yes | int | — | unique job id (distinct from running) |
| | `procs` | yes | int | — | requested processors |
| | `walltime` | yes | int (s) | — | requested walltime |
| | `waiting` | no | int (s) | 0 | seconds already waited (`submit_time = −waiting`) |
| | `run_time` | no | int (s) | `walltime` | true runtime (eval/perfect) |
| `arrivals` | `swf_path` / `jobs` | no | str / arr | — | future submissions; **omit → drain backlog only** |
| `committed` | `policy` | yes | str | — | policy that runs the live schedule forward |
| | `window_size` / `backfilling` / `legacy_backfill_mode` | no | — | INT_MAX / false / 0 | committed policy config |
| `advisory` | `horizon_seconds` | no | int (s) | 86400 | bounded projection horizon |
| | `interval` | no | int | 1 | evaluate every Nth cycle |
| | `policies[]` | no | arr | `[]` | advisory policies (type/window/backfill); omit → no advisory |

- Array order of `now.queued[]` defines the current queue order (FIFO tie-break).
- `arrivals.swf_path`: each record's submit time is offset by the file's
  earliest submit, so arrivals begin at "now" and preserve inter-arrival gaps.
- Inline `arrivals.jobs[]`: `{ id, procs, walltime, submit_after, run_time? }`,
  where `submit_after` is seconds from now.

### 7.3 Validation (rejected before running)

- `sum(now.running.procs) ≤ cluster.total_procs`
- ids unique across `now.running` + `now.queued` + `arrivals`
- every job `procs ≤ total_procs` (else it could never be scheduled)
- `0 ≤ elapsed ≤ walltime`, and `run_time > elapsed` for running jobs
- at least one of `now.running` / `now.queued` is non-empty

### 7.4 How the loader maps it to the engine

1. `current_time = 0` ("now").
2. **Seed running jobs** — allocate procs, `start_time = −elapsed`, scheduler
   frees-at reservation `= walltime − elapsed`, and an `End` event at
   `run_time − elapsed` (true remaining). Needs one new Simulator API
   `seed_running_job(job, elapsed)`; `try_start_job` can't express a job that is
   already partway through.
3. **Seed the queue** — register each queued job with `submit_time = −waiting`
   and push it into the wait queue in array order (no Submit event; already
   submitted).
4. Fire a `SchedulingCycle` at t=0 so the committed policy dispatches.
5. **JIT-feed `arrivals`** (if present) as Submit events at `now + submit_after`.
6. Run until the backlog clears (or arrivals are exhausted), evaluating the
   advisory policies each cycle (§3–4) and writing `advisory.csv`.

### 7.5 Output

`<output_dir>/<tag>/`:
- committed run: `jobs.csv`, `performance.csv`, `events.csv`, `legacy_sys.csv`
- `advisory.csv` (when `advisory.policies` is set)
- `resolved_request.json` — the request after defaults + validation, for provenance

### 7.6 New code to support this entry point

- `src/experiment/json_online.{h,cpp}` — request loader + validation
- `Simulator::seed_running_job(const SimJob&, SimTime elapsed)` — seed a
  partway-through running job
- `online` subcommand in `src/main.cpp`
- reuse: `install_legacy_scheduling_callback`, `evaluate_advisory`, JIT submit

---

## 8) Online environment: external-agent protocol

This is the "make it a testbed" layer. **Offline** = trace replay under one fixed
policy (`cqtwin run`, your baselines). **Online** = the *same trace and
cluster*, but at each scheduling cycle an external **agent** (your auto-policy
selection, in Python or any language) chooses which policy to apply. Because both
modes replay the same workload, an adaptive selector's result is directly
comparable to every single static policy — that is the experiment: *does
adaptation beat the best fixed policy?*

The engine is exposed as a **steppable environment**: your agent drives a
`reset()` / `step(action)` loop, exactly like a Gym/Gymnasium environment.

### 8.1 Roles and transport

- The C++ engine runs as a **server**: `cqtwin online-serve <online_env.json> --port <p>`.
  It listens on `127.0.0.1:<p>` and answers one request per scheduling decision.
- A provided Python `gym.Env` client (`dashboard/../tools/cqsim_online.py`) is the
  **driver**: it spawns the engine subprocess (or connects to an already-running
  one), then drives `reset` / `step` / `close`.
- **Transport: local TCP on `127.0.0.1`.** Portable across macOS/Linux, and leaves
  the door open to a remote engine. A Unix-domain socket (`--socket <path>`) is an
  easy same-host alternative and can be added behind the same protocol.
- **Wire format: NDJSON** — one JSON object per line, UTF-8, `\n`-terminated,
  strict request→response (the client always waits for the reply before sending
  the next request).

### 8.2 The Python loop (what the user writes)

```python
from cqsim_online import CQSimOnlineEnv

env = CQSimOnlineEnv("online_env.json")     # spawns + connects to the engine
obs, info = env.reset()
done = False
while not done:
    action = my_selector(obs)               # <-- YOUR auto-policy selection
    obs, reward, done, truncated, info = env.step(action)
env.close()
```

`my_selector` is the thing under test. A constant selector reproduces an offline
single-policy run; anything adaptive is what you are evaluating.

### 8.3 Config: `online_env.json`

Reuses the existing engine config fields (so offline/online stay comparable) plus
`pool` / `reward` / `obs`:

```json
{
  "swf_path": "data/InputFiles/polaris_norm.swf",
  "cluster": { "total_procs": 560 },
  "mode": "real",
  "max_submits": 10000,
  "start_job_index": 0,

  "pool": [
    { "type": "fcfs" },
    { "type": "sjf",  "window_size": 64 },
    { "type": "wfp3", "window_size": 64, "backfilling": true, "legacy_backfill_mode": 2 },
    { "type": "f1",   "window_size": 64 }
  ],

  "reward": { "type": "neg_avg_wait_delta" },

  "obs": { "queue_window": 32, "include_advisory": false, "advisory_horizon_seconds": 86400 },
  "episode": { "randomize_start": false }
}
```

`pool` is the discrete action set. `obs.include_advisory` gates the per-cycle
advisory projections in the observation (off by default — each one costs `|pool|`
rollouts). `episode.randomize_start` can vary the trace slice per `reset()` for
training diversity.

### 8.4 Action space

Discrete over the pool: `action ∈ [0, len(pool))`. The engine applies
`pool[action]`'s ordering + its backfill config for this cycle only, then advances.

```json
{ "cmd": "step", "action": 2 }        // apply pool[2] this cycle
```

`{ "cmd": "step", "policy": "wfp3" }` is accepted as a name-based convenience.

### 8.5 Observation schema

One object per **decision point** (a scheduling cycle where `queue_len ≥ 1`;
cycles with an empty queue are auto-skipped so the agent is only asked when a
choice matters):

```json
{
  "step": 42, "time": 105230,
  "system": { "total_procs": 560, "free_procs": 128, "util": 0.77,
              "running_count": 6, "queue_len": 14 },
  "metrics": { "avg_wait_so_far": 4123.5, "completed": 812 },
  "queue":   [ { "id": 9001, "procs": 256, "walltime": 3600, "waited": 1200 } ],
  "running": [ { "id": 8001, "procs": 128, "walltime": 7200, "remaining": 3600 } ],
  "pool":    [ "fcfs", "sjf", "wfp3", "f1" ],
  "advisory":[ { "policy": "fcfs", "proj_avg_wait": 14082.5 } ]
}
```

| Field | Meaning |
|---|---|
| `step`, `time` | decision index and sim time |
| `system` | capacity, free procs, utilization, running/queue counts |
| `metrics` | rolling realized metrics up to now (for reward shaping / stopping) |
| `queue[]` | up to `obs.queue_window` waiting jobs: `procs`, `walltime`, `waited` |
| `running[]` | running jobs: `procs`, `walltime`, `remaining` (frees-at view) |
| `pool[]` | the action set, index-aligned with the action integer |
| `advisory[]` | *(only if `obs.include_advisory`)* per-pool-policy projected wait — the §3 signal, as an optional feature |

The wrapper hands this to `my_selector` as a dict; featurizing to a fixed vector
is the agent's job (kept out of the engine so the observation stays inspectable).

### 8.6 Reward

Reward is the user's objective, so it is configurable and the raw counters ride
along in `info` for fully custom rewards:

| `reward.type` | Value returned by `step` |
|---|---|
| `neg_avg_wait_delta` *(default)* | −(Δ average wait of jobs that started since the last step) |
| `neg_wait_delta` | −(Δ total accrued wait over the advanced interval) |
| `util` | mean utilization over the advanced interval |
| `constant` | 0.0 (use `info` to compute your own) |

`info` always includes `{ jobs_started, jobs_completed, wait_delta, interval_seconds, util }`,
and at episode end `{ avg_wait, p99_wait, makespan, util }` for the whole run.

### 8.7 Wire protocol

```
C→S  {"cmd":"reset"}
S→C  {"obs":{...}, "info":{...}}

C→S  {"cmd":"step","action":2}
S→C  {"obs":{...}, "reward":-1.2, "done":false, "truncated":false, "info":{...}}
       ... repeat ...
S→C  {"obs":{...}, "reward":-0.4, "done":true,  "truncated":false, "info":{"avg_wait":...,"makespan":...,"util":...}}

C→S  {"cmd":"reset"}          # next episode (multi-episode training)
       ...
C→S  {"cmd":"close"}
```

- Errors are reported as `{"error":"<message>"}` and the client raises.
- `done=true` when the trace is exhausted **and** the queue has drained.
  `truncated=true` if a configured step/time budget is hit first.
- `reset` re-instantiates the sim from the config; deterministic unless
  `episode.randomize_start` is set.

### 8.8 Comparability with offline baselines

- Run each pool policy offline (`cqtwin run`) → one metric row per static policy.
- Run your selector in the env on the **same trace / cluster / mode** → one metric row.
- Because only the per-cycle decision differs, the comparison isolates the value
  of adaptation. Offline is literally the env with a constant selector, so the two
  paths share the same simulator and can be cross-checked for parity.

### 8.9 Implementation (shipped)

- `src/adapters/env/online_env.{h,cpp}` — `OnlineEnv::reset()` / `step(action)`
  over the Simulator: advance to the next decision point, apply `pool[action]`
  via `dispatch_ordered_jobs` + backfill, compute reward, build the observation
  (incl. optional advisory projections).
- `src/adapters/env/ndjson_server.{h,cpp}` — the `127.0.0.1` TCP request/response
  loop (stdlib POSIX sockets; no new dependency).
- `online-serve` subcommand in `src/main.cpp`.
- `tools/cqsim_online.py` — the gym-style client (spawns/connects, `reset`/`step`/
  `close`) plus example `RandomSelector` and `GreedyProjectionSelector` agents.
- `tests/test_online_env.cpp` — 5 in-process tests (reset/step/terminal/bounds/repeatability).

### 8.10 Quickstart (verified)

```bash
# 1. Build (produces build/cqtwin)
bash build.sh --release          # or: cmake --build build

# 2. Write an online_env.json (see §8.3), then drive it with an agent:
python3 tools/cqsim_online.py online_env.json --agent random --episodes 2
python3 tools/cqsim_online.py online_env.json --agent greedy   # needs obs.include_advisory:true
```

`CQSimOnlineEnv` spawns `cqtwin online-serve <config> --port 0`, reads the
`LISTENING <port>` handshake, connects, and drives `reset()`/`step()`. Plug your
own selector in place of `RandomSelector` / `GreedyProjectionSelector`. On a
300-job Aurora slice, greedy-on-projection cut average wait ~12× vs. random —
the "does adaptation beat naive choice?" comparison the testbed exists for.

---

## 9) Code reference index

| Concern | Location |
|---|---|
| JIT online arrivals | `src/adapters/simulation/driver.cpp:20`, `:173`, `:185` |
| Register job before submit | `src/adapters/simulation/driver.cpp:181` |
| State snapshot | `src/adapters/simulation/simulator.h:39` (`get_copy`) |
| Live simulator handle for policies | `src/core/state.h` (`State::sim`), `src/adapters/simulation/legacy_dispatch.cpp:183` |
| Reusable dispatch + backfill | `src/adapters/simulation/legacy_dispatch.cpp:175`, `:216` |
| Scheduling-cycle injection | `src/adapters/simulation/simulator.h:45` (`create_scheduling_cycle_event`), `:54` (`inject_scheduling_cycle`) |
| Scheduler-view vs true runtime | `src/adapters/simulation/simulator.h:98` (`job_walltime_for`), `:97` (`job_duration_for`) |
| Existing 2-policy snapshot fork | `src/experiment/scenario_preview.cpp:527` (`run_scenario`) |
| Driver cycle hook point | `src/adapters/simulation/driver.cpp:264` (`process_scheduling_cycle_event`) |
| Driver config parsing | `src/experiment/json_experiment.cpp:94`–`:138` |
| Online env (reset/step/obs/reward) | `src/adapters/env/online_env.{h,cpp}` |
| NDJSON socket server | `src/adapters/env/ndjson_server.{h,cpp}` |
| `online-serve` subcommand | `src/main.cpp` |
| Python gym client + example agents | `tools/cqsim_online.py` |
| Online env tests | `tests/test_online_env.cpp` |
