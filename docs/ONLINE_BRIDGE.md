# The Online Mode Bridge

This guide explains **how the dashboard connects a browser to the online simulation engine** — the
server-side "bridge" that turns an HTTP request into a running `cqtwin` process and streams its state back.

It is written to be read top-to-bottom by someone new to the codebase. If you only want to *use* online mode,
read [`DASHBOARD.md`](DASHBOARD.md); if you want the engine's socket protocol in isolation, read
[`CQTwin_ONLINE_SIMULATION.md`](CQTwin_ONLINE_SIMULATION.md). This document is the glue between those two.

---

## 1. The big picture

The C++ engine does the simulation. The **dashboard server** (`dashboard/serve.py`, Python) never simulates
anything itself — it *bridges*: it builds an engine config, launches `build/cqtwin`, and relays results to the
browser. There are **two independent online paths**, and they bridge differently:

```
                                ┌──────────────────────── dashboard/serve.py ───────────────────────┐
   Browser (js/online.js)       │                                                                    │
   ───────────────────────      │   native_bridge.build_online_config()  ─────►  <config>.json       │
                                │                     │                                              │
   PATH A  (headless)           │                     ▼                                              │
   "Launch"  ──HTTP POST──►  /api/online-run ──► spawn:  cqtwin online-run <config>   (subprocess)    │
        ▲                       │                     │  stdout "progress: …"  ──► parsed ──► /status  │
        └───── /api/online/advisory, /api/online/runs ◄── jobs.csv + advisory.csv ◄────────┘          │
                                │                                                                    │
   PATH B  (interactive)        │                     ▼                                              │
   "Launch" (step-through) ─► /api/online/session/start ─► spawn: cqtwin online-serve <config> --port 0
        ▲                       │                     │  stdout "LISTENING <port>"  ──► TCP connect   │
        │  step / advance /     │                     ▼                                              │
        └──── close  ◄──HTTP──► per-session socket RPC  ◄══ NDJSON over TCP ══►  OnlineEnv (in engine) │
                                └────────────────────────────────────────────────────────────────────┘
```

- **Path A — headless advisory run.** One `cqtwin online-run` process runs a whole trace under a fixed
  committed policy, logging per-cycle advisory projections. The bridge just launches it, watches its progress,
  and serves the two files it writes. *Fire-and-forget; no live control.*
- **Path B — interactive step-through session.** One `cqtwin online-serve` process is a **persistent socket
  server**. The bridge holds the socket open across many HTTP requests and forwards one decision at a time.
  *Live; the operator (or an agent) picks each action.*

Both paths start from the **same config**, produced by one function.

---

## 2. The config bridge — `native_bridge.build_online_config`

`dashboard/native_bridge.py::build_online_config(base_dir, output_name, params)` translates dashboard/CQSim
parameters into the JSON config the engine reads. It is the single source of the online config for **both**
paths. Given `params` (job trace, committed policy, backfill, window, pool, horizon, interval), it writes:

```json
{
  "workload": { "mode": "trace" },
  "swf_path": "data/InputFiles/<trace>.swf",
  "mode": "real",
  "committed_policy": "wfp3",
  "output_dir": "data/native_results/<output_name>",
  "tag": "<output_name>",
  "max_submits": 2147483647,
  "pool": [
    { "type": "fcfs", "window_size": 64, "backfilling": true, "legacy_backfill_mode": 1 },
    { "type": "sjf",  "window_size": 64, "backfilling": true, "legacy_backfill_mode": 1 },
    { "type": "wfp3", "window_size": 64, "backfilling": true, "legacy_backfill_mode": 1 }
  ],
  "obs": { "include_advisory": true, "advisory_horizon_seconds": 86400, "advisory_interval": 10 }
}
```

Notes:
- The **committed policy is always forced into the pool** (so its action index exists).
- `read_num` (if set) becomes `max_submits`, capping how many jobs are simulated.
- `advisory_interval` = project every *N*th cycle. Path A uses the user's value; **Path B forces it to `1`** so
  every decision cycle carries a fresh projection (the operator wants to see the advisory at each stop).
- If `node_count`/`procs_per_node` are given, `cluster.total_procs` is added; otherwise the engine infers the
  cluster size from the trace's `; MaxProcs:` header.

