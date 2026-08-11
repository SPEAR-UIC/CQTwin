# CQTwin

**A fast, CQSim-compatible HPC batch-scheduling simulator with a native C++ engine and a browser dashboard.**

CQTwin is a compatibility-oriented rewrite of [CQSim](https://github.com/SPEAR-IIT/CQSim). It keeps the
CQSim workflow, input format (SWF traces), and output contract, but replaces the slow Python simulation core
with a native **C++17 discrete-event engine** that is faster and covered by an extensive test suite. A
Python/JavaScript **dashboard** drives runs and visualizes results, and an **online mode** exposes the engine
as a gym-style environment for human-in-the-loop or programmatic scheduling policy studies.

> The goal is not a new scheduler product. It is to preserve the legacy CQSim experience while making the
> simulation backend fast, deterministic, and well tested.

---

## Highlights

- **Native C++17 engine** — a discrete-event simulator that replays SWF workload traces under a chosen
  dispatch policy, with EASY / conservative backfilling and maintenance windows.
- **20 scheduling policies** — FCFS, SJF/LJF, SRF/LRF, SCF/LCF, WFP1–3, SWW, FCSJ, FAT, UNICEP, BSLD, and the
  fitted F1–F4 heuristics.
- **CQSim compatibility** — reads the same SWF traces and emits legacy-compatible outputs, so the existing
  preprocessing and visualization pipeline works unchanged.
- **Interactive dashboard** — configure and launch runs, compare policies, and inspect per-job / per-system
  metrics in the browser.
- **Online simulation** — a trace- or stream-driven `OnlineEnv` with per-cycle **advisory projections**
  ("which policy would clear the live queue fastest right now?"), available headless, over an NDJSON socket,
  and as a **human-in-the-loop step-through** in the dashboard.
- **Deterministic & tested** — 180+ GoogleTest cases, including bit-exact online-vs-offline equivalence and
  ThreadSanitizer-clean parallel projections.

---

## Repository layout

```
CQTwin/
├── src/                     C++ engine
│   ├── core/                jobs, nodes, resources, time
│   ├── adapters/
│   │   ├── simulation/      Simulator, Driver, backfill, event queue
│   │   └── env/             OnlineEnv + NDJSON socket server
│   ├── io/                  SWF reader
│   ├── experiment/          JSON experiment runner, metrics, scenario preview
│   ├── policies/            policy factory (the 20 heuristics)
│   └── main.cpp             CLI entry point
├── dashboard/               Python backend + JS/HTML frontend
│   ├── serve.py             HTTP server + run orchestration
│   ├── native_bridge.py     legacy CQSim params <-> native JSON config
│   ├── preprocess.py        result post-processing
│   ├── recommend.py         runtime recommendation module (needs numpy)
│   ├── index.html, js/, css/
│   └── data/                generated dashboard data (gitignored)
├── tools/                   scripting utilities (measurement, Python alt-engine)
├── tests/                   GoogleTest suite + test.swf
├── docs/                    detailed documentation (see below)
├── data/
│   └── InputFiles/          SWF input traces (test.swf + mira_norm.swf shipped)
├── third_party/             vendored nlohmann/json
├── sys_req/                 Python requirements + module bootstrap
├── CMakeLists.txt, build.sh
└── LICENSE (MIT)
```

Everything a run *generates* — `data/Results/`, `data/native_results/`, `dashboard/data/*`, `build/` — is
regenerated at runtime and is **not** tracked (see `.gitignore`). Only the input traces under
`data/InputFiles/` ship with the repo.

---

## Requirements

| Component | Requirement |
|-----------|-------------|
| C++ engine | CMake ≥ 3.20, a C++17 compiler (Clang/AppleClang or GCC) |
| Dashboard / tools | Python ≥ 3.9 (3.10+ recommended) |
| Python packages | `numpy` (only for `dashboard/recommend.py`) — `pip install -r sys_req/requirements.txt` |
| Dashboard UI | any modern browser |

GoogleTest is fetched automatically at CMake configure time; the only vendored dependency is
`third_party/nlohmann/json.hpp`.

---

## Build

```bash
bash build.sh              # debug build   -> build/cqtwin
bash build.sh --release    # optimized build (recommended for real runs)
bash build.sh --clean      # wipe build/ first
bash build.sh --asan       # + AddressSanitizer/UBSan
bash build.sh --tsan       # + ThreadSanitizer
```

Or directly with CMake:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
```

The engine binary lands at `build/cqtwin`. Build all targets (engine + tests) with `cmake --build build`.

---

## Quickstart

### 1. Dashboard (recommended)

```bash
pip install -r sys_req/requirements.txt   # once
bash build.sh --release                   # build the engine
python3 dashboard/serve.py                # serves http://localhost:8080
```

Open the browser (it opens automatically), pick a trace and policy in the **Setup** wizard, and run. Use the
**Online** tab for the interactive/advisory workflow. Set a different port with
`CQSIM_PORT=8899 python3 dashboard/serve.py`.

### 2. Command line — offline run

Create `demo.json`:

```json
{
  "output_dir": "data/native_results/demo",
  "swf_path": "data/InputFiles/test.swf",
  "mode": "real",
  "drivers": [
    { "type": "wfp3", "tag": "demo_wfp3", "backfilling": true, "legacy_backfill_mode": 1, "window_size": 64 }
  ]
}
```

```bash
./build/cqtwin run demo.json
# -> data/native_results/demo/demo_wfp3/jobs.csv  (+ summary.csv)
```

### 3. Command line — online advisory run

Create `online.json`:

```json
{
  "workload": { "mode": "trace" },
  "swf_path": "data/InputFiles/test.swf",
  "mode": "real",
  "committed_policy": "wfp3",
  "output_dir": "data/native_results/online_demo",
  "tag": "online_demo",
  "pool": [
    { "type": "fcfs", "window_size": 64, "backfilling": true, "legacy_backfill_mode": 1 },
    { "type": "sjf",  "window_size": 64, "backfilling": true, "legacy_backfill_mode": 1 },
    { "type": "wfp3", "window_size": 64, "backfilling": true, "legacy_backfill_mode": 1 }
  ],
  "obs": { "include_advisory": true, "advisory_horizon_seconds": 86400, "advisory_interval": 10 }
}
```

```bash
./build/cqtwin online-run online.json
# -> jobs.csv (byte-identical to the offline WFP3 run) + advisory.csv
```

---

## CLI reference

```
cqtwin <config.json>                     run an offline experiment (default)
cqtwin run <config.json>                 run an offline experiment
cqtwin preview <config.json>             scenario preview (no full run)
cqtwin online-run <config.json>          headless online advisory run -> jobs.csv + advisory.csv
cqtwin online-serve <config.json> [--host 127.0.0.1] [--port 0]
                                         interactive NDJSON socket env (reset/step/...)
```

See [`docs/CQTwin_ONLINE_SIMULATION.md`](docs/CQTwin_ONLINE_SIMULATION.md) for the online config schema and
the socket protocol, and [`docs/DASHBOARD.md`](docs/DASHBOARD.md) for the dashboard, including the Online tab
and the interactive step-through session.

---

## Scheduling policies

Lower score = higher dispatch priority. `w`=wait, `t`=requested walltime, `n`=requested procs, `T`=total procs.

| Name | Idea | Name | Idea |
|------|------|------|------|
| `fcfs` / `lcfs` | first / last come | `wfp1`–`wfp3` | ALCF weighted fair-share (powers of `w/t`) |
| `sjf` / `ljf` | shortest / longest job (`t`) | `sww` | size-weighted wait |
| `srf` / `lrf` | smallest / largest req procs (`n`) | `fcsj` | FCFS×SJF blend |
| `scf` / `lcf` | smallest / largest core-hours (`t·n`) | `fat` | fair-share of large jobs |
| `bsld` | bounded slowdown | `unicep` | log-normalized urgency |
| `f1`–`f4` | fitted composite heuristics | | |

The full definitions are in [`docs/CQTwin_FORMULAS_AND_METRICS.md`](docs/CQTwin_FORMULAS_AND_METRICS.md).

---

## Testing

```bash
cmake --build build          # build engine + tests
cd build && ctest -j         # run the full GoogleTest suite (180+ cases)
```

The suite includes the simulator core, policies, backfilling, the JSON experiment runner, and the online
environment — including **bit-exact online-vs-offline equivalence**
(`tests/test_online_fidelity.cpp`, `tests/test_online_run.cpp`), fork future-visibility
(`tests/test_online_fork_visibility.cpp`), and deterministic parallel projections.

---

## Optional: Python reference engine

`tools/run_python_engine.py` can run the **legacy Python CQSim** engine as a scripting-only alternative, and
`--self-check` validates the C++ engine against it per-policy. This is an optional path used for validation
only; it requires a separate CQSim checkout (see [CQSim](https://github.com/SPEAR-IIT/CQSim)) reachable at
`../CQSim`. The C++ engine and dashboard do **not** depend on it.

---

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/DASHBOARD.md`](docs/DASHBOARD.md) | Dashboard usage: setup wizard, tabs, Online tab, interactive step-through session |
| [`docs/ONLINE_BRIDGE.md`](docs/ONLINE_BRIDGE.md) | How the dashboard bridges to the online engine — headless + interactive session, config + socket plumbing, endpoint reference |
| [`docs/CQTwin_ONLINE_SIMULATION.md`](docs/CQTwin_ONLINE_SIMULATION.md) | Online environment design, config schema, NDJSON socket protocol |
| [`docs/CQTwin_FORMULAS_AND_METRICS.md`](docs/CQTwin_FORMULAS_AND_METRICS.md) | Policy formulas and the metric definitions |
| [`docs/live-adapter.md`](docs/live-adapter.md) | Streaming (live) workload adapter contract |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | Reference online-mode experiment results |

---

## License

Released under the [MIT License](LICENSE) — © 2026 UIC Spear Group.
