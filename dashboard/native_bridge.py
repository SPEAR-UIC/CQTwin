#!/usr/bin/env python3
"""Bridge helpers between the CQTwin dashboard and the C++ engine.

The dashboard runs the **C++ engine only** — by design. The legacy Python CQSim
engine is kept as a scripting-only alternative (see tools/run_python_engine.py,
the Python counterpart of `cqtwin run`); it is deliberately not exposed here so
end users always get the fast, validated native engine. Do not wire the Python
engine into this bridge — use the scripting tool for Python-engine runs.
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path


INT_MAX = 2_147_483_647


LEGACY_POLICY_MAP = {
    "w,+,2": "fcfs",
    "w": "fcfs",
    "t": "sjf",
    "-t": "ljf",
    "w/t": "wfp1",
    "(n*(w/(t if t>0 else 1))**3)": "wfp3",
    "weighted_wait2": "fcfs",
    "fifo_wait": "fcfs",
    "wait_time_ratio": "wfp1",
    "wfp_alcf": "wfp3",
}


SUPPORTED_POLICIES = {
    "fcfs",
    "fifo",
    "sjf",
    "ljf",
    "srf",
    "lrf",
    "scf",
    "lcf",
    "lcfs",
    "wfp",
    "wfp1",
    "wfp2",
    "wfp3",
    "sww",
    "fcsj",
    "fat",
    "unicep",
    "f1",
    "f2",
    "f3",
    "f4",
    "bsld",
}


def _norm_int(value, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _norm_float(value, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _first_csv_int(value, default: int) -> int:
    raw = str(value or "").strip()
    if not raw:
        return int(default)
    first = raw.split(",", 1)[0].strip()
    try:
        return int(first)
    except Exception:
        return int(default)


def _stem_for_trace(job_trace: str) -> str:
    return Path(str(job_trace or "")).stem


def _normalize_rel_dir(value: str, default: str) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        raw = default
    if raw.startswith("data/"):
        raw = raw[len("data/") :]
    parts = [part for part in raw.split("/") if part not in {"", ".", ".."}]
    if not parts:
        parts = [part for part in default.split("/") if part]
    return "/".join(parts) + "/"


def normalize_policy_name(value: str) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return "fcfs"
    mapped = LEGACY_POLICY_MAP.get(raw, raw)
    return mapped if mapped in SUPPORTED_POLICIES else "fcfs"


def native_run_paths(base_dir: Path, output_name: str) -> dict[str, Path]:
    native_root = base_dir / "data" / "native_results" / output_name
    run_dir = native_root / output_name
    return {
        "native_root": native_root,
        "run_dir": run_dir,
        "config_dir": base_dir / "data" / "engine_runs",
        "jobs_csv": run_dir / "jobs.csv",
        "performance_csv": run_dir / "performance.csv",
        "events_csv": run_dir / "events.csv",
        "legacy_sys_csv": run_dir / "legacy_sys.csv",
        "summary_csv": native_root / "summary.csv",
        "rst": base_dir / "data" / "Results" / f"{output_name}.rst",
        "ult": base_dir / "data" / "Results" / f"{output_name}.ult",
    }


def build_engine_config(base_dir: Path, run_id: str, output_name: str, params: dict) -> Path:
    paths = native_run_paths(base_dir, output_name)
    paths["config_dir"].mkdir(parents=True, exist_ok=True)

    job_trace = str(params["job_trace"]).strip()
    policy = normalize_policy_name(params.get("algorithm", "fcfs"))
    win_mode = _norm_int(params.get("win", 0), 0)
    window = max(1, _first_csv_int(params.get("win_para", ""), 1)) if win_mode == 1 else INT_MAX
    backfill_mode = _norm_int(params.get("backfill", 0), 0)
    backfill = backfill_mode > 0
    read_num = _norm_int(params.get("read_num", -1), -1)
    start_job_index = max(0, _norm_int(params.get("anchor", 0), 0))
    input_dir = _normalize_rel_dir(params.get("path_in", "InputFiles/"), "InputFiles/")

    cfg = {
        "output_dir": str(paths["native_root"].relative_to(base_dir)),
        "swf_path": f"data/{input_dir}{job_trace}",
        "max_submits": INT_MAX if read_num < 0 else max(0, read_num),
        "start_job_index": start_job_index,
        "legacy_start_time": _norm_float(params.get("start", 0), 0.0),
        "legacy_cluster_fraction": float(params.get("cluster_fraction", 1.0) or 1.0),
        "legacy_monitor_interval": _norm_int(params.get("monitor", 500), 500),
        "mode": "real",
        "drivers": [
            {
                "type": policy,
                "tag": output_name,
                "backfilling": backfill,
                "legacy_backfill_mode": backfill_mode,
                "window_size": window,
            }
        ],
    }

    node_count = params.get("node_count")
    procs_per_node = params.get("procs_per_node")
    if node_count and procs_per_node:
        total_procs = _norm_int(node_count, 0) * _norm_int(procs_per_node, 0)
        if total_procs > 0:
            cfg["total_procs"] = total_procs
            cfg["node_count"] = _norm_int(node_count, 0)
            cfg["procs_per_node"] = _norm_int(procs_per_node, 0)

    maint_path = base_dir / "data" / "Maintenance" / f"{_stem_for_trace(job_trace)}.mlog"
    if maint_path.exists():
        cfg["maintenance_csv"] = str(maint_path.relative_to(base_dir))
        cfg["maintenance_notice_hours"] = 48.0

    cfg_path = paths["config_dir"] / f"{output_name}__{run_id}.json"
    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    return cfg_path


def build_online_config(base_dir: Path, output_name: str, params: dict) -> Path:
    """Write the config for a headless `online-run` (CQTwin online-advisory run).

    Committed policy drives the run under a fixed action; the advisory pool is
    projected each interval. jobs.csv is written into the SAME native_results
    layout an offline run uses (output_dir=native_root, tag=output_name), so
    convert_native_run_to_legacy + preprocess_single_run handle it unchanged.
    advisory.csv lands next to jobs.csv in the run dir.
    """
    paths = native_run_paths(base_dir, output_name)
    paths["config_dir"].mkdir(parents=True, exist_ok=True)

    job_trace = str(params["job_trace"]).strip()
    input_dir = _normalize_rel_dir(params.get("path_in", "InputFiles/"), "InputFiles/")
    committed = normalize_policy_name(params.get("committed_policy", "fcfs"))
    backfill_mode = _norm_int(params.get("backfill", 1), 1)
    window = _norm_int(params.get("window_size", 64), 64)
    if window <= 0:
        window = 1
    horizon = int(round(float(params.get("horizon_hours", 24) or 24) * 3600.0))
    interval = max(1, _norm_int(params.get("interval", 10), 10))
    read_num = _norm_int(params.get("read_num", -1), -1)

    # Advisory pool: normalize, dedupe (preserve order), ensure committed present.
    pool_names: list[str] = []
    seen: set[str] = set()
    for p in params.get("advisory_pool", []) or []:
        name = normalize_policy_name(p)
        if name not in seen:
            seen.add(name)
            pool_names.append(name)
    if committed not in seen:
        pool_names.append(committed)
    pool = [{"type": name, "window_size": window, "backfilling": backfill_mode > 0,
             "legacy_backfill_mode": backfill_mode} for name in pool_names]

    cfg = {
        "workload": {"mode": "trace"},
        "swf_path": f"data/{input_dir}{job_trace}",
        "mode": "real",
        "committed_policy": committed,
        "output_dir": str(paths["native_root"].relative_to(base_dir)),
        "tag": output_name,
        "max_submits": INT_MAX if read_num < 0 else max(0, read_num),
        "pool": pool,
        "obs": {"include_advisory": True, "advisory_horizon_seconds": horizon,
                "advisory_interval": interval},
    }

    node_count = params.get("node_count")
    procs_per_node = params.get("procs_per_node")
    if node_count and procs_per_node:
        total_procs = _norm_int(node_count, 0) * _norm_int(procs_per_node, 0)
        if total_procs > 0:
            cfg["cluster"] = {"total_procs": total_procs}

    cfg_path = paths["config_dir"] / f"online_{output_name}.json"
    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    return cfg_path


def _read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _legacy_job_line(row: dict[str, str]) -> str:
    def fmt_time(key: str) -> str:
        return str(float(row.get(key, "0") or 0))

    return ";".join([
        row.get("job_id", "0"),
        row.get("req_proc", "0"),
        row.get("req_proc", "0"),
        fmt_time("req_time"),
        fmt_time("run"),
        fmt_time("wait"),
        fmt_time("submit"),
        fmt_time("start"),
        fmt_time("end"),
    ])


def _legacy_perf_line(row: dict[str, str]) -> str:
    return (
        f"0;CYCLE;{row.get('sim_time', '0')};"
        f"uti={row.get('utilization', '0')} "
        f"waitNum={row.get('queue_len', '0')} "
        f"waitSize={row.get('queue_size', row.get('queue_len', '0'))}"
    )


def _load_run_meta(base_dir: Path, output_name: str) -> dict:
    meta_path = base_dir / "data" / "Results" / f"{output_name}.meta.json"
    if not meta_path.exists():
        return {}
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(payload, dict):
        return {}
    params = payload.get("params")
    return params if isinstance(params, dict) else {}


def _infer_total_procs(base_dir: Path, params: dict, job_rows: list[dict[str, str]]) -> int:
    node_count = _norm_int(params.get("node_count"), 0)
    procs_per_node = _norm_int(params.get("procs_per_node"), 0)
    if node_count > 0 and procs_per_node > 0:
        return node_count * procs_per_node

    path_in = _normalize_rel_dir(params.get("path_in", "InputFiles/"), "InputFiles/")
    job_trace = str(params.get("job_trace", "")).strip()
    if job_trace:
        trace_path = base_dir / "data" / path_in / job_trace
        if trace_path.exists():
            try:
                with trace_path.open("r", encoding="utf-8") as fh:
                    for line in fh:
                        if not line.startswith(";"):
                            break
                        match = re.match(r";\s*MaxProcs\s*:\s*(\d+)", line)
                        if match:
                            return int(match.group(1))
            except Exception:
                pass

    max_seen = 1
    for row in job_rows:
        max_seen = max(max_seen, _norm_int(row.get("req_proc"), 0))
    return max_seen


def _build_legacy_ult(base_dir: Path, output_name: str, job_rows: list[dict[str, str]], event_rows: list[dict[str, str]]) -> str:
    params = _load_run_meta(base_dir, output_name)
    monitor = max(1, _norm_int(params.get("monitor", 500), 500))
    total_procs = max(1, _infer_total_procs(base_dir, params, job_rows))

    jobs = {}
    for row in job_rows:
        job_id = _norm_int(row.get("job_id"), -1)
        if job_id < 0:
            continue
        jobs[job_id] = {
            "req_proc": _norm_int(row.get("req_proc"), 0),
        }

    submitted: set[int] = set()
    started: set[int] = set()
    running: set[int] = set()
    pending_snapshot: tuple[str, float] | None = None
    lines: list[str] = []

    def snapshot_line(code: str, time_value: float) -> str:
        wait_ids = submitted - started
        running_procs = sum(jobs.get(job_id, {}).get("req_proc", 0) for job_id in running)
        wait_size = sum(jobs.get(job_id, {}).get("req_proc", 0) for job_id in wait_ids)
        util = float(running_procs) / float(total_procs) if total_procs > 0 else 0.0
        date_field = str(int(time_value))
        time_field = str(int(time_value)) if code == "Q" else str(float(time_value))
        return (
            f"{date_field};{code};{time_field};"
            f"uti={util} waitNum={len(wait_ids)} waitSize={wait_size}"
        )

    def emit_monitors(start_time: float, next_time: float | None):
        if next_time is None:
            return
        mark = int(start_time / monitor) * monitor
        while mark < next_time:
            if mark >= start_time:
                lines.append(snapshot_line("Q", mark))
            mark += monitor

    external_events = {"Submit": "S", "End": "E", "Resubmit": "S"}
    internal_events = {"Run", "Backfill", "SchedulingCycle"}

    for idx, row in enumerate(event_rows):
        event_type = str(row.get("event", "")).strip()
        sim_time = _norm_float(row.get("sim_time"), 0.0)
        job_id = _norm_int(row.get("id"), -1)

        if event_type == "Submit" or event_type == "Resubmit":
            if job_id >= 0:
                submitted.add(job_id)
            pending_snapshot = (external_events[event_type], sim_time)
        elif event_type == "Run" or event_type == "Backfill":
            if job_id >= 0:
                started.add(job_id)
                running.add(job_id)
        elif event_type == "End":
            if job_id >= 0:
                running.discard(job_id)
            pending_snapshot = (external_events[event_type], sim_time)

        next_row = event_rows[idx + 1] if idx + 1 < len(event_rows) else None
        next_type = str(next_row.get("event", "")).strip() if next_row else ""
        next_time = _norm_float(next_row.get("sim_time"), 0.0) if next_row else None

        if pending_snapshot is None:
            continue

        should_emit = (
            next_row is None
            or next_time != sim_time
            or next_type in external_events
            or next_type not in internal_events
        )
        if not should_emit:
            continue

        code, snap_time = pending_snapshot
        lines.append(snapshot_line(code, snap_time))
        emit_monitors(snap_time, next_time)
        pending_snapshot = None

    return "\n".join(lines) + ("\n" if lines else "")


def _build_legacy_ult_from_snapshots(snapshot_rows: list[dict[str, str]]) -> str:
    lines = []
    for row in snapshot_rows:
        time_value = _norm_float(row.get("time"), 0.0)
        event_code = str(row.get("event_code", "")).strip() or "Q"
        util = str(float(row.get("utilization", "0") or 0))
        wait_num = row.get("wait_num", "0")
        wait_size = row.get("wait_size", "0")
        time_field = str(int(time_value)) if event_code == "Q" else str(float(time_value))
        lines.append(
            f"{int(time_value)};{event_code};{time_field};"
            f"uti={util} waitNum={wait_num} waitSize={wait_size}"
        )
    return "\n".join(lines) + ("\n" if lines else "")


def convert_native_run_to_legacy(base_dir: Path, output_name: str) -> dict[str, Path]:
    paths = native_run_paths(base_dir, output_name)
    # Online-advisory runs write only jobs.csv (+ advisory.csv); the offline path
    # additionally writes performance/events/legacy_sys. Guard each optional input
    # so the shared conversion works for both — for online runs .ult ends up empty
    # (no committed util timeseries), which is a recorded omission.
    job_rows = _read_csv_rows(paths["jobs_csv"]) if paths["jobs_csv"].exists() else []
    perf_rows = _read_csv_rows(paths["performance_csv"]) if paths["performance_csv"].exists() else []
    event_rows = _read_csv_rows(paths["events_csv"]) if paths["events_csv"].exists() else []
    snapshot_rows = _read_csv_rows(paths["legacy_sys_csv"]) if paths["legacy_sys_csv"].exists() else []

    paths["rst"].parent.mkdir(parents=True, exist_ok=True)
    paths["rst"].write_text(
        "\n".join(_legacy_job_line(row) for row in job_rows) + ("\n" if job_rows else ""),
        encoding="utf-8",
    )
    ult_text = _build_legacy_ult_from_snapshots(snapshot_rows)
    if not ult_text:
        ult_text = _build_legacy_ult(base_dir, output_name, job_rows, event_rows)
    if not ult_text:
        ult_text = "\n".join(_legacy_perf_line(row) for row in perf_rows) + ("\n" if perf_rows else "")
    paths["ult"].write_text(ult_text, encoding="utf-8")

    return {"rst": paths["rst"], "ult": paths["ult"]}


def read_jobs_finished(performance_csv: Path) -> int | None:
    if not performance_csv.exists():
        return None

    last_row = None
    with performance_csv.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            last_row = row

    if not last_row:
        return 0

    try:
        return int(last_row.get("jobs_finished", 0))
    except Exception:
        return 0