The engine reads this identically whether it's `online-run` or `online-serve` (`OnlineEnvConfig::from_file`).

---

## 3. Path A — the headless advisory run

### 3.1 Flow

1. **`POST /api/online-run`** (`serve.py::_api_online_run`) validates the body (pool non-empty and ≤ 8,
   committed policy in pool, horizon > 0, interval ≥ 1, trace exists), builds a `params` dict, registers a
   `run_id`, and starts a **daemon thread** running `_launch_online_advisory`. It returns `{"run_id": "..."}`
   immediately.
2. **`_launch_online_advisory`** builds the config (`build_online_config`), then spawns:
   ```
   build/cqtwin online-run <config.json>
   ```
   as a subprocess, reading its **stdout line by line**.
3. The engine prints a progress line about every 2 seconds:
   ```
   progress: 47% | cycle 1234 | sim_time 86400 | jobs 500/9687
   ...
   progress: 100% | cycle 13025 | done
   ```
   The bridge parses each with `re.match(r"progress:\s*(\d+)%", line)` and updates the run's
   `progress`/`stage`, and appends the raw line to a bounded `log` (last ~240 lines).
4. On exit code 0, the bridge runs the **same post-processing as an offline run**
   (`convert_native_run_to_legacy` + `preprocess_single_run`) — because the committed schedule is byte-identical
   to an offline run of that policy — and stores the chart-ready result. On non-zero exit it records
   `status: "error"`.

### 3.2 What the engine writes

Into `data/native_results/<output_name>/<output_name>/`:
- **`jobs.csv`** — the committed run's per-job results (identical to an offline run of the committed policy).
- **`advisory.csv`** — one row per (cycle × pool policy) on projection cycles:
  ```
  cycle,sim_time,committed_policy,policy,proj_avg_wait,proj_jobs_completed,queue_measured
  ```

### 3.3 Endpoints the browser polls / reads

| Endpoint | Returns |
|----------|---------|
| `GET /api/status` | `{ <run_id>: { status, stage, progress, log, elapsed_sec, … } }` for all runs |
| `GET /api/results/<run_id>` | the full chart-ready result once complete |
| `GET /api/online/runs` | `{ runs: [ { run_name, committed, mtime, size_kb } ] }` — every run that has an `advisory.csv` (the "past runs" picker) |
| `GET /api/online/advisory?run=<name>` | the advisory **analysis** (see §5) for charts |
| `GET /api/online/advisory.csv?run=<name>` | the raw `advisory.csv` download |

`_api_online_advisory` calls `_analyze_advisory_csv(path)`, which parses the CSV into deterministic,
downsampled per-policy series plus a summary:

```json
{
  "series":   { "wfp3": [ { "t": 1080.7, "wait": 0.0 }, … ], … },
  "committed": "wfp3",
  "summary":  { "wfp3": { "frac_lowest": 0.19, "mean_proj_wait": 2902.0 }, … },
  "rows": 35291, "points": 7195, "cycles_evaluated": 7059,
  "policies": ["bsld","f1","fcfs","sjf","wfp3"], "bins": 2000
}
```
- `series[p]` — mean projected avg-wait per policy in each of up to 2000 fixed sim-time bins (deterministic, so
  the same run always renders the same chart).
- `summary[p].frac_lowest` — fraction of evaluated cycles where policy *p* projected the lowest wait ("win rate").
- `summary[p].mean_proj_wait` — its mean projected wait across cycles.

---

## 4. Path B — the interactive step-through session

This is the live bridge: one long-lived `online-serve` process per session, its TCP socket held open across
HTTP requests. All of it lives in `serve.py` (session helpers + `_api_online_session_*` handlers).

### 4.1 Starting a session — spawn, handshake, connect

`POST /api/online/session/start` (`_api_online_session_start`):

1. Validate the body (`_online_params_from_body`, same rules as Path A) and **force `advisory_interval = 1`**.
2. Reap idle sessions (`_online_session_reap`) and enforce the **8-session cap** (else `429`).
3. Build the config (`build_online_config`) and spawn:
   ```
   build/cqtwin online-serve <config.json> --host 127.0.0.1 --port 0
   ```
   `--port 0` asks the OS for a free port.
