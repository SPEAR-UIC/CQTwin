# CQTwin live-adapter specification

CQTwin's online twin can be driven two ways. In **trace mode** it reads a whole
SWF file up front (the classic replay). In **stream mode** it starts empty and
receives jobs one scheduler event at a time over the NDJSON socket — the twin's
state learns of a job only when its `submit_job` message arrives, and the twin
never simulates past a time the client has certified complete. This document
specifies the stream protocol and what a real site adapter must do to feed it.

**What ships validated:** the stream protocol, an in-tree trace-replay feeder
that exercises it (`tools/cqtwin_feed.py`), and byte-identical equivalence to the
trace-fed and offline paths (`tests/test_online_stream.cpp`). **What does not:**
any connector to a live PBS/Slurm instance. Site adapters are inherently
site-specific; none is shipped or validated here. Naming a specific facility
integration is future work.

## 1. Selecting stream mode

In the `online_env.json`:

```json
{
  "workload": { "mode": "stream" },
  "cluster":  { "total_procs": 560 },
  "mode": "real",
  "pool": [ { "type": "wfp3", "window_size": 64, "backfilling": true, "legacy_backfill_mode": 1 } ]
}
```

- `workload.mode` is the **workload source** (`"trace"` | `"stream"`). It is a
  different knob from the top-level `mode`, which is the **simulation semantics**
  (`"real"`→Normal, `"perfect"`→Perfect). Keep them distinct.
- `swf_path` is **required for trace**, **ignored for stream**.
- `cluster.total_procs` is **required for stream** — there is no trace to infer
  the cluster size from; the engine errors clearly if it is missing.

## 2. Protocol

The base gym protocol (`reset`, `step`, `close`) is unchanged
(`CQTwin_ONLINE_SIMULATION.md` §8). Stream mode adds three client commands and
one new transition status. Every `reset`/`step`/`stream_advance`/`stream_end`
reply carries a `status` field:

| `status` | meaning | client's next move |
|---|---|---|
| `decision` | parked at a scheduling cycle with a non-empty queue | choose a policy, `step` |
| `waiting_for_events` | reached the certified-complete horizon; nothing more provable | feed jobs, then `stream_advance` / `stream_end` |
| `terminal` | simulation drained (stream ended and queue empty) | `reset` or `close` |

Trace mode only ever returns `decision` / `terminal`.

### 2.1 `submit_job` — register jobs

Registers one job (`"job"`) or a batch (`"jobs"`). Never advances the clock;
never throws on a bad job — bad jobs come back as structured rejections so a live
adapter can log-and-skip rather than die.

```
C→S  {"cmd":"submit_job", "job": { ...fields... }}
C→S  {"cmd":"submit_job", "jobs": [ {...}, {...} ]}
S→C  {"accepted":[<id>,...], "rejected":[{"job_id":<id>,"reason":"...",...}]}
```

Job fields (SWF semantics — send the **raw** values; the engine applies the same
record builder as the trace reader, clamping runtime to the request and applying
the identical validity filter):

| field | required | meaning |
|---|---|---|
| `id` | yes | positive integer, unique within the episode |
| `submit_time` | yes | absolute submit time (seconds) |
| `requested_walltime` | yes | requested runtime / walltime cap (SWF field 9) |
| `runtime` | yes | actual runtime (SWF field 4); clamped to the request |
| `requested_procs` | yes | requested processors (SWF field 8) |
| `requested_memory`, `user_id`, `group_id`, `queue_id` | no | carried through if present |

Rejection `reason` values: `malformed` (missing/instypable fields),
`duplicate_id`, `behind_frontier` (also echoes `frontier_time` and `submit_time`),
`stream_ended`, and record-validity slugs from the shared builder
(`non_positive_id`, `non_positive_runtime`, `non_positive_requested_time`,
`non_positive_procs`, `negative_submit_time`).

### 2.2 `stream_advance` — certify completeness up to a time

```
C→S  {"cmd":"stream_advance", "until": <T>}
S→C  {"obs":{...}, "status":"...", "done":..., "info":{...}}
```

The client asserts **no further event will arrive with time ≤ T**. The twin may
then simulate up to `T` and returns a transition. `until` must be **monotonic**
(≥ the previous assertion). This is the honesty hinge: **event consumption**, not
just job injection, is bounded by `T` — the twin will not process, say, a job End
at 1500 while `T` is 1000, because a submit at 1200 could still legitimately
arrive. It parks at `waiting_for_events` instead. When `status` is
`waiting_for_events`, `info.frontier` reports `current_time`, `asserted_until`,
`pending_delivered`, and `stream_ended`.

### 2.3 `stream_end` — no more jobs, ever

```
C→S  {"cmd":"stream_end"}
S→C  {"obs":{...}, "status":"...", ...}
```

