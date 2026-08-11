# CQTwin Dashboard - Reference Log

## Quick Start
```bash
python dashboard/serve.py
# Opens http://localhost:8080
```

## UI Flow
```
SETUP -> RUNNING (live logs + progress) -> RESULTS (Overview / Per-System / Compare / Worklog)
```

## What's New
- Brand set to **CQTwin**.
- Expanded setup controls: run label, output mode, adaptation toggles, sampling knobs, debug level.
- Added setup-page configuration guide table describing every input setting.
- Added guarded **Clear All Results** action (double confirmation in UI).
- Added in-dashboard SWF recommendation pipeline (train + adjusted runtime generation).
- Local presets (`Save Preset`, `Load Preset`, `Reset`) via browser storage.
- Progress overlay now includes animated loader, progress bar, stage text, elapsed time, and live simulator logs.
- Deeper analytics in result payload:
  - wait percentiles (p90/p95/p99), wait std, wait Gini
  - throughput, utilization std, idle fraction
  - queue depth/size percentiles and peaks
  - wait percentile timeline over submission bins
  - utilization histogram
  - proc-size/runtime wait heatmap matrix
  - top waiting jobs table
  - generated textual insights
- Compare tab adds baseline-aware deltas and normalized radar chart.

## Architecture
```
dashboard/
  serve.py        # HTTP server + API + subprocess launcher
  preprocess.py   # .rst/.ult parsing and advanced metric generation
  recommend.py    # SWF runtime recommendation (numpy ridge + user p90 buffer)
  index.html      # CQTwin SPA shell
  css/style.css   # Visual system, motion, responsive layout
  js/
    app.js        # Shared state, run identity, metric definitions
    setup.js      # Wizard, presets, run polling/progress UI
    overview.js   # Insights + deep analysis charts/tables
    system.js     # Per-run selection and system diagnostics
    compare.js    # Multi-run comparison with radar
    worklog.js    # Enriched historical run table
```

## Backend API (serve.py)

| Method | Endpoint            | Description |
|--------|---------------------|-------------|
| GET    | `/api/files`        | List input files (+ grouped system metadata) |
| POST   | `/api/upload`       | Upload `.swf` to `data/InputFiles/` |
| POST   | `/api/run`          | Start simulation, returns `{run_id}` |
| GET    | `/api/status`       | Poll status + progress + stage + elapsed + logs |
| GET    | `/api/results/<id>` | Full result payload for completed run |
| GET    | `/api/load/<name>`  | Load/preprocess any historical output name |
| POST   | `/api/recommend`    | Train on SWF and generate adjusted recommended SWF |
| POST   | `/api/clear-results`| Delete all files under `data/Results/` and dashboard-derived summaries/timeseries |
| POST   | `/api/cancel`       | Cancel active subprocess |

## Result Payload Highlights
```json
{
  "summary": {
    "run_name": "aurora_norm__fifo_baseline_ab12cd",
    "system": "aurora",
    "variant": "norm",
    "scenario": "fifo baseline",
    "avg_wait": 40.4,
    "wait_p95": 0.0,
    "wait_gini": 0.998,
    "avg_queue_depth": 82.0,
    "throughput_jobs_per_day": 141.5
  },
  "wait_timeline": { "labels": [...], "p50": [...], "p90": [...], "p99": [...] },
  "utilization_distribution": { "labels": [...], "counts": [...] },
  "proc_wait_heatmap": { "column_labels": [...], "rows": [...] },
  "top_wait_jobs": [...],
  "insights": [...]
}
```

## Notes
- New runs default to `output_mode=new`, so outputs are preserved with a unique run suffix.
- `output_mode=overwrite` retains legacy behavior (`<trace_stem>.rst/.ult`).
- `serve.py` still uses temporary config files to avoid the known `cqsim.py` `debug_lvl` CLI bug.