4. Read the engine's **handshake** from its stdout — the engine binds, then prints exactly:
   ```
   LISTENING <port>
   ```
   (`src/adapters/env/ndjson_server.cpp`). The engine `listen()`s with a backlog of 1 and accepts **one**
   client — so exactly one bridge connects to one engine.
5. `socket.create_connection(("127.0.0.1", port))`, wrap it in a file object for line reads, and send the first
   command, `{"cmd":"reset"}`, over the socket. The engine replies with the first decision observation.
6. Store the session:
   ```python
   ONLINE_SESSIONS[session_id] = {
     "proc": <Popen>, "sock": <socket>, "rfile": <readable>,
     "pool": [...], "committed": "wfp3", "output_name": "session_<id>",
     "lock": threading.Lock(), "cycle": 0, "touched": <time>, "last_queue_sig": "…",
   }
   ```
7. Return the reset observation plus session metadata:
   ```json
   { "session_id": "sess_…", "obs": { … }, "status": "decision", "done": false,
     "info": { … }, "pool": ["fcfs","sjf","wfp3"], "committed": "wfp3", "cycle": 0 }
   ```

### 4.2 The HTTP ↔ socket RPC mapping

Every session HTTP call resolves the session, takes its **per-session lock**, and does one socket round-trip
via `_online_session_rpc(sess, msg)` = "send one JSON line, read one JSON line back":

| HTTP request | Socket command(s) sent to the engine | Response adds |
|--------------|----------------------------------------|---------------|
| `POST …/session/step` `{session_id, action}` | one `{"cmd":"step","action":N}` | `cycle` |
| `POST …/session/advance` `{session_id, action, count}` | a **loop** of `{"cmd":"step","action":N}` | `advanced`, `stopped`, `cycle` |
| `POST …/session/close` `{session_id}` | `{"cmd":"close"}` (via teardown) | `{ok:true}` |

`action` is an **index into `pool`** (0-based). The step/advance response is the engine's own observation JSON
(`obs`, `reward`, `done`, `status`, `info`) with the bridge's `cycle` counter added.

### 4.3 `advance` — the fast-forward semantics

`_api_online_session_advance` runs many steps server-side with **one fixed action**, so the browser makes one
request instead of thousands. `count` may be:

| `count` | Meaning | Stop condition | Cap |
|---------|---------|----------------|-----|
| an integer | advance that many cycles | after *count* steps | clamped to 1…5000 |
| `"end"` | run to completion | `done`/`terminal` | 60000 |
| `"change"` | run to the **next queue change** | the wait-queue signature differs from the one the operator currently sees, **or** `done` | 5000 |

The queue signature is `_online_queue_sig(obs)` = `"<queue_len>:<comma-joined visible queue ids>"`, stored on
the session as `last_queue_sig` after every reset/step/advance. For `"change"`, the **baseline is captured
before the loop** (the queue the operator is looking at now), and the loop stops the moment a step produces a
different signature. The response reports **why** it stopped:

```json
{ "obs": { … }, "done": false, "advanced": 100, "stopped": "change", "cycle": 143 }
```
`stopped` ∈ `{ "done", "change", "cap" }` — so the client can label truthfully (e.g. not claim a "queue change"
when it merely hit the 5000-cycle safety cap).

### 4.4 Concurrency, lifecycle, and cleanup

- **Per-session lock.** Every step/advance/close holds `sess["lock"]` for its whole duration, so a session is
  never driven by two requests at once (the `advance` loop can hold it for seconds on a big `"end"`; other
  sessions are unaffected — the lock is per-session, not global).
- **Idle reaping.** `_online_session_reap()` runs at the top of every *start* (it is **not** a background
  thread) and tears down any session idle longer than `_ONLINE_SESSION_TTL` (30 min). `_online_session_lookup`
  refreshes `touched` on every request, so an in-flight session can't be reaped out from under itself.