Lifts the horizon to +∞ and runs out the remaining decisions. The agent still
`step`s through every decision until `status` is `terminal`.

### 2.4 Worked session

```
C→S  {"cmd":"reset"}
S→C  {"obs":{...,"time":0}, "status":"waiting_for_events", ...}   # empty twin

C→S  {"cmd":"submit_job","jobs":[{"id":1,"submit_time":100,"requested_walltime":600,
                                  "runtime":540,"requested_procs":128}]}
S→C  {"accepted":[1],"rejected":[]}

C→S  {"cmd":"stream_advance","until":100}
S→C  {"obs":{...,"time":100,"queue":[{"id":1,...}]}, "status":"decision", ...}

C→S  {"cmd":"step","policy":"wfp3"}          # apply a policy to the pending cycle
S→C  {"obs":{...}, "reward":..., "status":"waiting_for_events", ...}

C→S  {"cmd":"submit_job","job":{"id":2,"submit_time":250,"requested_walltime":300,
                                "runtime":300,"requested_procs":64}}
S→C  {"accepted":[2],"rejected":[]}
C→S  {"cmd":"stream_advance","until":250}
S→C  {"obs":{...}, "status":"decision", ...}
C→S  {"cmd":"step","action":0}
S→C  {"obs":{...}, "status":"waiting_for_events", ...}

C→S  {"cmd":"stream_end"}
S→C  {"obs":{...}, "reward":..., "done":true, "status":"terminal",
      "info":{"summary":{"avg_wait":...,"makespan":...}}}
C→S  {"cmd":"close"}
```

## 3. Time-origin convention

The **trace** and **offline** paths shift the timeline to origin 0 (first submit
becomes t=0). **Stream** mode runs on **absolute** time, because the frontier /
`stream_advance` horizon must be on the same real clock the adapter reports. The
schedules are identical; only the origin differs. The comparable per-job quantity
across paths is therefore **wait = start − submit** (shift-invariant); absolute
start times differ by the constant origin. `tests/test_online_stream.cpp` asserts
both wait and origin-normalized start are byte-identical to the offline engine.

## 4. Writing a site adapter

An adapter bridges a real scheduler's event stream to this protocol:

- **Map scheduler events to `submit_job`.** From a PBS accounting log, a job's
  `Q` (queued) record supplies `submit_time`, `requested_walltime`,
  `requested_procs`; emit `submit_job` when you see it. (`S`/`E` start/end records
  are the scheduler's own decisions — the twin recomputes starts itself, so they
  are not fed as events; at most use `E` to learn the eventual `runtime` for
  post-hoc analysis.) From Slurm, map a `job_submit` plugin hook or an `sacct`
  poll of newly-`PENDING` jobs the same way.
- **Emit `stream_advance` from the wall clock.** Periodically assert completeness
  up to a time you are certain no earlier event is still in flight.

### 4.1 The adapter's burden (correctness contract)

The twin is only as honest as the adapter's assertions. Two obligations:

1. **Deliver events in near-submit-time order**, and **always deliver every job
   with `submit_time ≤ T` before asserting `stream_advance(T)`.** A job that
   arrives at or behind the already-certified frontier is *rejected*
   (`behind_frontier`) — accepting it would rewrite already-simulated history, so
   the twin refuses rather than silently corrupt the run. In particular, deliver
   all jobs sharing a submit time together before advancing past that time.
2. **Assert `stream_advance` conservatively** — only up to a time you are certain
   is complete. A lagging or out-of-order source (e.g. a log-tailer that may see
   records seconds late, or across rotated files) must **batch and advance in
   delayed windows**: hold back the horizon by its worst-case delivery lag rather
   than advancing to "now." Advancing too aggressively is the one way to make the
   twin drop real jobs.

Correctly placed, this burden is the adapter's, not the twin's: the twin's job is
to refuse to invent a future it has not been told is settled.

## 5. Replay a trace as a live stream (quickstart)

The in-tree feeder reads an SWF client-side and drives a stream-mode twin exactly
as an adapter would — the reference implementation of this spec.

```bash
# build produces build/cqtwin; write a stream-mode online_env.json (see §1)
# event pace: deliver each submit-time group, then stream_advance — exercises the
# frontier every step, the closest analogue to a live feed.
python3 tools/cqtwin_feed.py stream_env.json data/InputFiles/polaris_2023.swf \
        --pace event --agent fixed --fixed-policy wfp3

# bulk pace: push everything, then stream_end — fast path for tests.
python3 tools/cqtwin_feed.py stream_env.json data/InputFiles/polaris_2023.swf \
        --pace bulk --agent greedy
```

The feeder prints `{accepted, rejected, reject_reasons, steps, summary}`. Because
it sends raw SWF fields through the same record builder, a stream-fed run
reproduces the trace-fed and offline schedules exactly (per-job wait, and start up
to the origin of §3).
