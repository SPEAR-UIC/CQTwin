# Dashboard Guide

The CQTwin dashboard is a local web app that drives the C++ engine and visualizes results. It is served by
`dashboard/serve.py` (Python standard library + `numpy`) and rendered by static HTML/JS/CSS — no build step
for the frontend.

```bash
bash build.sh --release            # engine must be built (build/cqtwin)
python3 dashboard/serve.py         # http://localhost:8080  (opens a browser)
CQSIM_PORT=8899 python3 dashboard/serve.py   # use a different port
```

The server serves the UI, launches `build/cqtwin` for runs, converts native outputs into the legacy
CQSim-compatible form, post-processes them, and returns chart-ready JSON. Generated artifacts live under
`dashboard/data/` and `data/` (all gitignored).

> **After changing `serve.py`,** restart the process — a running server does not pick up new Python
> endpoints. The static UI (HTML/JS/CSS) *is* reloaded on a browser refresh (assets are cache-busted).

---

## Setup wizard

The landing screen. Configure and launch simulations:

- **Job Trace** — an SWF file from `data/InputFiles/` (or `[Batch] Run all .swf files`).
- **Policy / algorithm**, **backfill** (0 off, 1 EASY, 2 conservative), **window size**, and legacy CQSim
  parameters.
- **Run Simulation** launches the run; a modal shows progress, then the result tabs appear.
- **Parameter Sweep** runs a policy/backfill/window grid.
- Presets can be saved/loaded; existing results can be viewed or cleared.

The wizard also has an **⚡ Open Online Advisory Workspace →** button that jumps to the Online tab.

---

## Result tabs

Once a run completes (or you open existing results):

| Tab | Purpose |
|-----|---------|
| **Overview** | Headline metrics, wait-vs-runtime, utilization over time, top waiting jobs, detailed metric table. A run picker switches between runs. |
| **Per-System** | Metrics grouped by machine/system. |
| **Snap Shot** | Point-in-time system state and fork exploration. |
| **Makespan Lab** | Makespan-focused comparisons. |
| **Compare** | Side-by-side / Pareto comparison across runs. |
| **Worklog** | Historical run log and analysis. |
| **⚡ Online** | The online advisory workspace (below). |

---

## Online tab

A dedicated workspace for the online environment. Two modes share one config panel.

### Config

- **Job Trace**, **Committed Policy** (the policy that actually dispatches), **Backfill**, **Window**.
- **Advisory Pool** — the set of policies projected each cycle (max 8). Quick-select `default (5)` / `all` /
  `none`; a live count warns past the limit. Include the committed policy in the pool.
- **Horizon (hours)** — how far each projection rolls the live queue forward.
- **Projection Interval** — project every *N*th decision cycle. Larger = faster/lighter; `1` is exhaustive.
- **Interactive step-through** (checkbox) — switches from a headless run to a live decision session.

### Headless advisory run

With interactive **off**, **Launch** runs `cqtwin online-run` under the committed policy while logging
per-cycle advisory projections. The committed schedule is byte-identical to an offline run of that policy.

- **Live progress** (in-tab, not a modal): a percent bar with an animated shimmer, an **ETA**, and live
  telemetry tiles parsed from the engine — **cycle**, **sim clock**, **jobs done/total**, **throughput
  (jobs/s)**, and **sim speed (sim-hours/s)** — plus a sparkline of % complete over time and a collapsible
  raw log.
- **Results**:
  - a **recommendation banner** (e.g. "SJF projected the lowest wait in 47% of cycles, ~12% below committed
    WFP3" — advisory only, stated honestly);
  - summary cards (committed policy, pool size, cycles evaluated, committed avg wait / p95, best alternative);
  - an **interactive chart** of projected avg wait per policy over sim-time — toggle Δ-vs-committed, switch
    hours/seconds, isolate the committed policy or show all, click a legend entry to toggle a series;
  - a **sortable comparison table** (win rate, mean projected wait, Δ vs committed) — click a row to isolate
    that policy on the chart;
  - a **download** link for `advisory.csv`.
- **Past runs** — a top-right picker lists previous online runs (any run with an `advisory.csv`) so you can
  revisit them.

### Interactive step-through session

With interactive **on**, **Launch** opens a live `cqtwin online-serve` socket session (managed server-side)
and stops at the first decision cycle. At **each cycle** you see:

- **status cards** — sim clock, utilization, free/total procs, queue length, running count, completed, avg
  wait so far;
- **advisory this cycle** — every pool policy's projected avg wait and projected jobs-started, sorted, with
  the best and the committed policy marked;
- **queue** — the top waiting jobs (procs, walltime, waited).

Then you choose how to continue:

- **Go with advisory →** applies the lowest-projected-wait policy this cycle (the button names it);
- **apply a policy** — one button per pool policy (committed marked ★);
- **fast-forward** — advance many cycles with the **last policy you chose** (committed until you pick one):
  - **Next queue change** — advance until the wait-queue composition changes (a job starts or arrives),
    skipping "stuck" stretches;
  - **+10 / +100** — advance a fixed number of cycles;
  - **Finish** — run to completion with that policy.

Every choice is logged in a **Decisions** history (cycle, chosen policy, jobs started, sim clock), and the run
ends with a summary (avg / p90 / p99 wait, makespan, completed). **Stop session** ends it and tears the
engine down.

Sessions are held server-side with a per-session lock and are reaped after 30 minutes idle; closing/finishing
a session terminates its engine process and removes its scratch data. The interactive session is a live view
— unlike the headless run, it does not persist a `jobs.csv`/`advisory.csv` (use the headless mode for that).

---

## HTTP endpoints (reference)

Offline: `POST /api/run`, `GET /api/status`, `GET /api/results/<id>`, `POST /api/cancel`, `GET /api/files`,
`GET /api/historical`, `GET /api/load/<name>`.

Online (headless): `POST /api/online-run`, `GET /api/online/runs`, `GET /api/online/advisory?run=<name>`,
`GET /api/online/advisory.csv?run=<name>`.

Online (interactive session): `POST /api/online/session/start`, `.../step`, `.../advance`, `.../close`. The
`advance` body takes `count` = an integer, `"end"` (run to completion), or `"change"` (run to the next queue
change); the response reports `advanced` and a `stopped` reason (`done` / `change` / `cap`).

For how the server bridges these HTTP calls to the engine (spawning `online-run`/`online-serve`, the
`LISTENING` handshake, the socket session lifecycle, and every request/response shape), see
[`ONLINE_BRIDGE.md`](ONLINE_BRIDGE.md). For the underlying environment and the NDJSON socket protocol that
`online-serve` speaks, see [`CQTwin_ONLINE_SIMULATION.md`](CQTwin_ONLINE_SIMULATION.md).