- **Teardown** (`_online_session_teardown`, idempotent): send `{"cmd":"close"}`, close the socket, `terminate()`
  the engine process (then `kill()` if it doesn't exit), and `rmtree` the session's scratch dir. It runs on
  `close`, on the last step/advance that returns `done`, on any error, and on reaping.
- **Error paths degrade, never crash.** A missing/reaped session → `404 {error, done:true}`; a socket/RPC
  failure mid-advance → the session is torn down and `500 {error, done:true}` is returned. (The browser client
  treats any `error` field as a failure, so it never renders a partial result as success.)

### 4.5 Important: no persisted output

Unlike Path A, an interactive session does **not** write `jobs.csv`/`advisory.csv` — `online-serve` only
steps; it does not log files. The session is a **live view**; its scratch dir is removed on teardown. Use the
headless run (Path A) when you need the persisted artifacts.

---

## 5. Data shapes reference

**Observation (`obs`)** — returned by reset/step/advance (built by `OnlineEnv::build_obs`):

```json
{
  "step": 12, "time": 86400.0,
  "system":  { "total_procs": 4392, "free_procs": 4136, "util": 0.058,
               "running_count": 1, "queue_len": 3 },
  "metrics": { "avg_wait_so_far": 120.5, "completed": 42 },
  "queue":   [ { "id": 101, "procs": 512, "walltime": 3600.0, "waited": 60.0 }, … ],
  "running": [ { "id": 99,  "procs": 256, "walltime": 7200.0, "remaining": 1200.0 }, … ],
  "pool":    ["fcfs","sjf","wfp3"],
  "advisory":[ { "policy": "fcfs", "proj_avg_wait": 0.0, "proj_jobs_started": 3, "queue_measured": 3 }, … ]
}
```
`advisory` is present only on projection cycles (every cycle when `advisory_interval = 1`, i.e. in a session).

**One `advisory.csv` row** (Path A file) — note the CSV uses `proj_jobs_completed`, while the live `obs`
advisory uses `proj_jobs_started`:
```
cycle,sim_time,committed_policy,policy,proj_avg_wait,proj_jobs_completed,queue_measured
```

**Advisory analysis** (`/api/online/advisory`) — see §3.3.

---

## 6. Code map — where each piece lives

| Concern | Location |
|---------|----------|
| Build the engine config for both paths | `dashboard/native_bridge.py::build_online_config` |
| Headless run: launch + progress parse + post-process | `dashboard/serve.py::_api_online_run`, `_launch_online_advisory` |
| Past-run listing / advisory analysis / CSV | `dashboard/serve.py::_api_online_runs`, `_api_online_advisory`, `_analyze_advisory_csv`, `_api_online_advisory_csv` |
| Session validation | `dashboard/serve.py::_online_params_from_body` |
| Session start (spawn, handshake, connect, reset) | `dashboard/serve.py::_api_online_session_start` |
| Session step / advance / close | `dashboard/serve.py::_api_online_session_step`, `_api_online_session_advance`, `_api_online_session_close` |
| Socket RPC / teardown / reaper / queue signature | `dashboard/serve.py::_online_session_rpc`, `_online_session_teardown`, `_online_session_reap`, `_online_queue_sig` |
| Engine: progress lines | `src/main.cpp` (`online-run`) |
| Engine: socket server + `LISTENING` handshake | `src/adapters/env/ndjson_server.cpp` |
| Engine: the environment (`reset`/`step`, obs, projections) | `src/adapters/env/online_env.cpp` |
| Browser client for both paths | `dashboard/js/online.js` |
| Scripting client (non-dashboard) over the same socket | `tools/cqsim_online.py` |

---

## 7. Extending the bridge

- **Add a session command** (e.g. "jump to next time a large job queues"): add a handler + route in
  `serve.py`, reuse `_online_session_rpc` for the socket round-trip, and mirror the `advance` pattern (hold the
  lock, loop `step`, set a `stopped` reason). No engine change needed if you only combine existing steps.
- **Change what a projection reports**: that is engine-side — edit `OnlineEnv::build_obs` /
  `project_policy` in `src/adapters/env/online_env.cpp`; the bridge forwards whatever the engine returns.
- **A non-browser driver** (an RL agent): skip the dashboard entirely and talk to `online-serve` directly, or
  reuse `tools/cqsim_online.py`. The dashboard bridge and a scripted agent are just two clients of the same
  socket protocol (see [`CQTwin_ONLINE_SIMULATION.md`](CQTwin_ONLINE_SIMULATION.md) §8).
