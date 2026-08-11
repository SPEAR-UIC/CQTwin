#!/usr/bin/env python3
"""CQTwin dashboard server - serves the web UI and runs simulations on demand."""

from __future__ import annotations

import http.server
import bisect
import csv
from collections import OrderedDict
import hashlib
import json
import math
import os
import re
import signal
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from datetime import datetime
from pathlib import Path

DASHBOARD_DIR = Path(os.environ.get("CQSIM_DASHBOARD_DIR", str(Path(__file__).resolve().parent))).resolve()
BASE_DIR = Path(os.environ.get("CQSIM_BASE_DIR", str(DASHBOARD_DIR.parent))).resolve()
RESULTS_DIR = BASE_DIR / "data" / "Results"
INPUT_DIR = BASE_DIR / "data" / "InputFiles"
MAINT_DIR = BASE_DIR / "data" / "Maintenance"
ENGINE_RUNS_DIR = BASE_DIR / "data" / "engine_runs"
NATIVE_RESULTS_DIR = BASE_DIR / "data" / "native_results"
CONFIG_DIR = BASE_DIR / "data" / "Config"
PRESET_DIR = Path(os.environ.get("CQSIM_PRESET_DIR", str(DASHBOARD_DIR / "preset"))).resolve()
DASH_DATA_DIR = Path(os.environ.get("CQSIM_DASH_DATA_DIR", str(DASHBOARD_DIR / "data"))).resolve()
WORKLOG_SWF_DIR = Path(os.environ.get("CQSIM_WORKLOG_SWF_DIR", str(DASH_DATA_DIR / "worklogs"))).resolve()
RECOMMENDATIONS_DIR = Path(os.environ.get("CQSIM_RECOMMENDATIONS_DIR", str(DASH_DATA_DIR / "recommendations"))).resolve()
TIMESERIES_DIR = DASH_DATA_DIR / "timeseries"
RUN_CACHE_DIR = DASH_DATA_DIR / "run_cache"
SCENARIO_RUNS_DIR = DASH_DATA_DIR / "scenario_runs"
SNAPSHOT_FORKS_DIR = DASH_DATA_DIR / "snapshot_forks"
# Legacy pre-rename location. Saved forks are migrated on first access so that
# existing forks and bookmarked fork ids survive the Operator Lab -> Snap Shot rename.
LEGACY_OPERATOR_FORKS_DIR = DASH_DATA_DIR / "operator_forks"
SUMMARY_JSON = DASH_DATA_DIR / "summary.json"
WORKLOG_JSON = DASH_DATA_DIR / "worklog.json"
PORT = int(os.environ.get("CQSIM_PORT", "8080"))
SERVICE_NAME = os.environ.get("CQSIM_SERVICE_NAME", "cqtwin-dashboard")
PROJECT_NAME = os.environ.get("CQSIM_PROJECT_NAME", "CQTwin")
ENGINE_MODE = os.environ.get("CQSIM_ENGINE_MODE", "cqtwin").strip().lower()

LEGACY_RUN_DEFAULTS = {
    "run_label": "",
    "output_mode": "new",
    "job_trace": "",
    "node_struc": "",
    "read_num": -1,
    "alg": "w,+,2",
    "algorithm": "fcfs",
    "alg_sign": "1,0,1",
    "backfill": 2,
    "win": 5,
    "win_para": "5,0,0",
    "bf_para": "",
    "ad_bf": 0,
    "ad_win": 0,
    "ad_alg": 0,
    "ad_win_para": "",
    "ad_bf_para": "ad_bf_para.set",
    "ad_alg_para": "",
    "start": 0,
    "anchor": 0,
    "start_date": "None",
    "cluster_fraction": 1.0,
    "monitor": 500,
    "read_input_freq": 1000,
    "log_freq": 1,
    "debug_lvl": 3,
    "pre_name": "CQSIM_",
    "output": "",
    "debug": "",
    "job_save": "",
    "node_save": "",
    "config_n": "config_n.set",
    "config_sys": "config_sys.set",
    "ext_fmt_j": ".csv",
    "ext_fmt_n": ".csv",
    "ext_fmt_j_c": ".con",
    "ext_fmt_n_c": ".con",
    "path_in": "InputFiles/",
    "path_out": "Results/",
    "path_fmt": "Fmt/",
    "path_debug": "Debug/",
    "ext_jr": ".rst",
    "ext_si": ".ult",
    "ext_ai": ".adp",
    "ext_debug": ".log",
    "node_count": None,
    "procs_per_node": None,
    "user_p90_buffer": 0.0,
    "rec_test_frac": 0.2,
    "rec_ridge_alpha": 8.0,
}

LEGACY_CONFIG_NAME_KEYS = [
    "pre_name",
    "output",
    "debug",
    "job_save",
    "node_save",
    "ext_fmt_j",
    "ext_fmt_n",
    "ext_fmt_j_c",
    "ext_fmt_n_c",
    "path_in",
    "path_out",
    "path_fmt",
    "path_debug",
    "ext_jr",
    "ext_si",
    "ext_ai",
    "ext_debug",
]

LEGACY_CONFIG_SYSTEM_KEYS = [
    "cluster_fraction",
    "start",
    "start_date",
    "anchor",
    "read_num",
    "debug_lvl",
    "alg",
    "alg_sign",
    "backfill",
    "bf_para",
    "win",
    "win_para",
    "ad_win",
    "ad_bf",
    "ad_alg",
    "ad_win_para",
    "ad_bf_para",
    "ad_alg_para",
    "config_n",
    "monitor",
    "log_freq",
    "read_input_freq",
    "job_trace",
    "node_struc",
]

# Import preprocess helpers (same package)
sys.path.insert(0, str(DASHBOARD_DIR))
import preprocess as pp
import native_bridge as nb

# --------------------------------------------------------------------------- #
# Thread-safe run state
# --------------------------------------------------------------------------- #
ACTIVE_RUNS: dict = {}
_runs_lock = threading.Lock()

# Interactive online sessions (human-in-the-loop stepping via `online-serve`).
# Each entry: {proc, sock, rfile, pool, committed, lock, cycle, touched}. Kept
# alive across HTTP requests so the operator can decide one cycle at a time.
ONLINE_SESSIONS: dict = {}
_online_sessions_lock = threading.Lock()
_ONLINE_SESSION_TTL = 1800   # reap sessions idle longer than 30 min
WORKLOG_ANALYSIS_CACHE: dict = {}
_historical_lock = threading.Lock()
_run_payload_lock = threading.Lock()
_run_compute_locks_lock = threading.Lock()
_run_warm_lock = threading.Lock()
RUN_PAYLOAD_CACHE: OrderedDict = OrderedDict()
MAX_RUN_PAYLOAD_CACHE_ENTRIES = 12
MAX_RUN_PAYLOAD_DISK_ENTRIES = 48
HISTORICAL_STALE_TTL_SEC = 2.0
_historical_stale_cache = {"checked_at": 0.0, "value": True}
_historical_payload_cache = {
    "summary_mtime_ns": -1,
    "worklog_mtime_ns": -1,
    "payload": {"summary": [], "worklog": []},
}
_run_compute_locks: dict[str, threading.Lock] = {}
_run_warm_inflight: set[str] = set()
RAW_JOB_CACHE: OrderedDict = OrderedDict()
MAX_RAW_JOB_CACHE_ENTRIES = 8

try:
    _preprocess_sig = str((DASHBOARD_DIR / "preprocess.py").stat().st_mtime_ns)
except Exception:
    _preprocess_sig = "0"


def _get_raw_name(file_name: str) -> str:
    """Strip extension (everything from first '.')."""
    idx = file_name.find(".")
    return file_name[:idx] if idx != -1 else file_name


def _slugify(value: str, max_len: int = 36) -> str:
    """Convert a user label into a filesystem-safe token."""
    if not value:
        return ""
    token = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return token[:max_len]


def _safe_output_stem(value: str) -> str:
    raw = os.path.basename(str(value or "").strip())
    if not raw:
        return ""
    raw = _get_raw_name(raw)
    return re.sub(r"[^A-Za-z0-9._-]", "_", raw)


def _safe_set_filename(value: str, default: str) -> str:
    base = os.path.basename(str(value or "").strip())
    if not base:
        base = default
    if not base.lower().endswith(".set"):
        base += ".set"
    return re.sub(r"[^A-Za-z0-9._-]", "_", base)


def _norm_int(value, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _norm_optional_int(value):
    try:
        if value is None or str(value).strip() == "":
            return None
        return int(value)
    except Exception:
        return None


def _norm_float(value, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _normalize_rel_dir(value: str, default: str) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        raw = default
    if raw.startswith("data/"):
        raw = raw[len("data/") :]
    pieces = [part for part in raw.split("/") if part not in {"", ".", ".."}]
    if not pieces:
        pieces = [part for part in default.split("/") if part]
    return "/".join(pieces) + "/"


def _resolve_input_trace_path(job_trace: str, path_in: str) -> Path:
    return BASE_DIR / "data" / _normalize_rel_dir(path_in, LEGACY_RUN_DEFAULTS["path_in"]) / job_trace


def _resolve_legacy_config_path(name: str) -> Path | None:
    raw = str(name or "").strip().replace("\\", "/")
    if not raw:
        return None

    candidate = Path(raw)
    candidates = []
    if candidate.is_absolute():
        candidates.append(candidate)
    else:
        candidates.extend([
            CONFIG_DIR / raw,
            BASE_DIR / raw,
            DASHBOARD_DIR / raw,
        ])

    for path in candidates:
        if path.exists() and path.is_file():
            return path
    return None


def _read_legacy_config_file(path: Path | None) -> dict[str, str]:
    if path is None or not path.exists():
        return {}

    data: dict[str, str] = {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line or line.startswith(";") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                data[key.strip()] = value.strip()
    except Exception:
        return {}
    return data


def _merge_legacy_config_values(
    params: dict,
    config_values: dict[str, str],
    string_keys: list[str],
    int_keys: list[str],
    float_keys: list[str],
):
    if not config_values:
        return

    string_key_set = set(string_keys)
    int_key_set = set(int_keys)
    float_key_set = set(float_keys)

    for key, value in config_values.items():
        if key in int_key_set:
            params[key] = _norm_int(value, params.get(key, 0))
        elif key in float_key_set:
            params[key] = _norm_float(value, params.get(key, 0.0))
        elif key == "node_count":
            params[key] = _norm_optional_int(value)
        elif key == "procs_per_node":
            params[key] = _norm_optional_int(value)
        elif key in string_key_set:
            params[key] = str(value).strip()


def _normalize_run_params(raw_params: dict | None) -> dict:
    body = raw_params if isinstance(raw_params, dict) else {}
    params = dict(LEGACY_RUN_DEFAULTS)

    string_keys = [
        "run_label", "output_mode", "job_trace", "node_struc", "alg", "algorithm", "alg_sign",
        "win_para", "bf_para", "ad_win_para", "ad_bf_para", "ad_alg_para", "start_date",
        "pre_name", "output", "debug", "job_save", "node_save", "config_n", "config_sys",
        "ext_fmt_j", "ext_fmt_n", "ext_fmt_j_c", "ext_fmt_n_c", "path_in", "path_out",
        "path_fmt", "path_debug", "ext_jr", "ext_si", "ext_ai", "ext_debug",
    ]
    int_keys = [
        "read_num", "backfill", "win", "ad_bf", "ad_win", "ad_alg",
        "start", "anchor", "monitor", "read_input_freq", "log_freq", "debug_lvl",
    ]
    float_keys = ["cluster_fraction", "user_p90_buffer", "rec_test_frac", "rec_ridge_alpha"]

    requested_config_sys = str(body.get("config_sys") or params.get("config_sys") or "").strip()
    sys_config_values = _read_legacy_config_file(_resolve_legacy_config_path(requested_config_sys))
    requested_config_n = str(
        body.get("config_n")
        or sys_config_values.get("config_n")
        or params.get("config_n")
        or ""
    ).strip()
    name_config_values = _read_legacy_config_file(_resolve_legacy_config_path(requested_config_n))

    _merge_legacy_config_values(params, sys_config_values, string_keys, int_keys, float_keys)
    _merge_legacy_config_values(params, name_config_values, string_keys, int_keys, float_keys)
    if requested_config_sys:
        params["config_sys"] = requested_config_sys
    if requested_config_n:
        params["config_n"] = requested_config_n

    for key in string_keys:
        if key in body and body[key] is not None:
            params[key] = str(body[key]).strip()
    for key in int_keys:
        if key in body:
            params[key] = _norm_int(body[key], params[key])
    for key in float_keys:
        if key in body:
            params[key] = _norm_float(body[key], params[key])

    params["node_count"] = _norm_optional_int(body.get("node_count"))
    params["procs_per_node"] = _norm_optional_int(body.get("procs_per_node"))

    params["output_mode"] = str(params.get("output_mode", "new") or "new").strip().lower()
    if params["output_mode"] not in {"new", "overwrite"}:
        params["output_mode"] = "new"

    params["job_trace"] = str(params.get("job_trace", "")).strip()
    params["node_struc"] = str(params.get("node_struc", "")).strip() or params["job_trace"]

    raw_alg = ""
    if body.get("alg") is not None:
        raw_alg = str(body.get("alg")).strip()
    elif body.get("algorithm") is not None:
        raw_alg = str(body.get("algorithm")).strip()
    elif params.get("alg"):
        raw_alg = str(params.get("alg")).strip()
    elif params.get("algorithm"):
        raw_alg = str(params.get("algorithm")).strip()
    if not raw_alg:
        raw_alg = LEGACY_RUN_DEFAULTS["alg"]
    params["alg"] = raw_alg
    params["algorithm"] = nb.normalize_policy_name(raw_alg)
    params["start_date"] = str(params.get("start_date", "")).strip() or "None"

    params["path_in"] = _normalize_rel_dir(params.get("path_in"), LEGACY_RUN_DEFAULTS["path_in"])
    params["path_out"] = _normalize_rel_dir(params.get("path_out"), LEGACY_RUN_DEFAULTS["path_out"])
    params["path_fmt"] = _normalize_rel_dir(params.get("path_fmt"), LEGACY_RUN_DEFAULTS["path_fmt"])
    params["path_debug"] = _normalize_rel_dir(params.get("path_debug"), LEGACY_RUN_DEFAULTS["path_debug"])

    base_name = _get_raw_name(params["job_trace"]) if params["job_trace"] else ""
    if not params["job_save"] and base_name:
        params["job_save"] = base_name
    if not params["node_save"] and base_name:
        params["node_save"] = f"{base_name}_node"
    if not params["output"] and base_name and params["output_mode"] == "overwrite":
        params["output"] = base_name
    if not params["debug"] and base_name:
        params["debug"] = f"debug_{base_name}"

    return params


def _config_variant_token(params: dict) -> str:
    """Build a short config token from scheduling policy + backfill."""
    try:
        policy = _slugify(pp.infer_policy_variant(params), max_len=24)
    except Exception:
        policy = ""
    if not policy:
        policy = "cfg"

    bf = ""
    try:
        if params.get("backfill") is not None:
            bf = f"bf{int(params.get('backfill'))}"
    except Exception:
        bf = ""

    return "_".join(x for x in [policy, bf] if x)


def _build_output_name(job_trace: str, params: dict, run_id: str) -> str:
    """Choose output stem for this run.

    Modes:
      - overwrite: output = job trace stem (legacy behavior)
      - new (default): output = "<stem>__<run_label_or_timestamp>"
    """
    base = _get_raw_name(job_trace)
    mode = str(params.get("output_mode", "new")).strip().lower()
    explicit = _safe_output_stem(params.get("output", ""))

    if explicit:
        candidate = explicit
        if mode != "overwrite":
            i = 2
            while (RESULTS_DIR / f"{candidate}.rst").exists() or (RESULTS_DIR / f"{candidate}.ult").exists():
                candidate = f"{explicit}_{i}"
                i += 1
        return candidate

    if mode == "overwrite":
        return base

    label = _slugify(str(params.get("run_label", "")).strip())
    stamp = datetime.now().strftime("%m%d_%H%M%S")
    cfg = _config_variant_token(params)
    suffix = "_".join(x for x in [cfg, label or stamp, run_id[-6:]] if x)
    candidate = f"{base}__{suffix}"

    # Avoid accidental clobber if the same label is used repeatedly
    i = 2
    while (RESULTS_DIR / f"{candidate}.rst").exists() or (RESULTS_DIR / f"{candidate}.ult").exists():
        candidate = f"{base}__{suffix}_{i}"
        i += 1
    return candidate


def _legacy_config_value(value) -> str:
    if value is None:
        return ""
    return str(value)


def _write_legacy_config_bundle(output_name: str, params: dict) -> dict[str, str]:
    config_root = CONFIG_DIR / output_name
    config_root.mkdir(parents=True, exist_ok=True)

    config_n_name = _safe_set_filename(params.get("config_n", ""), "config_n.set")
    config_sys_name = _safe_set_filename(params.get("config_sys", ""), "config_sys.set")

    name_lines = [f"{key}={_legacy_config_value(params.get(key, ''))}" for key in LEGACY_CONFIG_NAME_KEYS]
    system_lines = []
    for key in LEGACY_CONFIG_SYSTEM_KEYS:
        value = config_n_name if key == "config_n" else params.get(key, "")
        system_lines.append(f"{key}={_legacy_config_value(value)}")

    config_n_path = config_root / config_n_name
    config_sys_path = config_root / config_sys_name
    config_n_path.write_text("\n".join(name_lines) + "\n", encoding="utf-8")
    config_sys_path.write_text("\n".join(system_lines) + "\n", encoding="utf-8")

    return {
        "config_dir": str(config_root.relative_to(BASE_DIR)),
        "config_n": str(config_n_path.relative_to(BASE_DIR)),
        "config_sys": str(config_sys_path.relative_to(BASE_DIR)),
    }


def _write_run_meta(output_name: str, params: dict, legacy_config: dict | None = None):
    """Persist run config to Results/<run>.meta.json for later preprocessing."""
    meta_path = RESULTS_DIR / f"{output_name}.meta.json"
    payload = {
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "run_name": output_name,
        "variant": _config_variant_token(params),
        "alg": str(params.get("alg", "")),
        "algorithm": str(params.get("algorithm", "")),
        "legacy_config": legacy_config or {},
        "params": params,
    }
    meta_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _safe_preset_filename(name: str) -> str:
    """Normalize preset filename and force .json extension."""
    base = os.path.basename(str(name or "").strip())
    if not base:
        base = datetime.now().strftime("preset_%Y%m%d_%H%M%S.json")
    if not base.lower().endswith(".json"):
        base += ".json"
    return re.sub(r"[^A-Za-z0-9._-]", "_", base)


def _clear_directory(path: Path) -> tuple[int, list[str]]:
    """Delete all entries under a directory and return (deleted_count, errors)."""
    deleted = 0
    errors: list[str] = []
    if not path.exists():
        return deleted, errors

    for entry in path.iterdir():
        try:
            if entry.is_file() or entry.is_symlink():
                entry.unlink()
                deleted += 1
            elif entry.is_dir():
                shutil.rmtree(entry)
                deleted += 1
        except Exception as exc:
            errors.append(f"{entry.name}: {exc}")
    return deleted, errors


def _resolve_engine_binary() -> Path:
    override = str(os.environ.get("CQSIM_ENGINE_BIN", "")).strip()
    if override:
        candidate = Path(override)
        if not candidate.is_absolute():
            candidate = (BASE_DIR / candidate).resolve()
        if candidate.is_file():
            return candidate
    candidates = [
        BASE_DIR / "build" / "cqtwin",
        BASE_DIR / "cqtwin",
        BASE_DIR / "build" / "cqsimx",
        BASE_DIR / "cqsimx",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"{PROJECT_NAME} engine binary not found. Build it with `bash build.sh --release`."
    )


def _build_engine_command(engine_bin: Path, cfg_path: Path) -> list[str]:
    if ENGINE_MODE in {"cqsimx", "cqsimx-engine", "engine"}:
        return [
            str(engine_bin),
            "engine",
            str(cfg_path),
        ]
    return [
        str(engine_bin),
        str(cfg_path.relative_to(BASE_DIR)),
    ]


def _build_preview_command(engine_bin: Path, cfg_path: Path) -> list[str]:
    return [
        str(engine_bin),
        "preview",
        str(cfg_path),
    ]


def _raw_jobs_cache_get(run_name: str):
    rst_path = RESULTS_DIR / f"{run_name}.rst"
    if not rst_path.exists():
        raise FileNotFoundError(f"Result file not found for run `{run_name}`.")
    sig = rst_path.stat().st_mtime_ns
    cached = RAW_JOB_CACHE.get(run_name)
    if cached and cached.get("sig") == sig:
        RAW_JOB_CACHE.move_to_end(run_name)
        return cached.get("jobs") or []

    jobs = pp.parse_rst(str(rst_path))
    RAW_JOB_CACHE[run_name] = {"sig": sig, "jobs": jobs}
    RAW_JOB_CACHE.move_to_end(run_name)
    while len(RAW_JOB_CACHE) > MAX_RAW_JOB_CACHE_ENTRIES:
        RAW_JOB_CACHE.popitem(last=False)
    return jobs


def _resolve_preview_job_trace(output_name: str, params: dict) -> str:
    raw = str((params or {}).get("job_trace", "")).strip()
    if raw:
        return raw
    ident = pp.parse_run_identity(output_name, params or {})
    base = str(ident.get("base_name", "")).strip()
    if base:
        return f"{base}.swf"
    raise ValueError(f"Cannot infer job trace for run `{output_name}`.")


def _resolve_preview_window(params: dict, explicit: int | None = None) -> int:
    if explicit is not None:
        return max(1, int(explicit))
    try:
        win_mode = int((params or {}).get("win", 0))
    except Exception:
        win_mode = 0
    if win_mode == 1:
        return max(1, nb._first_csv_int((params or {}).get("win_para", ""), 1))
    return nb.INT_MAX


def _read_trace_max_procs(job_trace: str, path_in: str) -> int:
    trace_path = _resolve_input_trace_path(job_trace, path_in)
    if not trace_path.exists():
        return 0
    try:
        with trace_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.startswith(";"):
                    break
                match = re.match(r";\s*MaxProcs\s*:\s*(\d+)", line)
                if match:
                    return int(match.group(1))
    except Exception:
        return 0
    return 0


def _infer_total_procs_for_preview(job_trace: str, path_in: str, params: dict, jobs: list[dict]) -> int:
    node_count = _norm_optional_int((params or {}).get("node_count"))
    procs_per_node = _norm_optional_int((params or {}).get("procs_per_node"))
    if node_count and procs_per_node and node_count > 0 and procs_per_node > 0:
        return node_count * procs_per_node

    header_val = _read_trace_max_procs(job_trace, path_in)
    if header_val > 0:
        return header_val

    max_seen = 1
    for row in jobs:
        try:
            max_seen = max(max_seen, int(float(row.get("reqProc", 0))))
        except Exception:
            continue
    return max_seen


def _build_snapshot_preview_config(output_name: str,
                                   params: dict,
                                   jobs: list[dict],
                                   body: dict) -> tuple[Path, Path]:
    SCENARIO_RUNS_DIR.mkdir(parents=True, exist_ok=True)

    snapshot_time = _norm_float(body.get("snapshot_time", 0), 0.0)
    horizon_hours = max(1.0, _norm_float(body.get("horizon_hours", 24), 24.0))
    downtime_hours = max(0.5, _norm_float(body.get("downtime_hours", 4), 4.0))
    advisor_span_hours = max(horizon_hours, _norm_float(body.get("advisor_span_hours", 168), 168.0))
    advisor_step_hours = max(0.5, _norm_float(body.get("advisor_step_hours", 6), 6.0))
    force_job_id = _norm_int(body.get("force_job_id", -1), -1)
    selected_job_id = _norm_int(body.get("selected_job_id", force_job_id), force_job_id)
    proposed_downtime_offset_raw = body.get("planned_downtime_offset_hours", "")
    proposed_downtime_offset_hours = None
    if proposed_downtime_offset_raw is not None and str(proposed_downtime_offset_raw).strip() != "":
        proposed_downtime_offset_hours = max(0.0, _norm_float(proposed_downtime_offset_raw, 0.0))
    proposed_downtime_notice_hours = max(0.0, _norm_float(body.get("planned_downtime_notice_hours", 48), 48.0))
    preview_policy = nb.normalize_policy_name(body.get("preview_policy") or (params or {}).get("algorithm") or (params or {}).get("alg") or "fcfs")
    baseline_policy = nb.normalize_policy_name((params or {}).get("algorithm") or (params or {}).get("alg") or "fcfs")

    preview_backfill_mode = _norm_int(body.get("preview_backfill_mode", (params or {}).get("backfill", 2)), _norm_int((params or {}).get("backfill", 2), 2))
    baseline_backfill_mode = _norm_int((params or {}).get("backfill", 2), 2)
    baseline_window = _resolve_preview_window(params)
    preview_window = _resolve_preview_window(params, _norm_optional_int(body.get("preview_window_size")))
    read_num = _norm_int((params or {}).get("read_num", -1), -1)
    anchor = max(0, _norm_int((params or {}).get("anchor", 0), 0))
    job_trace = _resolve_preview_job_trace(output_name, params)
    path_in = _normalize_rel_dir((params or {}).get("path_in", "InputFiles/"), LEGACY_RUN_DEFAULTS["path_in"])
    total_procs = _infer_total_procs_for_preview(job_trace, path_in, params, jobs)

    token = hashlib.sha1(json.dumps({
        "run": output_name,
        "snapshot_time": snapshot_time,
        "preview_policy": preview_policy,
        "force_job_id": force_job_id,
        "selected_job_id": selected_job_id,
        "preview_backfill_mode": preview_backfill_mode,
        "preview_window": preview_window,
        "horizon_hours": horizon_hours,
        "downtime_hours": downtime_hours,
        "planned_downtime_offset_hours": proposed_downtime_offset_hours,
        "planned_downtime_notice_hours": proposed_downtime_notice_hours,
        "advisor_span_hours": advisor_span_hours,
        "advisor_step_hours": advisor_step_hours,
    }, sort_keys=True).encode("utf-8")).hexdigest()[:16]

    output_json = SCENARIO_RUNS_DIR / f"{output_name}__{token}.json"
    cfg_path = SCENARIO_RUNS_DIR / f"{output_name}__{token}.preview.json"

    cfg = {
        "swf_path": f"data/{path_in}{job_trace}",
        "output_json": str(output_json),
        "baseline_policy": baseline_policy,
        "preview_policy": preview_policy,
        "mode": "real",
        "total_procs": total_procs,
        "max_submits": nb.INT_MAX if read_num < 0 else max(0, read_num),
        "start_job_index": anchor,
        "legacy_start_time": _norm_float((params or {}).get("start", 0), 0.0),
        "legacy_cluster_fraction": _norm_float((params or {}).get("cluster_fraction", 1.0), 1.0),
        "baseline_window_size": baseline_window,
        "preview_window_size": preview_window,
        "baseline_backfill_mode": baseline_backfill_mode,
        "preview_backfill_mode": preview_backfill_mode,
        "snapshot_time": snapshot_time,
        "horizon_seconds": horizon_hours * 3600.0,
        "downtime_duration": downtime_hours * 3600.0,
        "advisor_span_seconds": advisor_span_hours * 3600.0,
        "advisor_step_seconds": advisor_step_hours * 3600.0,
        "force_job_id": force_job_id,
        "selected_job_id": selected_job_id,
        "proposed_downtime_offset_seconds": -1 if proposed_downtime_offset_hours is None else proposed_downtime_offset_hours * 3600.0,
        "proposed_downtime_duration_seconds": downtime_hours * 3600.0,
        "proposed_downtime_notice_hours": proposed_downtime_notice_hours,
    }

    maint_path = BASE_DIR / "data" / "Maintenance" / f"{Path(job_trace).stem}.mlog"
    if maint_path.exists():
        cfg["maintenance_csv"] = str(maint_path.relative_to(BASE_DIR))
        cfg["maintenance_notice_hours"] = 48.0

    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    return cfg_path, output_json


def _ensure_snapshot_forks_dir() -> Path:
    SNAPSHOT_FORKS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if LEGACY_OPERATOR_FORKS_DIR.exists():
            for legacy in LEGACY_OPERATOR_FORKS_DIR.glob("*.json"):
                target = SNAPSHOT_FORKS_DIR / legacy.name
                if not target.exists():
                    legacy.replace(target)
    except Exception:
        pass
    return SNAPSHOT_FORKS_DIR


def _safe_snapshot_fork_id(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_-]", "", str(value or "").strip())
    if not token:
        raise ValueError("Invalid fork id.")
    return token


def _snapshot_fork_record_path(fork_id: str) -> Path:
    _ensure_snapshot_forks_dir()
    return SNAPSHOT_FORKS_DIR / f"{_safe_snapshot_fork_id(fork_id)}.json"


def _snapshot_fork_summary(record: dict, path: Path | None = None) -> dict:
    request = record.get("request") if isinstance(record.get("request"), dict) else {}
    result = record.get("result") if isinstance(record.get("result"), dict) else {}
    impact = result.get("impact_summary") if isinstance(result.get("impact_summary"), dict) else {}
    summary = {
        "id": record.get("id") or (path.stem if path else ""),
        "name": record.get("name") or "",
        "created_at": record.get("created_at") or "",
        "run_name": record.get("run_name") or request.get("run_name") or result.get("run_name") or "",
        "selected_job_id": record.get("selected_job_id"),
        "preview_policy": request.get("preview_policy") or (result.get("meta") or {}).get("preview_policy") or "",
        "snapshot_time": request.get("snapshot_time"),
        "horizon_hours": request.get("horizon_hours"),
        "has_force_job": bool(request.get("force_job_id", -1) not in {"", None, -1}),
        "queued_jobs": impact.get("queued_jobs", 0),
    }
    return summary


def _list_snapshot_forks(limit: int = 120) -> list[dict]:
    _ensure_snapshot_forks_dir()
    rows: list[dict] = []
    for path in sorted(SNAPSHOT_FORKS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            rows.append(_snapshot_fork_summary(record, path))
        except Exception:
            continue
        if len(rows) >= limit:
            break
    return rows


def _result_run_name_from_path(path: Path) -> str:
    name = path.name
    if name.endswith(".meta.json"):
        return name[: -len(".meta.json")]
    return path.stem


def _collect_result_run_file_map() -> dict[str, list[Path]]:
    run_to_files: dict[str, list[Path]] = {}
    if not RESULTS_DIR.exists():
        return run_to_files

    for entry in RESULTS_DIR.iterdir():
        if not entry.is_file() or entry.name.startswith("."):
            continue
        run_name = _result_run_name_from_path(entry)
        run_to_files.setdefault(run_name, []).append(entry)
    return run_to_files


def _find_matching_result_runs(keyword: str):
    """Return matching run names and run->files map for a case-insensitive keyword."""
    key = str(keyword or "").strip().lower()
    run_to_files = _collect_result_run_file_map()
    if not key:
        return [], run_to_files
    matched_runs = sorted(r for r in run_to_files if key in r.lower())
    return matched_runs, run_to_files


def _delete_matching_results(keyword: str):
    """Delete result artifacts for runs whose output name contains keyword (case-insensitive)."""
    if not str(keyword or "").strip():
        return {
            "matched_runs": [],
            "deleted_result_files": 0,
            "deleted_timeseries_files": 0,
            "deleted_run_cache_files": 0,
            "removed_summary_rows": 0,
            "removed_worklog_rows": 0,
            "removed_active_runs": 0,
            "errors": ["keyword is empty"],
        }

    matched_runs, run_to_files = _find_matching_result_runs(keyword)
    if not matched_runs:
        return {
            "matched_runs": [],
            "deleted_result_files": 0,
            "deleted_timeseries_files": 0,
            "deleted_run_cache_files": 0,
            "removed_summary_rows": 0,
            "removed_worklog_rows": 0,
            "removed_active_runs": 0,
            "errors": [],
        }

    matched_set = set(matched_runs)
    errors: list[str] = []
    deleted_result_files = 0
    deleted_timeseries_files = 0
    deleted_run_cache_files = 0
    removed_summary_rows = 0
    removed_worklog_rows = 0
    removed_active_runs = 0

    for run_name in matched_runs:
        for file_path in run_to_files.get(run_name, []):
            try:
                file_path.unlink(missing_ok=True)
                deleted_result_files += 1
            except Exception as exc:
                errors.append(f"result:{file_path.name}: {exc}")

        native_dir = NATIVE_RESULTS_DIR / run_name
        try:
            if native_dir.exists():
                shutil.rmtree(native_dir)
                deleted_result_files += 1
        except Exception as exc:
            errors.append(f"native:{native_dir.name}: {exc}")

        for cfg_path in ENGINE_RUNS_DIR.glob(f"{run_name}__*.json"):
            try:
                cfg_path.unlink(missing_ok=True)
                deleted_result_files += 1
            except Exception as exc:
                errors.append(f"engine-config:{cfg_path.name}: {exc}")

        for suffix in (".json", "_scatter.json"):
            ts_path = TIMESERIES_DIR / f"{run_name}{suffix}"
            try:
                if ts_path.exists():
                    ts_path.unlink()
                    deleted_timeseries_files += 1
            except Exception as exc:
                errors.append(f"timeseries:{ts_path.name}: {exc}")

    for cache_file in RUN_CACHE_DIR.glob("*.json"):
        try:
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
            run_name = str((((payload or {}).get("payload") or {}).get("summary") or {}).get("run_name") or "")
            if run_name in matched_set:
                cache_file.unlink(missing_ok=True)
                deleted_run_cache_files += 1
        except Exception:
            # Cache entry may be stale/corrupt; ignore and keep going.
            continue

    with _run_payload_lock:
        for run_name in matched_runs:
            RUN_PAYLOAD_CACHE.pop(run_name, None)

    with _run_compute_locks_lock:
        for run_name in matched_runs:
            _run_compute_locks.pop(run_name, None)

    with _run_warm_lock:
        for run_name in matched_runs:
            _run_warm_inflight.discard(run_name)

    with _runs_lock:
        rm_ids = [
            rid for rid, rec in ACTIVE_RUNS.items()
            if str(rec.get("output_name") or "") in matched_set
            or str(rec.get("result", {}).get("summary", {}).get("run_name") or "") in matched_set
        ]
        for rid in rm_ids:
            ACTIVE_RUNS.pop(rid, None)
        removed_active_runs = len(rm_ids)

    with _historical_lock:
        summary = _load_json_file(SUMMARY_JSON, [])
        worklog = _load_json_file(WORKLOG_JSON, [])

        if isinstance(summary, list):
            summary_new = [
                row for row in summary
                if str((row or {}).get("run_name") or "") not in matched_set
            ]
            removed_summary_rows = len(summary) - len(summary_new)
            try:
                _write_json_atomic(SUMMARY_JSON, summary_new)
            except Exception as exc:
                errors.append(f"summary.json: {exc}")
        else:
            summary_new = []

        if isinstance(worklog, list):
            worklog_new = [
                row for row in worklog
                if str((row or {}).get("run_name") or "") not in matched_set
            ]
            removed_worklog_rows = len(worklog) - len(worklog_new)
            try:
                _write_json_atomic(WORKLOG_JSON, worklog_new)
            except Exception as exc:
                errors.append(f"worklog.json: {exc}")
        else:
            worklog_new = []

        _historical_payload_cache["summary_mtime_ns"] = SUMMARY_JSON.stat().st_mtime_ns if SUMMARY_JSON.exists() else -1
        _historical_payload_cache["worklog_mtime_ns"] = WORKLOG_JSON.stat().st_mtime_ns if WORKLOG_JSON.exists() else -1
        _historical_payload_cache["payload"] = {
            "summary": summary_new,
            "worklog": worklog_new,
        }
        _historical_stale_cache["checked_at"] = 0.0
        _historical_stale_cache["value"] = False

    return {
        "matched_runs": matched_runs,
        "deleted_result_files": deleted_result_files,
        "deleted_timeseries_files": deleted_timeseries_files,
        "deleted_run_cache_files": deleted_run_cache_files,
        "removed_summary_rows": removed_summary_rows,
        "removed_worklog_rows": removed_worklog_rows,
        "removed_active_runs": removed_active_runs,
        "errors": errors,
    }


def _safe_float_token(token: str, default: float = -1.0) -> float:
    try:
        return float(token)
    except Exception:
        return default


def _safe_int_text(text: str, default: int = 0) -> int:
    try:
        raw = str(text).strip()
        if raw == "":
            return default
        try:
            return int(raw)
        except Exception:
            return int(float(raw))
    except Exception:
        return default


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(sum(values) / len(values))


def _percentile(values: list[float], pct: float) -> float:
    """Linear-interpolated percentile for a list of numeric values."""
    if not values:
        return 0.0
    if pct <= 0:
        return float(min(values))
    if pct >= 100:
        return float(max(values))

    arr = sorted(float(v) for v in values)
    k = (len(arr) - 1) * (pct / 100.0)
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return arr[lo]
    frac = k - lo
    return arr[lo] * (1.0 - frac) + arr[hi] * frac


def _percentile_sorted(arr: list[float], pct: float) -> float:
    """Linear-interpolated percentile for an already-sorted numeric list."""
    if not arr:
        return 0.0
    if pct <= 0:
        return float(arr[0])
    if pct >= 100:
        return float(arr[-1])

    k = (len(arr) - 1) * (pct / 100.0)
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return float(arr[lo])
    frac = k - lo
    return float(arr[lo] * (1.0 - frac) + arr[hi] * frac)


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mu = _mean(values)
    var = sum((v - mu) ** 2 for v in values) / len(values)
    return float(math.sqrt(max(var, 0.0)))


def _fmt_time_short(seconds: float) -> str:
    s = max(float(seconds), 0.0)
    if s < 60:
        return f"{int(round(s))}s"
    if s < 3600:
        return f"{s / 60.0:.1f}m"
    if s < 86400:
        return f"{s / 3600.0:.1f}h"
    return f"{s / 86400.0:.1f}d"


def _fmt_count_short(value: float) -> str:
    v = float(value)
    if v >= 1_000_000:
        return f"{v / 1_000_000:.1f}M"
    if v >= 1_000:
        return f"{v / 1_000:.1f}K"
    return str(int(round(v)))


def _build_histogram(values: list[float], edges: list[float]) -> list[int]:
    if len(edges) < 2:
        return []
    counts = [0] * (len(edges) - 1)
    for v in values:
        if not math.isfinite(v):
            continue
        idx = bisect.bisect_right(edges, v) - 1
        if idx < 0:
            continue
        if idx >= len(counts):
            idx = len(counts) - 1
        counts[idx] += 1
    return counts


def _labels_from_edges(edges: list[float], *, is_time: bool) -> list[str]:
    labels = []
    for i in range(len(edges) - 1):
        lo = edges[i]
        hi = edges[i + 1]
        if is_time:
            lo_txt = _fmt_time_short(lo)
            hi_txt = _fmt_time_short(hi)
        else:
            lo_txt = _fmt_count_short(lo)
            hi_txt = _fmt_count_short(hi)

        if i == len(edges) - 2:
            labels.append(f"{lo_txt}+")
        else:
            labels.append(f"{lo_txt}-{hi_txt}")
    return labels


def _build_submit_timeline(submits: list[float], waits: list[float], runs: list[float]) -> dict:
    """Build chart-ready submit-time timeline on relative time axis."""
    n = len(submits)
    if n == 0:
        return {
            "labels": [],
            "time": [],
            "job_count": [],
            "jobs_per_day": [],
            "avg_wait": [],
            "avg_runtime": [],
            "span_seconds": 0.0,
        }

    submit_min = min(submits)
    submit_max = max(submits)
    span = max(submit_max - submit_min, 0.0)
    if span <= 0:
        return {
            "labels": ["0s"],
            "time": [0.0],
            "job_count": [n],
            "jobs_per_day": [float(n)],
            "avg_wait": [round(_mean(waits), 3)],
            "avg_runtime": [round(_mean(runs), 3)],
            "span_seconds": 0.0,
        }

    bin_count = min(48, max(12, int(math.sqrt(n) // 2)))
    width = span / bin_count
    counts = [0] * bin_count
    sum_wait = [0.0] * bin_count
    sum_run = [0.0] * bin_count

    for i in range(n):
        idx = min(bin_count - 1, int((submits[i] - submit_min) / width))
        counts[idx] += 1
        sum_wait[idx] += waits[i]
        sum_run[idx] += runs[i]

    centers = [width * (i + 0.5) for i in range(bin_count)]
    labels = [_fmt_time_short(t) for t in centers]
    avg_wait = [round(sum_wait[i] / counts[i], 3) if counts[i] else 0.0 for i in range(bin_count)]
    avg_run = [round(sum_run[i] / counts[i], 3) if counts[i] else 0.0 for i in range(bin_count)]
    jobs_per_day = [round((counts[i] / width) * 86400.0, 3) if width > 0 else 0.0 for i in range(bin_count)]

    return {
        "labels": labels,
        "time": centers,
        "job_count": counts,
        "jobs_per_day": jobs_per_day,
        "avg_wait": avg_wait,
        "avg_runtime": avg_run,
        "span_seconds": round(span, 3),
    }


def _labels_from_ratio_edges(edges: list[float]) -> list[str]:
    labels = []
    for i in range(len(edges) - 1):
        lo = edges[i]
        hi = edges[i + 1]

        def _fmt(v: float) -> str:
            if v < 10:
                return f"{v:.2f}x"
            if v < 100:
                return f"{v:.1f}x"
            return f"{int(round(v))}x"

        if i == len(edges) - 2:
            labels.append(f"{_fmt(lo)}+")
        else:
            labels.append(f"{_fmt(lo)}-{_fmt(hi)}")
    return labels


def _build_pressure_timeline(
    submits: list[float],
    starts: list[float],
    ends: list[float],
    req_procs: list[float],
    max_procs: int,
) -> dict:
    """Estimate queue/running pressure on the submit-time axis."""
    n = len(submits)
    if n == 0:
        return {
            "labels": [],
            "time": [],
            "queue_depth": [],
            "running_depth": [],
            "queue_procs": [],
            "running_procs": [],
            "queue_share": [],
            "running_share": [],
            "span_seconds": 0.0,
        }

    t0 = min(submits)
    t1 = max(max(submits), max(ends))
    span = max(t1 - t0, 0.0)
    if span <= 0:
        sample_abs = [t0]
        sample_rel = [0.0]
    else:
        bin_count = min(96, max(24, int(math.sqrt(n))))
        width = span / bin_count
        sample_abs = [t0 + width * (i + 0.5) for i in range(bin_count)]
        sample_rel = [x - t0 for x in sample_abs]

    submits_sorted = sorted(submits)
    starts_sorted = sorted(starts)
    ends_sorted = sorted(ends)

    def _build_prefix(times: list[float], weights: list[float]) -> tuple[list[float], list[float]]:
        pairs = sorted(zip(times, weights), key=lambda x: x[0])
        out_t = [p[0] for p in pairs]
        prefix = []
        running = 0.0
        for _, w in pairs:
            running += w
            prefix.append(running)
        return out_t, prefix

    def _prefix_at(times: list[float], prefix: list[float], t: float) -> float:
        idx = bisect.bisect_right(times, t) - 1
        if idx < 0:
            return 0.0
        return prefix[idx]

    sub_w_t, sub_w_ps = _build_prefix(submits, req_procs)
    st_w_t, st_w_ps = _build_prefix(starts, req_procs)
    end_w_t, end_w_ps = _build_prefix(ends, req_procs)

    q_depth = []
    r_depth = []
    q_procs = []
    r_procs = []
    q_share = []
    r_share = []

    for t in sample_abs:
        submitted = bisect.bisect_right(submits_sorted, t)
        started = bisect.bisect_right(starts_sorted, t)
        ended = bisect.bisect_right(ends_sorted, t)

        qd = max(0, submitted - started)
        rd = max(0, started - ended)

        subp = _prefix_at(sub_w_t, sub_w_ps, t)
        stp = _prefix_at(st_w_t, st_w_ps, t)
        endp = _prefix_at(end_w_t, end_w_ps, t)
        qp = max(0.0, subp - stp)
        rp = max(0.0, stp - endp)

        q_depth.append(qd)
        r_depth.append(rd)
        q_procs.append(qp)
        r_procs.append(rp)
        if max_procs > 0:
            q_share.append(qp / max_procs)
            r_share.append(rp / max_procs)
        else:
            q_share.append(0.0)
            r_share.append(0.0)

    return {
        "labels": [_fmt_time_short(t) for t in sample_rel],
        "time": [round(t, 3) for t in sample_rel],
        "queue_depth": q_depth,
        "running_depth": r_depth,
        "queue_procs": [round(v, 3) for v in q_procs],
        "running_procs": [round(v, 3) for v in r_procs],
        "queue_share": [round(v, 4) for v in q_share],
        "running_share": [round(v, 4) for v in r_share],
        "span_seconds": round(span, 3),
    }


def _build_wait_heatmap(req_procs: list[float], waits: list[float]) -> dict:
    """Build a req-proc x wait-time heatmap (count + avg wait per cell)."""
    if not req_procs or not waits:
        return {
            "x_labels": [],
            "y_labels": [],
            "counts": [],
            "avg_wait": [],
            "max_count": 0,
            "max_avg_wait": 0.0,
            "total_jobs": 0,
        }

    max_req = max(req_procs)
    max_wait = max(waits)

    req_edges = [0, 1, 8, 32, 128, 512, 2048, 8192, 32768, 131072]
    while max_req > req_edges[-1] and len(req_edges) < 14:
        req_edges.append(req_edges[-1] * 2)

    wait_edges = [0, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 172800, 604800]
    while max_wait > wait_edges[-1] and len(wait_edges) < 18:
        wait_edges.append(wait_edges[-1] * 2)

    rows = len(req_edges) - 1
    cols = len(wait_edges) - 1
    counts = [[0 for _ in range(cols)] for _ in range(rows)]
    sum_wait = [[0.0 for _ in range(cols)] for _ in range(rows)]

    for rp, w in zip(req_procs, waits):
        r_idx = bisect.bisect_right(req_edges, rp) - 1
        c_idx = bisect.bisect_right(wait_edges, w) - 1
        if r_idx < 0:
            r_idx = 0
        elif r_idx >= rows:
            r_idx = rows - 1
        if c_idx < 0:
            c_idx = 0
        elif c_idx >= cols:
            c_idx = cols - 1
        counts[r_idx][c_idx] += 1
        sum_wait[r_idx][c_idx] += w

    avg_wait = []
    max_count = 0
    max_avg = 0.0
    for r in range(rows):
        row = []
        for c in range(cols):
            ct = counts[r][c]
            max_count = max(max_count, ct)
            if ct > 0:
                v = sum_wait[r][c] / ct
                max_avg = max(max_avg, v)
                row.append(round(v, 3))
            else:
                row.append(0.0)
        avg_wait.append(row)

    return {
        "x_labels": _labels_from_edges(wait_edges, is_time=True),
        "y_labels": _labels_from_edges(req_edges, is_time=False),
        "counts": counts,
        "avg_wait": avg_wait,
        "max_count": int(max_count),
        "max_avg_wait": round(max_avg, 3),
        "total_jobs": len(req_procs),
    }


def _build_wait_by_runtime_class(runs: list[float], waits: list[float]) -> dict:
    buckets = [
        ("Short (<4h)", 0.0, 4.0 * 3600.0),
        ("Medium (4h-24h)", 4.0 * 3600.0, 24.0 * 3600.0),
        ("Long (>24h)", 24.0 * 3600.0, float("inf")),
    ]

    groups = [[] for _ in buckets]
    for run, wait in zip(runs, waits):
        for idx, (_, lo, hi) in enumerate(buckets):
            if lo <= run < hi:
                groups[idx].append(wait)
                break

    labels = []
    counts = []
    avg_wait = []
    p90_wait = []
    p95_wait = []
    for idx, (label, _, _) in enumerate(buckets):
        arr = groups[idx]
        arr_sorted = sorted(arr)
        labels.append(label)
        counts.append(len(arr))
        avg_wait.append(round(_mean(arr), 3))
        p90_wait.append(round(_percentile_sorted(arr_sorted, 90), 3))
        p95_wait.append(round(_percentile_sorted(arr_sorted, 95), 3))

    return {
        "labels": labels,
        "counts": counts,
        "avg_wait": avg_wait,
        "p90_wait": p90_wait,
        "p95_wait": p95_wait,
    }


def _analyze_worklog_swf(path: Path) -> dict:
    """Analyze an SWF workload log and return summary + chart-ready series."""
    header = {
        "computer": "",
        "max_nodes": 0,
        "max_procs": 0,
    }

    submits: list[float] = []
    waits: list[float] = []
    runs: list[float] = []
    req_procs: list[float] = []
    req_times: list[float] = []
    users = set()
    groups = set()
    user_stats = {}
    total_rows = 0
    skipped_rows = 0
    fallback_req_proc_rows = 0
    fallback_req_time_rows = 0

    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            if line.startswith(";"):
                body = line[1:].strip()
                if ":" in body:
                    key, value = body.split(":", 1)
                    key_norm = re.sub(r"\s+", "", key.strip().lower())
                    value = value.strip()
                    if key_norm == "computer":
                        header["computer"] = value
                    elif key_norm == "maxnodes":
                        header["max_nodes"] = _safe_int_text(value, 0)
                    elif key_norm == "maxprocs":
                        header["max_procs"] = _safe_int_text(value, 0)
                continue

            total_rows += 1
            parts = line.split()
            if len(parts) < 9:
                skipped_rows += 1
                continue
            if len(parts) < 18:
                parts += ["-1"] * (18 - len(parts))
            elif len(parts) > 18:
                parts = parts[:18]

            vals = [_safe_float_token(tok) for tok in parts]
            submit = max(0.0, vals[1])
            wait = max(0.0, vals[2])
            run = max(0.0, vals[3])
            alloc_proc = max(0.0, vals[4])
            req_proc = max(0.0, vals[7])
            req_time = max(0.0, vals[8])
            if req_proc <= 0.0 and alloc_proc > 0.0:
                req_proc = alloc_proc
                fallback_req_proc_rows += 1
            if req_time <= 0.0 and run > 0.0:
                req_time = run
                fallback_req_time_rows += 1
            user = _safe_int_text(parts[11], -1)
            group = _safe_int_text(parts[12], -1)

            submits.append(submit)
            waits.append(wait)
            runs.append(run)
            req_procs.append(req_proc)
            req_times.append(req_time)
            if user >= 0:
                users.add(user)
                stats = user_stats.setdefault(
                    user,
                    {"jobs": 0, "sum_wait": 0.0, "sum_run": 0.0, "sum_req_procs": 0.0, "max_wait": 0.0},
                )
                stats["jobs"] += 1
                stats["sum_wait"] += wait
                stats["sum_run"] += run
                stats["sum_req_procs"] += req_proc
                if wait > stats["max_wait"]:
                    stats["max_wait"] = wait
            if group >= 0:
                groups.add(group)

    n = len(submits)
    if n == 0:
        raise ValueError(f"No SWF rows found in {path.name}")

    submit_sorted = sorted(submits)
    wait_sorted = sorted(waits)
    run_sorted = sorted(runs)
    req_proc_sorted = sorted(req_procs)
    req_time_sorted = sorted(req_times)

    submit_min = submit_sorted[0]
    submit_max = submit_sorted[-1]
    span = max(submit_max - submit_min, 0.0)
    jobs_per_day = (n / span * 86400.0) if span > 0 else float(n)

    starts = [submits[i] + waits[i] for i in range(n)]
    ends = [starts[i] + runs[i] for i in range(n)]
    turnarounds = [waits[i] + runs[i] for i in range(n)]

    slowdowns = []
    bounded_slowdowns = []
    for i in range(n):
        run = max(runs[i], 0.0)
        ta = turnarounds[i]
        slowdowns.append(max(ta / max(run, 1.0), 1.0))
        bounded_slowdowns.append(max(ta / max(run, 10.0), 1.0))

    turnaround_sorted = sorted(turnarounds)
    slowdown_sorted = sorted(slowdowns)
    bounded_slowdown_sorted = sorted(bounded_slowdowns)

    inter_arrivals = []
    if n > 1:
        inter_arrivals = [max(0.0, submit_sorted[i] - submit_sorted[i - 1]) for i in range(1, n)]
    inter_arrival_sorted = sorted(inter_arrivals)
    inter_arrival_mean = _mean(inter_arrivals)
    inter_arrival_cv = (_std(inter_arrivals) / inter_arrival_mean) if inter_arrival_mean > 0 else 0.0

    req_to_run = [req_times[i] / max(runs[i], 1.0) for i in range(n)]
    run_to_req = [runs[i] / max(req_times[i], 1.0) for i in range(n)]
    under_requested_pct = 100.0 * sum(1 for i in range(n) if req_times[i] < runs[i]) / n
    zero_wait_pct = 100.0 * sum(1 for w in waits if w <= 0.0) / n

    max_procs = int(header.get("max_procs") or 0)
    if max_procs > 0:
        avg_cluster_demand = _mean(req_procs) / max_procs
        p95_cluster_demand = _percentile_sorted(req_proc_sorted, 95) / max_procs
        peak_cluster_demand = req_proc_sorted[-1] / max_procs
    else:
        avg_cluster_demand = 0.0
        p95_cluster_demand = 0.0
        peak_cluster_demand = 0.0

    runtime_edges = [0, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 172800, 604800]
    while run_sorted[-1] > runtime_edges[-1] and len(runtime_edges) < 18:
        runtime_edges.append(runtime_edges[-1] * 2)

    wait_edges = [0, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 172800, 604800]
    while wait_sorted[-1] > wait_edges[-1] and len(wait_edges) < 18:
        wait_edges.append(wait_edges[-1] * 2)

    req_proc_edges = [0, 1, 8, 32, 128, 512, 2048, 8192, 32768, 131072, 524288]
    while req_proc_sorted[-1] > req_proc_edges[-1] and len(req_proc_edges) < 16:
        req_proc_edges.append(req_proc_edges[-1] * 2)

    slowdown_edges = [1.0, 1.2, 1.5, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0, 34.0, 55.0]
    while bounded_slowdown_sorted[-1] > slowdown_edges[-1] and len(slowdown_edges) < 18:
        slowdown_edges.append(round(slowdown_edges[-1] * 1.6, 4))

    hist_runtime = _build_histogram(runs, runtime_edges)
    hist_wait = _build_histogram(waits, wait_edges)
    hist_req_procs = _build_histogram(req_procs, req_proc_edges)
    hist_bounded_slowdown = _build_histogram(bounded_slowdowns, slowdown_edges)
    timeline = _build_submit_timeline(submits, waits, runs)
    pressure_timeline = _build_pressure_timeline(submits, starts, ends, req_procs, max_procs)
    wait_heatmap = _build_wait_heatmap(req_procs, waits)
    wait_by_runtime_class = _build_wait_by_runtime_class(runs, waits)

    q_depth = [float(v) for v in pressure_timeline.get("queue_depth", [])]
    q_depth_sorted = sorted(q_depth)
    q_procs = [float(v) for v in pressure_timeline.get("queue_procs", [])]
    q_procs_sorted = sorted(q_procs)
    running_share = [float(v) for v in pressure_timeline.get("running_share", [])]
    running_share_sorted = sorted(running_share)

    congestion_windows = []
    if q_procs:
        idx_order = sorted(
            range(len(q_procs)),
            key=lambda i: (q_procs[i], q_depth[i] if i < len(q_depth) else 0.0),
            reverse=True,
        )[:10]
        for rank, idx in enumerate(idx_order, 1):
            congestion_windows.append({
                "rank": rank,
                "time": pressure_timeline["labels"][idx],
                "t_seconds": pressure_timeline["time"][idx],
                "queue_depth": int(round(q_depth[idx])) if idx < len(q_depth) else 0,
                "queue_procs": round(q_procs[idx], 3),
                "running_share": round(running_share[idx], 4) if idx < len(running_share) else 0.0,
            })

    indices = list(range(n))

    top_users = []
    for user_id, stat in sorted(user_stats.items(), key=lambda kv: kv[1]["jobs"], reverse=True)[:20]:
        jobs = max(int(stat["jobs"]), 1)
        top_users.append({
            "user": str(user_id),
            "jobs": jobs,
            "avg_wait": round(stat["sum_wait"] / jobs, 3),
            "avg_runtime": round(stat["sum_run"] / jobs, 3),
            "avg_req_procs": round(stat["sum_req_procs"] / jobs, 3),
            "max_wait": round(stat["max_wait"], 3),
        })

    user_avg_waits = sorted(stat["sum_wait"] / max(int(stat["jobs"]), 1) for stat in user_stats.values())
    if user_avg_waits:
        uw_sum = sum(user_avg_waits)
        uw_sq_sum = sum(v * v for v in user_avg_waits)
        user_wait_jain = (uw_sum * uw_sum) / (len(user_avg_waits) * uw_sq_sum) if uw_sq_sum > 0 else 1.0
        user_wait_p50 = _percentile_sorted(user_avg_waits, 50)
        user_wait_p90 = _percentile_sorted(user_avg_waits, 90)
        user_wait_p95 = _percentile_sorted(user_avg_waits, 95)
        user_wait_p90_to_p50 = user_wait_p90 / max(user_wait_p50, 1e-9)
    else:
        user_wait_jain = 1.0
        user_wait_p50 = 0.0
        user_wait_p90 = 0.0
        user_wait_p95 = 0.0
        user_wait_p90_to_p50 = 0.0

    return {
        "status": "ok",
        "file": path.name,
        "header": header,
        "summary": {
            "input_rows": total_rows,
            "parsed_rows": n,
            "skipped_rows": skipped_rows,
            "fallback_req_time_rows": fallback_req_time_rows,
            "fallback_req_procs_rows": fallback_req_proc_rows,
            "total_jobs": n,
            "unique_users": len(users),
            "unique_groups": len(groups),
            "submit_start": round(submit_min, 3),
            "submit_end": round(submit_max, 3),
            "submit_span": round(span, 3),
            "jobs_per_day": round(jobs_per_day, 3),
            "avg_wait": round(_mean(waits), 3),
            "wait_p50": round(_percentile_sorted(wait_sorted, 50), 3),
            "wait_p90": round(_percentile_sorted(wait_sorted, 90), 3),
            "wait_p95": round(_percentile_sorted(wait_sorted, 95), 3),
            "wait_p99": round(_percentile_sorted(wait_sorted, 99), 3),
            "avg_runtime": round(_mean(runs), 3),
            "runtime_p50": round(_percentile_sorted(run_sorted, 50), 3),
            "runtime_p90": round(_percentile_sorted(run_sorted, 90), 3),
            "runtime_p95": round(_percentile_sorted(run_sorted, 95), 3),
            "runtime_p99": round(_percentile_sorted(run_sorted, 99), 3),
            "avg_req_time": round(_mean(req_times), 3),
            "req_time_p95": round(_percentile_sorted(req_time_sorted, 95), 3),
            "avg_req_procs": round(_mean(req_procs), 3),
            "req_procs_p95": round(_percentile_sorted(req_proc_sorted, 95), 3),
            "max_req_procs": int(round(req_proc_sorted[-1])),
            "avg_turnaround": round(_mean(turnarounds), 3),
            "turnaround_p95": round(_percentile_sorted(turnaround_sorted, 95), 3),
            "avg_slowdown": round(_mean(slowdowns), 4),
            "slowdown_p95": round(_percentile_sorted(slowdown_sorted, 95), 4),
            "avg_bounded_slowdown": round(_mean(bounded_slowdowns), 4),
            "bounded_slowdown_p95": round(_percentile_sorted(bounded_slowdown_sorted, 95), 4),
            "avg_req_to_run_ratio": round(_mean(req_to_run), 4),
            "avg_run_to_req_ratio": round(_mean(run_to_req), 4),
            "under_requested_pct": round(under_requested_pct, 3),
            "zero_wait_pct": round(zero_wait_pct, 3),
            "interarrival_p50": round(_percentile_sorted(inter_arrival_sorted, 50), 3),
            "interarrival_p90": round(_percentile_sorted(inter_arrival_sorted, 90), 3),
            "interarrival_cv": round(inter_arrival_cv, 4),
            "user_wait_jain": round(user_wait_jain, 4),
            "user_wait_p50": round(user_wait_p50, 3),
            "user_wait_p90": round(user_wait_p90, 3),
            "user_wait_p95": round(user_wait_p95, 3),
            "user_wait_p90_to_p50": round(user_wait_p90_to_p50, 4),
            "avg_cluster_demand_share": round(avg_cluster_demand, 4),
            "p95_cluster_demand_share": round(p95_cluster_demand, 4),
            "peak_cluster_demand_share": round(peak_cluster_demand, 4),
            "avg_queue_depth_est": round(_mean(q_depth), 3),
            "queue_depth_p95_est": round(_percentile_sorted(q_depth_sorted, 95), 3),
            "peak_queue_depth_est": int(round(max(q_depth))) if q_depth else 0,
            "avg_queue_procs_est": round(_mean(q_procs), 3),
            "queue_procs_p95_est": round(_percentile_sorted(q_procs_sorted, 95), 3),
            "peak_queue_procs_est": round(max(q_procs), 3) if q_procs else 0.0,
            "avg_running_share_est": round(_mean(running_share), 4),
            "running_share_p95_est": round(_percentile_sorted(running_share_sorted, 95), 4),
            "peak_running_share_est": round(max(running_share), 4) if running_share else 0.0,
        },
        "histograms": {
            "runtime": {
                "labels": _labels_from_edges(runtime_edges, is_time=True),
                "counts": hist_runtime,
            },
            "wait": {
                "labels": _labels_from_edges(wait_edges, is_time=True),
                "counts": hist_wait,
            },
            "req_procs": {
                "labels": _labels_from_edges(req_proc_edges, is_time=False),
                "counts": hist_req_procs,
            },
            "bounded_slowdown": {
                "labels": _labels_from_ratio_edges(slowdown_edges),
                "counts": hist_bounded_slowdown,
            },
        },
        "submit_timeline": timeline,
        "pressure_timeline": pressure_timeline,
        "wait_heatmap": wait_heatmap,
        "wait_by_runtime_class": wait_by_runtime_class,
        "scatter": {
            "req_time": [round(req_times[i], 3) for i in indices],
            "run": [round(runs[i], 3) for i in indices],
            "wait": [round(waits[i], 3) for i in indices],
            "req_procs": [round(req_procs[i], 3) for i in indices],
        },
        "top_users": top_users,
        "congestion_windows": congestion_windows,
    }


def _latest_mtime(paths) -> float:
    latest = 0.0
    for p in paths:
        try:
            mt = p.stat().st_mtime
            if mt > latest:
                latest = mt
        except Exception:
            continue
    return latest


def _load_json_file(path: Path, default):
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
    except Exception:
        pass
    return default


def _is_historical_index_stale() -> bool:
    now = time.time()
    age = now - float(_historical_stale_cache.get("checked_at", 0.0))
    if age >= 0 and age <= HISTORICAL_STALE_TTL_SEC:
        return bool(_historical_stale_cache.get("value", True))

    rst_latest = _latest_mtime(RESULTS_DIR.glob("*.rst"))
    if rst_latest <= 0:
        if not SUMMARY_JSON.exists() and not WORKLOG_JSON.exists():
            stale = False
        else:
            summary = _load_json_file(SUMMARY_JSON, [])
            worklog = _load_json_file(WORKLOG_JSON, [])
            stale = bool(summary) or bool(worklog)
    elif not SUMMARY_JSON.exists() or not WORKLOG_JSON.exists():
        stale = True
    else:
        summary = _load_json_file(SUMMARY_JSON, [])
        worklog = _load_json_file(WORKLOG_JSON, [])
        if not isinstance(summary, list) or not isinstance(worklog, list):
            stale = True
        elif rst_latest > 0 and (not summary or not worklog):
            # Index is incomplete/corrupt (e.g., summary wiped but .rst still exists).
            stale = True
        else:
            idx_latest = min(SUMMARY_JSON.stat().st_mtime, WORKLOG_JSON.stat().st_mtime)
            stale = rst_latest > idx_latest + 1e-6

    _historical_stale_cache["checked_at"] = now
    _historical_stale_cache["value"] = stale
    return stale


def _load_historical_payload_cached() -> dict:
    summary_mtime_ns = SUMMARY_JSON.stat().st_mtime_ns if SUMMARY_JSON.exists() else -1
    worklog_mtime_ns = WORKLOG_JSON.stat().st_mtime_ns if WORKLOG_JSON.exists() else -1
    cached = _historical_payload_cache
    if (
        cached.get("summary_mtime_ns") == summary_mtime_ns
        and cached.get("worklog_mtime_ns") == worklog_mtime_ns
    ):
        payload = cached.get("payload") or {"summary": [], "worklog": []}
        return {"summary": payload.get("summary", []), "worklog": payload.get("worklog", [])}

    payload = {
        "summary": _load_json_file(SUMMARY_JSON, []),
        "worklog": _load_json_file(WORKLOG_JSON, []),
    }
    cached["summary_mtime_ns"] = summary_mtime_ns
    cached["worklog_mtime_ns"] = worklog_mtime_ns
    cached["payload"] = payload
    return payload


def _build_historical_stub_payload() -> dict:
    """Fast fallback when summary/worklog index has not been built yet."""
    rows = []
    for rst in RESULTS_DIR.glob("*.rst"):
        try:
            name = rst.stem
            ident = pp.parse_run_identity(name, None)
            ts = datetime.fromtimestamp(rst.stat().st_mtime).isoformat(timespec="seconds")
            rows.append({
                "timestamp": ts,
                "run_name": ident.get("run_name", name),
                "system": ident.get("system", "custom"),
                "variant": ident.get("variant", "default_config"),
                "trace_variant": ident.get("trace_variant", "custom"),
                "scenario": ident.get("scenario", ""),
                "algorithm": "",
                "cluster_fraction": 1.0,
                "backfill": 2,
                "win": 5,
                "read_num": -1,
                "start": 0,
                "anchor": 0,
                "ad_bf": 0,
                "ad_win": 0,
                "ad_alg": 0,
                "total_jobs": 0,
                "avg_wait": 0.0,
                "wait_p95": 0.0,
                "avg_utilization": 0.0,
                "peak_queue_depth": 0,
                "makespan": 0.0,
            })
        except Exception:
            continue

    rows.sort(key=lambda r: str(r.get("timestamp", "")))
    worklog = []
    for idx, row in enumerate(rows, 1):
        worklog.append({
            "id": idx,
            "timestamp": row.get("timestamp", ""),
            "run_name": row.get("run_name", ""),
            "system": row.get("system", "custom"),
            "variant": row.get("variant", "default_config"),
            "trace_variant": row.get("trace_variant", "custom"),
            "scenario": row.get("scenario", ""),
            "input_file": row.get("run_name", ""),
            "backfill": "Conservative",
            "algorithm": "",
            "win": 5,
            "read_num": -1,
            "total_jobs": 0,
            "avg_wait": 0.0,
            "wait_p95": 0.0,
            "avg_utilization": 0.0,
            "peak_queue_depth": 0,
            "makespan": 0.0,
            "stub": True,
        })

    return {"summary": rows, "worklog": worklog}


def _run_payload_signature(output_name: str) -> tuple[tuple[int, int], tuple[int, int], tuple[int, int]]:
    parts = []
    for suffix in (".rst", ".ult", ".meta.json"):
        path = RESULTS_DIR / f"{output_name}{suffix}"
        if path.exists():
            st = path.stat()
            parts.append((int(st.st_mtime_ns), int(st.st_size)))
        else:
            parts.append((-1, -1))
    return parts[0], parts[1], parts[2]


def _run_payload_sig_token(sig: tuple[tuple[int, int], tuple[int, int], tuple[int, int]]) -> str:
    file_sig = "|".join(f"{mt}:{sz}" for mt, sz in sig)
    return f"pp:{_preprocess_sig}|{file_sig}"


def _safe_run_name(output_name: str) -> str:
    return os.path.basename(str(output_name or "").strip("/"))


def _run_cache_path(output_name: str) -> Path:
    key = hashlib.sha1(output_name.encode("utf-8")).hexdigest()
    return RUN_CACHE_DIR / f"{key}.json"


def _write_json_atomic(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    os.replace(tmp_path, path)


def _prune_run_payload_disk_cache():
    try:
        files = sorted(RUN_CACHE_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    except Exception:
        return
    for path in files[MAX_RUN_PAYLOAD_DISK_ENTRIES:]:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass


def _run_payload_disk_cache_get(output_name: str, sig_token: str):
    cache_path = _run_cache_path(output_name)
    if not cache_path.exists():
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return None
        if str(payload.get("sig", "")) != sig_token:
            cache_path.unlink(missing_ok=True)
            return None
        run_payload = payload.get("payload")
        if isinstance(run_payload, dict):
            return run_payload
    except Exception:
        return None
    return None


def _run_payload_disk_cache_put(output_name: str, sig_token: str, payload: dict):
    try:
        RUN_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(
            _run_cache_path(output_name),
            {"sig": sig_token, "saved_at": int(time.time()), "payload": payload},
        )
        _prune_run_payload_disk_cache()
    except Exception:
        pass


def _run_payload_cache_get(output_name: str, sig_token: str):
    with _run_payload_lock:
        cached = RUN_PAYLOAD_CACHE.get(output_name)
        if cached and cached.get("sig") == sig_token:
            RUN_PAYLOAD_CACHE.move_to_end(output_name)
            return cached.get("payload")
    disk_cached = _run_payload_disk_cache_get(output_name, sig_token)
    if disk_cached is not None:
        with _run_payload_lock:
            RUN_PAYLOAD_CACHE[output_name] = {"sig": sig_token, "payload": disk_cached}
            RUN_PAYLOAD_CACHE.move_to_end(output_name)
            while len(RUN_PAYLOAD_CACHE) > MAX_RUN_PAYLOAD_CACHE_ENTRIES:
                RUN_PAYLOAD_CACHE.popitem(last=False)
        return disk_cached
    return None


def _run_payload_cache_put(output_name: str, sig_token: str, payload: dict):
    with _run_payload_lock:
        RUN_PAYLOAD_CACHE[output_name] = {"sig": sig_token, "payload": payload}
        RUN_PAYLOAD_CACHE.move_to_end(output_name)
        while len(RUN_PAYLOAD_CACHE) > MAX_RUN_PAYLOAD_CACHE_ENTRIES:
            RUN_PAYLOAD_CACHE.popitem(last=False)
    _run_payload_disk_cache_put(output_name, sig_token, payload)


def _run_compute_lock_for(output_name: str) -> threading.Lock:
    with _run_compute_locks_lock:
        lock = _run_compute_locks.get(output_name)
        if lock is None:
            lock = threading.Lock()
            _run_compute_locks[output_name] = lock
        return lock


def _compact_run_payload(payload: dict, include_scatter: bool = False) -> dict:
    if not isinstance(payload, dict):
        return {}
    if include_scatter:
        return payload
    out = dict(payload)
    out.pop("scatter", None)
    return out


def _persist_run_artifacts(output_name: str, payload: dict):
    if not isinstance(payload, dict):
        return
    timeseries = payload.get("timeseries")
    if isinstance(timeseries, dict):
        try:
            _write_json_atomic(TIMESERIES_DIR / f"{output_name}.json", timeseries)
        except Exception:
            pass
    scatter = payload.get("scatter")
    if isinstance(scatter, dict):
        try:
            _write_json_atomic(TIMESERIES_DIR / f"{output_name}_scatter.json", scatter)
        except Exception:
            pass


def _load_scatter_artifact(output_name: str):
    path = TIMESERIES_DIR / f"{output_name}_scatter.json"
    try:
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _compute_run_payload(output_name: str, include_scatter: bool = False):
    safe_output = _safe_run_name(output_name)
    sig = _run_payload_signature(safe_output)
    sig_token = _run_payload_sig_token(sig)
    cached = _run_payload_cache_get(safe_output, sig_token)
    if cached is not None:
        if include_scatter:
            out = dict(cached)
            out["scatter"] = _load_scatter_artifact(safe_output) or {}
            return out
        return cached

    lock = _run_compute_lock_for(safe_output)
    with lock:
        sig = _run_payload_signature(safe_output)
        sig_token = _run_payload_sig_token(sig)
        cached = _run_payload_cache_get(safe_output, sig_token)
        if cached is not None:
            if include_scatter:
                out = dict(cached)
                out["scatter"] = _load_scatter_artifact(safe_output) or {}
                return out
            return cached

        full_payload = pp.preprocess_single_run(safe_output, None)
        _persist_run_artifacts(safe_output, full_payload)
        compact = _compact_run_payload(full_payload, include_scatter=False)
        _run_payload_cache_put(safe_output, sig_token, compact)
        if include_scatter:
            out = dict(compact)
            out["scatter"] = full_payload.get("scatter", {}) if isinstance(full_payload.get("scatter"), dict) else {}
            return out
        return compact


def _pick_latest_historical_run_name(summary: list, worklog: list) -> str:
    if isinstance(worklog, list):
        rows = [w for w in worklog if isinstance(w, dict) and str(w.get("run_name", "")).strip()]
        rows.sort(key=lambda x: str(x.get("timestamp", "")), reverse=True)
        for row in rows:
            name = _safe_run_name(row.get("run_name", ""))
            if name and (RESULTS_DIR / f"{name}.rst").exists():
                return name

    if isinstance(summary, list):
        rows = [s for s in summary if isinstance(s, dict) and str(s.get("run_name", "")).strip()]
        rows.sort(key=lambda x: str(x.get("timestamp", "")), reverse=True)
        for row in rows:
            name = _safe_run_name(row.get("run_name", ""))
            if name and (RESULTS_DIR / f"{name}.rst").exists():
                return name
    return ""


def _warm_run_payload_async(output_name: str):
    safe_output = _safe_run_name(output_name)
    if not safe_output or not (RESULTS_DIR / f"{safe_output}.rst").exists():
        return
    with _run_warm_lock:
        if safe_output in _run_warm_inflight:
            return
        _run_warm_inflight.add(safe_output)

    def _worker():
        try:
            _compute_run_payload(safe_output, include_scatter=False)
        except Exception:
            pass
        finally:
            with _run_warm_lock:
                _run_warm_inflight.discard(safe_output)

    threading.Thread(target=_worker, daemon=True, name=f"warm-run-{safe_output[:24]}").start()


def _schedule_warm_latest_run_payload(summary: list, worklog: list):
    latest = _pick_latest_historical_run_name(summary, worklog)
    if latest:
        _warm_run_payload_async(latest)


def _ensure_historical_index():
    """Rebuild dashboard summary/worklog index if result files changed."""
    if _is_historical_index_stale():
        pp.main()


def _rebuild_historical_index(force: bool = True, fast: bool = False) -> dict:
    """Rebuild (or ensure) historical summary/worklog index and return payload."""
    DASH_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _historical_lock:
        if not fast:
            if force:
                pp.main()
            else:
                _ensure_historical_index()
        payload = _load_historical_payload_cached()
        summary = payload.get("summary", [])
        worklog = payload.get("worklog", [])
        if fast:
            summary_ok = isinstance(summary, list)
            worklog_ok = isinstance(worklog, list)
            inconsistent = summary_ok and worklog_ok and ((not summary and bool(worklog)) or (bool(summary) and not worklog))
            if not summary_ok or not worklog_ok or inconsistent:
                # Fast mode should stay cheap, but must not return a broken index snapshot.
                _ensure_historical_index()
                payload = _load_historical_payload_cached()
                summary = payload.get("summary", [])
                worklog = payload.get("worklog", [])
        if fast and not summary and not worklog:
            stub_payload = _build_historical_stub_payload()
            summary = stub_payload.get("summary", [])
            worklog = stub_payload.get("worklog", [])
        if fast:
            # Fast path only reads current index; it must not mark index as fresh.
            _historical_stale_cache["checked_at"] = 0.0
        else:
            _historical_stale_cache["checked_at"] = time.time()
            _historical_stale_cache["value"] = False

    _schedule_warm_latest_run_payload(summary, worklog)
    return {
        "summary": summary,
        "worklog": worklog,
        "summary_count": len(summary),
        "worklog_count": len(worklog),
    }


# --------------------------------------------------------------------------- #
# Background simulation thread
# --------------------------------------------------------------------------- #

def _poll_progress(run_id: str, performance_csv: Path, target_jobs: int, stop: threading.Event):
    """Poll native performance.csv every 1.5 s to track completion percentage."""
    while not stop.is_set():
        try:
            finished = nb.read_jobs_finished(performance_csv)
            if finished is not None:
                if target_jobs and target_jobs > 0:
                    progress = min(99, int(finished / max(target_jobs, 1) * 100))
                else:
                    # Unknown total (read_num=-1): show asymptotic progress while running.
                    progress = min(99, int(99 * (1.0 - math.exp(-finished / 5000.0))))

                with _runs_lock:
                    state = ACTIVE_RUNS.get(run_id, {})
                    if state.get("status") == "running":
                        state["progress"] = progress
                        state["processed_lines"] = finished
        except Exception:
            pass
        stop.wait(timeout=1.5)

def _launch_simulation(run_id: str, params: dict):
    """Run the native CQTwin engine as a subprocess; called in a daemon thread."""
    job_trace = params["job_trace"]
    output_name = _build_output_name(job_trace, params, run_id)
    legacy_config = {}
    try:
        legacy_config = _write_legacy_config_bundle(output_name, params)
        _write_run_meta(output_name, params, legacy_config=legacy_config)
    except Exception:
        pass

    with _runs_lock:
        ACTIVE_RUNS[run_id].update({
            "status": "running",
            "stage": "Preparing native run",
            "output_name": output_name,
            "started_at": time.time(),
        })

    cfg_path = nb.build_engine_config(BASE_DIR, run_id, output_name, params)
    native_paths = nb.native_run_paths(BASE_DIR, output_name)
    engine_bin = _resolve_engine_binary()
    cmd = _build_engine_command(engine_bin, cfg_path)

    # --- Progress polling thread ---
    native_paths["native_root"].mkdir(parents=True, exist_ok=True)
    target_jobs = int(params.get("read_num", -1) or -1)
    stop_poll = threading.Event()
    poll_thread = threading.Thread(
        target=_poll_progress,
        args=(run_id, native_paths["performance_csv"], target_jobs, stop_poll),
        daemon=True,
    )
    poll_thread.start()

    # --- Run subprocess ---
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(BASE_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        with _runs_lock:
            ACTIVE_RUNS[run_id]["pid"] = proc.pid
            ACTIVE_RUNS[run_id]["stage"] = "Running native simulation"

        # Capture stdout lines for live display (capped at 240 lines)
        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            if line:
                with _runs_lock:
                    run = ACTIVE_RUNS.get(run_id)
                    if not run:
                        continue
                    log = run.setdefault("log", [])
                    log.append(line)
                    if len(log) > 240:
                        del log[0]

        proc.wait()
        stop_poll.set()

        if proc.returncode == 0:
            nb.convert_native_run_to_legacy(BASE_DIR, output_name)
            effective_params = dict(params)
            effective_params["output_name"] = output_name
            full_result = pp.preprocess_single_run(output_name, effective_params)
            _persist_run_artifacts(output_name, full_result)
            result = _compact_run_payload(full_result, include_scatter=False)
            sig = _run_payload_signature(output_name)
            _run_payload_cache_put(output_name, _run_payload_sig_token(sig), result)
            with _runs_lock:
                ACTIVE_RUNS[run_id].update({
                    "status": "complete",
                    "stage": "Postprocessing complete",
                    "progress": 100,
                    "processed_lines": target_jobs if target_jobs > 0 else ACTIVE_RUNS[run_id].get("processed_lines", 0),
                    "result": result,
                    "finished_at": time.time(),
                })
        else:
            with _runs_lock:
                ACTIVE_RUNS[run_id].update({
                    "status": "error",
                    "stage": "Simulation failed",
                    "error": f"Simulation exited with code {proc.returncode}",
                    "finished_at": time.time(),
                })
    except Exception as exc:
        stop_poll.set()
        with _runs_lock:
            ACTIVE_RUNS[run_id].update({
                "status": "error",
                "stage": "Launch failed",
                "error": str(exc),
                "finished_at": time.time(),
            })


# --------------------------------------------------------------------------- #
# Interactive online sessions (human-in-the-loop stepping)
# --------------------------------------------------------------------------- #

def _online_params_from_body(body: dict):
    """Validate an online request body → (params, None) or (None, error_str).
    Same accepted shape as _api_online_run, so an interactive session takes the
    identical config the headless run does."""
    job_trace = str(body.get("job_trace", "")).strip()
    if not job_trace:
        return None, "job_trace is required"
    path_in = str(body.get("path_in", "InputFiles/")).strip() or "InputFiles/"
    if not _resolve_input_trace_path(job_trace, path_in).exists():
        return None, f"job_trace not found: {job_trace}"
    pool = list(dict.fromkeys(
        str(p).strip().lower() for p in (body.get("advisory_pool") or []) if str(p).strip()))
    if not pool:
        return None, "advisory pool must contain at least one policy"
    if len(pool) > 8:
        return None, "advisory pool is limited to 8 policies"
    committed = str(body.get("committed_policy", "")).strip().lower()
    if not committed:
        return None, "committed_policy is required"
    if committed not in pool:
        return None, f"committed_policy '{committed}' must be one of the advisory pool policies"
    try:
        horizon_hours = float(body.get("horizon_hours", 24))
    except (TypeError, ValueError):
        horizon_hours = -1.0
    if horizon_hours <= 0:
        return None, "horizon_hours must be > 0"
    params = {
        "run_type": "online_advisory",
        "job_trace": job_trace,
        "node_struc": str(body.get("node_struc", "")).strip(),
        "committed_policy": committed,
        "advisory_pool": pool,
        "backfill": _norm_int(body.get("backfill", 1), 1),
        "window_size": _norm_int(body.get("window_size", 64), 64),
        "horizon_hours": horizon_hours,
        "interval": max(1, _norm_int(body.get("interval", 10), 10)),
        "read_num": _norm_int(body.get("read_num", -1), -1),
        "run_label": str(body.get("run_label", "")).strip(),
        "path_in": path_in,
        "algorithm": committed,
        "alg": committed,
    }
    for key in ("node_count", "procs_per_node"):
        if body.get(key):
            params[key] = body[key]
    return params, None


def _online_session_rpc(sess: dict, msg: dict, timeout: float = 30.0) -> dict:
    """Send one command line to the engine socket and read one JSON response."""
    sock = sess["sock"]
    sock.settimeout(timeout)
    sock.sendall((json.dumps(msg) + "\n").encode("utf-8"))
    line = sess["rfile"].readline()
    if not line:
        raise RuntimeError("engine closed the connection")
    return json.loads(line)


def _online_session_teardown(sess: dict) -> None:
    """Best-effort: close the socket, stop the engine, drop the scratch dir."""
    if not sess:
        return
    s = sess.get("sock")
    if s is not None:
        try:
            s.sendall(b'{"cmd":"close"}\n')
        except Exception:
            pass
        try:
            s.close()
        except Exception:
            pass
    proc = sess.get("proc")
    if proc is not None:
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except Exception:
                    proc.kill()
        except Exception:
            pass
    out = sess.get("output_name")
    if out:
        try:
            shutil.rmtree(NATIVE_RESULTS_DIR / out, ignore_errors=True)
        except Exception:
            pass


def _online_queue_sig(resp: dict) -> str:
    """Signature of the wait-queue in an observation: length + the visible job
    ids (capped at the obs queue_window). "Run to next queue change" advances
    while this stays constant and stops the moment it differs — i.e. when a
    queued job starts or a new job arrives."""
    obs = resp.get("obs") or {}
    sys_ = obs.get("system") or {}
    qlen = sys_.get("queue_len", 0)
    ids = ",".join(str(j.get("id")) for j in (obs.get("queue") or []))
    return f"{qlen}:{ids}"


def _online_session_reap() -> None:
    """Tear down idle sessions so a forgotten browser tab can't leak engines."""
    now = time.time()
    stale = []
    with _online_sessions_lock:
        for sid, sess in list(ONLINE_SESSIONS.items()):
            if now - sess.get("touched", now) > _ONLINE_SESSION_TTL:
                stale.append(sess)
                ONLINE_SESSIONS.pop(sid, None)
    for sess in stale:
        _online_session_teardown(sess)


def _launch_online_advisory(run_id: str, params: dict):
    """Run a CQTwin headless online-advisory run (`cqtwin online-run`) as a
    subprocess. Writes jobs.csv into the native_results layout (so the existing
    convert+preprocess pipeline handles it unchanged) plus advisory.csv for the
    online results view. Called in a daemon thread."""
    job_trace = params["job_trace"]
    output_name = _build_output_name(job_trace, params, run_id)
    try:
        _write_run_meta(output_name, params, legacy_config={})
    except Exception:
        pass

    with _runs_lock:
        ACTIVE_RUNS[run_id].update({
            "status": "running",
            "stage": "Preparing online advisory run",
            "output_name": output_name,
            "started_at": time.time(),
        })

    try:
        cfg_path = nb.build_online_config(BASE_DIR, output_name, params)
        engine_bin = _resolve_engine_binary()
        cmd = [str(engine_bin), "online-run", str(cfg_path.relative_to(BASE_DIR))]

        with _runs_lock:
            ACTIVE_RUNS[run_id]["stage"] = "Running online advisory simulation"

        proc = subprocess.Popen(
            cmd, cwd=str(BASE_DIR), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        with _runs_lock:
            ACTIVE_RUNS[run_id]["pid"] = proc.pid

        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            if line:
                # `online-run` emits `progress: NN% | cycle .. | jobs c/total` every
                # ~2s; surface it on the progress bar so long runs don't look frozen.
                m = re.match(r"progress:\s*(\d+)%", line)
                with _runs_lock:
                    run = ACTIVE_RUNS.get(run_id)
                    if run is not None:
                        if m:
                            run["progress"] = int(m.group(1))
                            run["stage"] = "Running online advisory simulation — " + line.split("progress:", 1)[1].strip()
                        log = run.setdefault("log", [])
                        log.append(line)
                        if len(log) > 240:
                            del log[0]
        proc.wait()

        if proc.returncode == 0:
            nb.convert_native_run_to_legacy(BASE_DIR, output_name)
            effective_params = dict(params)
            effective_params["output_name"] = output_name
            full_result = pp.preprocess_single_run(output_name, effective_params)
            _persist_run_artifacts(output_name, full_result)
            result = _compact_run_payload(full_result, include_scatter=False)
            sig = _run_payload_signature(output_name)
            _run_payload_cache_put(output_name, _run_payload_sig_token(sig), result)
            with _runs_lock:
                ACTIVE_RUNS[run_id].update({
                    "status": "complete",
                    "stage": "Postprocessing complete",
                    "progress": 100,
                    "result": result,
                    "finished_at": time.time(),
                })
        else:
            with _runs_lock:
                ACTIVE_RUNS[run_id].update({
                    "status": "error",
                    "stage": "Online run failed",
                    "error": f"online-run exited with code {proc.returncode}",
                    "finished_at": time.time(),
                })
    except Exception as exc:
        with _runs_lock:
            ACTIVE_RUNS[run_id].update({
                "status": "error",
                "stage": "Launch failed",
                "error": str(exc),
                "finished_at": time.time(),
            })


def _analyze_advisory_csv(path: Path, max_points: int = 2000) -> dict:
    """Parse advisory.csv into chart-ready per-policy series + a summary table.

    Downsampling is DETERMINISTIC: a fixed number of equal-width sim_time bins
    (never sampling), so the same run always renders the same chart. Each bin
    reports the mean projected wait per policy. The summary gives, per pool
    policy, the fraction of evaluated cycles where it projected the lowest wait
    and its mean projected wait. Columns:
    cycle,sim_time,committed_policy,policy,proj_avg_wait,proj_jobs_completed,queue_measured
    """
    committed = None
    by_cycle: dict[int, dict[str, float]] = {}
    raw: list[tuple[float, str, float]] = []  # (sim_time, policy, proj_avg_wait)
    row_count = 0
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for row in csv.DictReader(fh):
            try:
                cyc = int(row["cycle"])
                t = float(row["sim_time"])
                pol = row["policy"]
                w = float(row["proj_avg_wait"])
            except (KeyError, ValueError, TypeError):
                continue
            committed = row.get("committed_policy") or committed
            raw.append((t, pol, w))
            by_cycle.setdefault(cyc, {})[pol] = w
            row_count += 1

    if not raw:
        return {"series": {}, "committed": committed, "summary": {},
                "rows": 0, "points": 0, "policies": []}

    policies = sorted({p for _, p, _ in raw})
    tmin = min(t for t, _, _ in raw)
    tmax = max(t for t, _, _ in raw)
    span = max(tmax - tmin, 1.0)
    nbins = max(1, min(int(max_points), len({t for t, _, _ in raw})))

    # Fixed-bin accumulation (deterministic).
    sums = {p: [0.0] * nbins for p in policies}
    counts = {p: [0] * nbins for p in policies}
    for t, pol, w in raw:
        b = int((t - tmin) / span * nbins)
        if b >= nbins:
            b = nbins - 1
        elif b < 0:
            b = 0
        sums[pol][b] += w
        counts[pol][b] += 1

    series = {}
    total_points = 0
    for p in policies:
        pts = []
        for b in range(nbins):
            if counts[p][b] > 0:
                t_center = tmin + (b + 0.5) * span / nbins
                pts.append({"t": round(t_center, 3),
                            "wait": round(sums[p][b] / counts[p][b], 4)})
        series[p] = pts
        total_points += len(pts)

    # Summary: fraction of cycles where each policy projected the lowest wait.
    wins = {p: 0 for p in policies}
    wait_sum = {p: 0.0 for p in policies}
    wait_n = {p: 0 for p in policies}
    evaluated = 0
    for cyc, polmap in by_cycle.items():
        if not polmap:
            continue
        evaluated += 1
        best_pol = min(polmap, key=lambda pp_: polmap[pp_])
        if best_pol in wins:
            wins[best_pol] += 1
        for p, w in polmap.items():
            if p in wait_sum:
                wait_sum[p] += w
                wait_n[p] += 1
    summary = {p: {"frac_lowest": round(wins[p] / evaluated, 4) if evaluated else 0.0,
                   "mean_proj_wait": round(wait_sum[p] / wait_n[p], 4) if wait_n[p] else 0.0}
               for p in policies}

    return {"series": series, "committed": committed, "summary": summary,
            "rows": row_count, "points": total_points, "cycles_evaluated": evaluated,
            "policies": policies, "bins": nbins}


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #

class DashboardHandler(http.server.SimpleHTTPRequestHandler):

    # --- Routing ---

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path

        if route in {"", "/", "/index.html"}:
            self._serve_index_html()
        elif route == "/api/files":
            self._api_files()
        elif route == "/api/health":
            self._api_health()
        elif route == "/api/delete-results/preview":
            self._api_delete_results_preview(parsed.query)
        elif route == "/api/historical":
            self._api_historical(parsed.query)
        elif route == "/api/worklogs/files":
            self._api_worklog_files()
        elif route == "/api/worklogs/analyze":
            self._api_worklog_analyze(parsed.query)
        elif route == "/api/online/runs":
            self._api_online_runs()
        elif route == "/api/online/advisory":
            self._api_online_advisory(parsed.query)
        elif route == "/api/online/advisory.csv":
            self._api_online_advisory_csv(parsed.query)
        elif route in ("/api/snapshot/forks", "/api/operator/forks"):
            self._api_snapshot_forks_list(parsed.query)
        elif route.startswith("/api/snapshot/forks/") or route.startswith("/api/operator/forks/"):
            prefix = "/api/snapshot/forks/" if route.startswith("/api/snapshot/forks/") else "/api/operator/forks/"
            self._api_snapshot_forks_get(route[len(prefix):])
        elif route == "/api/status":
            self._api_status()
        elif route.startswith("/api/results/"):
            self._api_results(route[len("/api/results/"):])
        elif route.startswith("/api/load/"):
            self._api_load(route[len("/api/load/"):], parsed.query)
        else:
            super().do_GET()

    def _serve_index_html(self):
        try:
            html = (DASHBOARD_DIR / "index.html").read_text(encoding="utf-8")
            html = html.replace("__PROJECT_NAME__", PROJECT_NAME)
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path

        if route == "/api/run":
            self._api_run()
        elif route == "/api/online-run":
            self._api_online_run()
        elif route == "/api/online/session/start":
            self._api_online_session_start()
        elif route == "/api/online/session/step":
            self._api_online_session_step()
        elif route == "/api/online/session/advance":
            self._api_online_session_advance()
        elif route == "/api/online/session/close":
            self._api_online_session_close()
        elif route == "/api/upload":
            self._api_upload()
        elif route == "/api/worklogs/upload":
            self._api_worklog_upload()
        elif route == "/api/presets/save":
            self._api_presets_save()
        elif route == "/api/rebuild-index":
            self._api_rebuild_index()
        elif route == "/api/delete-results":
            self._api_delete_results()
        elif route == "/api/clear-results":
            self._api_clear_results()
        elif route == "/api/recommend":
            self._api_recommend()
        elif route in ("/api/snapshot/preview", "/api/operator/preview"):
            self._api_snapshot_preview()
        elif route in ("/api/snapshot/forks", "/api/operator/forks"):
            self._api_snapshot_forks_save()
        elif route == "/api/cancel":
            self._api_cancel()
        else:
            self.send_error(404)

    # --- API handlers ---

    def _api_files(self):
        """List SWF-format files available in data/InputFiles/."""
        try:
            files = sorted(
                f.name for f in INPUT_DIR.iterdir()
                if f.is_file()
                and not f.name.startswith(".")
                and (f.suffix.lower() == ".swf" or f.suffix == "")
            )

            systems = {}
            for fname in files:
                stem = _get_raw_name(fname)
                base = stem.lower()
                variant = "custom"
                if base.endswith("_norm"):
                    system = stem[:-5]
                    variant = "norm"
                elif base.endswith("_p90"):
                    system = stem[:-4]
                    variant = "p90"
                elif base.endswith("_p95"):
                    system = stem[:-4]
                    variant = "p95"
                else:
                    system = stem
                systems.setdefault(system, []).append(variant)

            self._send_json({
                "files": files,
                "systems": [{"name": s, "variants": sorted(set(v))} for s, v in sorted(systems.items())],
            })
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_historical(self, query: str):
        """Return historical summary/worklog, rebuilding index if stale."""
        try:
            params = urllib.parse.parse_qs(query or "")
            raw_fast = str((params.get("fast") or ["0"])[0]).strip().lower()
            fast = raw_fast in {"1", "true", "yes", "on"}
            payload = _rebuild_historical_index(force=False, fast=fast)
            self._send_json(payload)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_rebuild_index(self):
        """Force a rebuild of summary/worklog historical index."""
        body = self._read_json_body()
        if body is None:
            return

        force = bool(body.get("force", True))
        try:
            started = time.time()
            payload = _rebuild_historical_index(force=force)
            payload["status"] = "ok"
            payload["elapsed_sec"] = round(time.time() - started, 3)
            self._send_json(payload)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_worklog_files(self):
        """List SWF worklog files available in dashboard/data/worklogs/."""
        try:
            WORKLOG_SWF_DIR.mkdir(parents=True, exist_ok=True)
            entries = []
            for path in sorted(WORKLOG_SWF_DIR.iterdir(), key=lambda p: p.name.lower()):
                if not path.is_file():
                    continue
                if path.name.startswith("."):
                    continue
                if path.suffix.lower() != ".swf":
                    continue
                stat = path.stat()
                entries.append({
                    "name": path.name,
                    "size_bytes": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                })
            self._send_json({"files": entries})
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_worklog_analyze(self, query: str):
        """Analyze one SWF worklog file and return chart-ready JSON payload."""
        try:
            params = urllib.parse.parse_qs(query or "")
            raw_name = str((params.get("file") or [""])[0]).strip()
            file_name = os.path.basename(raw_name)
            if not file_name:
                self._send_json({"error": "file query parameter is required"}, 400)
                return

            path = WORKLOG_SWF_DIR / file_name
            if not path.exists():
                self._send_json({"error": f"worklog file not found: {file_name}"}, 404)
                return

            mtime_ns = path.stat().st_mtime_ns
            cached = WORKLOG_ANALYSIS_CACHE.get(file_name)
            if cached and cached.get("mtime_ns") == mtime_ns:
                self._send_json(cached["payload"])
                return

            payload = _analyze_worklog_swf(path)
            WORKLOG_ANALYSIS_CACHE[file_name] = {
                "mtime_ns": mtime_ns,
                "payload": payload,
            }
            self._send_json(payload)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_status(self):
        """Return status for all runs (without large full results payloads)."""
        with _runs_lock:
            out = {}
            for rid, r in ACTIVE_RUNS.items():
                started_at = r.get("started_at")
                finished_at = r.get("finished_at")
                now = time.time()
                elapsed = 0
                if started_at:
                    elapsed = int((finished_at or now) - started_at)

                out[rid] = {
                    "status": r.get("status"),
                    "stage": r.get("stage"),
                    "progress": r.get("progress", 0),
                    "processed_lines": r.get("processed_lines", 0),
                    "output_name": r.get("output_name"),
                    "error": r.get("error"),
                    "elapsed_sec": elapsed,
                    "has_result": "result" in r,
                    "log": r.get("log", [])[-80:],
                }
        self._send_json(out)

    def _api_health(self):
        """Lightweight health endpoint for liveness/readiness checks."""
        with _runs_lock:
            active_count = sum(
                1 for run in ACTIVE_RUNS.values()
                if str(run.get("status", "")).lower() in {"starting", "running"}
            )
        self._send_json({
            "status": "ok",
            "service": SERVICE_NAME,
            "time": int(time.time()),
            "active_runs": active_count,
        })

    def _api_load(self, output_name: str, query: str = ""):
        """Return one historical run payload (lite by default; scatter optional)."""
        output_name = _safe_run_name(urllib.parse.unquote(output_name))
        try:
            rst_path = RESULTS_DIR / f"{output_name}.rst"
            if not rst_path.exists():
                self._send_json({"error": f"Run not found: {output_name}"}, 404)
                return

            params = urllib.parse.parse_qs(query or "")
            raw_lite = str((params.get("lite") or ["1"])[0]).strip().lower()
            lite = raw_lite in {"1", "true", "yes", "on"}
            raw_full = str((params.get("full") or params.get("include_scatter") or ["0"])[0]).strip().lower()
            include_scatter = (not lite) or (raw_full in {"1", "true", "yes", "on"})
            result = _compute_run_payload(output_name, include_scatter=include_scatter)
            self._send_json(result)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_results(self, run_id: str):
        """Return full result payload for a completed run."""
        with _runs_lock:
            run = ACTIVE_RUNS.get(run_id)
        if not run or "result" not in run:
            self._send_json({"error": "Run not found or not complete"}, 404)
            return
        self._send_json(run["result"])

    def _api_run(self):
        """Start a new CQSim simulation. Returns run_id immediately."""
        body = self._read_json_body()
        if body is None:
            return
        params = _normalize_run_params(body)

        job_trace = str(params.get("job_trace", "")).strip()
        if not job_trace:
            self._send_json({"error": "job_trace is required"}, 400)
            return
        if not _resolve_input_trace_path(job_trace, params.get("path_in", "")).exists():
            self._send_json({"error": f"job_trace not found: {job_trace}"}, 400)
            return
        node_struc = str(params.get("node_struc", "")).strip()
        if node_struc and not _resolve_input_trace_path(node_struc, params.get("path_in", "")).exists():
            self._send_json({"error": f"node_struc not found: {node_struc}"}, 400)
            return

        run_id = datetime.now().strftime("run_%Y%m%d_%H%M%S_%f")
        with _runs_lock:
            ACTIVE_RUNS[run_id] = {
                "status": "starting",
                "stage": "Queued",
                "progress": 0,
                "params": params,
            }

        threading.Thread(target=_launch_simulation, args=(run_id, params), daemon=True).start()
        self._send_json({"run_id": run_id})

    def _api_online_run(self):
        """Start a CQTwin online-advisory run. Validates inputs and returns 400
        with a browser-visible reason on any rejection (pool non-empty,
        committed_policy in pool, horizon > 0, interval >= 1)."""
        body = self._read_json_body()
        if body is None:
            return

        job_trace = str(body.get("job_trace", "")).strip()
        if not job_trace:
            self._send_json({"error": "job_trace is required"}, 400)
            return
        path_in = str(body.get("path_in", "InputFiles/")).strip() or "InputFiles/"
        if not _resolve_input_trace_path(job_trace, path_in).exists():
            self._send_json({"error": f"job_trace not found: {job_trace}"}, 400)
            return

        pool = list(dict.fromkeys(
            str(p).strip().lower() for p in (body.get("advisory_pool") or []) if str(p).strip()))
        if not pool:
            self._send_json({"error": "advisory pool must contain at least one policy"}, 400)
            return
        if len(pool) > 8:
            self._send_json({"error": "advisory pool is limited to 8 policies"}, 400)
            return

        committed = str(body.get("committed_policy", "")).strip().lower()
        if not committed:
            self._send_json({"error": "committed_policy is required"}, 400)
            return
        if committed not in pool:
            self._send_json(
                {"error": f"committed_policy '{committed}' must be one of the advisory pool policies"},
                400)
            return

        try:
            horizon_hours = float(body.get("horizon_hours", 24))
        except (TypeError, ValueError):
            horizon_hours = -1.0
        if horizon_hours <= 0:
            self._send_json({"error": "horizon_hours must be > 0"}, 400)
            return

        interval = _norm_int(body.get("interval", 10), 10)
        if interval < 1:
            self._send_json({"error": "interval must be >= 1"}, 400)
            return

        node_struc = str(body.get("node_struc", "")).strip()
        if node_struc and not _resolve_input_trace_path(node_struc, path_in).exists():
            self._send_json({"error": f"node_struc not found: {node_struc}"}, 400)
            return

        params = {
            "run_type": "online_advisory",
            "job_trace": job_trace,
            "node_struc": node_struc,
            "committed_policy": committed,
            "advisory_pool": pool,
            "backfill": _norm_int(body.get("backfill", 1), 1),
            "window_size": _norm_int(body.get("window_size", 64), 64),
            "horizon_hours": horizon_hours,
            "interval": interval,
            "read_num": _norm_int(body.get("read_num", -1), -1),
            "run_label": str(body.get("run_label", "")).strip(),
            "output_mode": (str(body.get("output_mode", "new")).strip() or "new"),
            "path_in": path_in,
            # committed policy doubles as algorithm/alg for output naming + meta.
            "algorithm": committed,
            "alg": committed,
        }
        for key in ("node_count", "procs_per_node"):
            if body.get(key):
                params[key] = body[key]

        run_id = datetime.now().strftime("run_%Y%m%d_%H%M%S_%f")
        with _runs_lock:
            ACTIVE_RUNS[run_id] = {
                "status": "starting",
                "stage": "Queued",
                "progress": 0,
                "params": params,
            }

        threading.Thread(target=_launch_online_advisory, args=(run_id, params), daemon=True).start()
        self._send_json({"run_id": run_id})

    # --- Interactive online sessions (step-through) -------------------------- #

    def _online_session_lookup(self, body):
        sid = str((body or {}).get("session_id", "")).strip()
        with _online_sessions_lock:
            sess = ONLINE_SESSIONS.get(sid)
            if sess is not None:
                # Refresh activity so an in-flight request can't be reaped out from
                # under itself by a concurrent new-session start (the reaper only
                # fires on start and uses this timestamp).
                sess["touched"] = time.time()
        return sid, sess

    def _end_session(self, sid):
        with _online_sessions_lock:
            sess = ONLINE_SESSIONS.pop(sid, None)
        _online_session_teardown(sess)

    def _api_online_session_start(self):
        """Spawn `online-serve`, connect, reset, and return the first decision.
        Forces advisory_interval=1 so every decision cycle carries projections."""
        body = self._read_json_body()
        if body is None:
            return
        params, err = _online_params_from_body(body)
        if err:
            self._send_json({"error": err}, 400)
            return
        params["interval"] = 1   # decide-each-cycle: project on every cycle

        _online_session_reap()
        with _online_sessions_lock:
            if len(ONLINE_SESSIONS) >= 8:
                self._send_json({"error": "too many active sessions; stop one first"}, 429)
                return

        session_id = datetime.now().strftime("sess_%Y%m%d_%H%M%S_%f")
        output_name = "session_" + session_id
        try:
            cfg_path = nb.build_online_config(BASE_DIR, output_name, params)
            engine_bin = _resolve_engine_binary()
            proc = subprocess.Popen(
                [str(engine_bin), "online-serve", str(cfg_path.relative_to(BASE_DIR)),
                 "--host", "127.0.0.1", "--port", "0"],
                cwd=str(BASE_DIR), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        except Exception as exc:
            self._send_json({"error": f"failed to launch engine: {exc}"}, 500)
            return

        # Read the "LISTENING <port>" handshake the engine prints on bind.
        port = None
        deadline = time.time() + 20.0
        try:
            while time.time() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if line.startswith("LISTENING"):
                    port = int(line.split()[1])
                    break
        except Exception:
            port = None
        if not port:
            try:
                proc.terminate()
            except Exception:
                pass
            self._send_json({"error": "engine did not report a listening port"}, 500)
            return

        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=20)
            rfile = sock.makefile("r")
        except Exception as exc:
            try:
                proc.terminate()
            except Exception:
                pass
            self._send_json({"error": f"could not connect to engine: {exc}"}, 500)
            return

        sess = {
            "proc": proc, "sock": sock, "rfile": rfile,
            "pool": params["advisory_pool"], "committed": params["committed_policy"],
            "output_name": output_name, "lock": threading.Lock(),
            "cycle": 0, "touched": time.time(),
        }
        try:
            with sess["lock"]:
                resp = _online_session_rpc(sess, {"cmd": "reset"})
        except Exception as exc:
            _online_session_teardown(sess)
            self._send_json({"error": f"reset failed: {exc}"}, 500)
            return

        sess["last_queue_sig"] = _online_queue_sig(resp)
        with _online_sessions_lock:
            ONLINE_SESSIONS[session_id] = sess
        resp.update({"session_id": session_id, "pool": sess["pool"],
                     "committed": sess["committed"], "cycle": 0})
        self._send_json(resp)

    def _api_online_session_step(self):
        """Apply one action at the current decision cycle, return the next one."""
        body = self._read_json_body()
        if body is None:
            return
        sid, sess = self._online_session_lookup(body)
        if not sess:
            self._send_json({"error": "session not found (it may have ended)", "done": True}, 404)
            return
        try:
            action = int(body.get("action", 0))
        except (TypeError, ValueError):
            action = 0
        if action < 0 or action >= len(sess["pool"]):
            self._send_json({"error": f"action out of range: {action}"}, 400)
            return
        try:
            with sess["lock"]:
                resp = _online_session_rpc(sess, {"cmd": "step", "action": action})
                sess["cycle"] += 1
                sess["touched"] = time.time()
                sess["last_queue_sig"] = _online_queue_sig(resp)
                resp["cycle"] = sess["cycle"]
        except Exception as exc:
            self._end_session(sid)
            self._send_json({"error": f"step failed: {exc}", "done": True}, 500)
            return
        if resp.get("done") or resp.get("status") == "terminal":
            self._end_session(sid)
        self._send_json(resp)

    def _api_online_session_advance(self):
        """Advance many cycles with one fixed action. `count` is an int (bounded)
        or "end" (run to completion). Returns the observation at the stop point."""
        body = self._read_json_body()
        if body is None:
            return
        sid, sess = self._online_session_lookup(body)
        if not sess:
            self._send_json({"error": "session not found (it may have ended)", "done": True}, 404)
            return
        try:
            action = int(body.get("action", 0))
        except (TypeError, ValueError):
            action = 0
        if action < 0 or action >= len(sess["pool"]):
            self._send_json({"error": f"action out of range: {action}"}, 400)
            return
        raw = str(body.get("count", 10)).strip().lower()
        to_end = raw == "end"
        to_change = raw == "change"
        if to_end:
            limit = 60000
        elif to_change:
            limit = 5000            # safety cap; the queue changes well before this
        else:
            try:
                limit = max(1, min(5000, int(raw)))
            except (TypeError, ValueError):
                limit = 10
        # Baseline for "run to next queue change" is the queue the operator is
        # looking at now (set by the prior step/reset), captured BEFORE stepping.
        baseline = sess.get("last_queue_sig")
        resp, steps, stopped = {}, 0, "cap"   # "cap" unless a break says otherwise
        try:
            with sess["lock"]:
                while steps < limit:
                    resp = _online_session_rpc(sess, {"cmd": "step", "action": action})
                    steps += 1
                    sess["cycle"] += 1
                    if resp.get("done") or resp.get("status") == "terminal":
                        stopped = "done"
                        break
                    if to_change and _online_queue_sig(resp) != baseline:
                        stopped = "change"
                        break
                sess["touched"] = time.time()
                sess["last_queue_sig"] = _online_queue_sig(resp)
                resp["cycle"] = sess["cycle"]
                resp["advanced"] = steps
                resp["stopped"] = stopped   # done | change | cap — lets the client label truthfully
        except Exception as exc:
            self._end_session(sid)
            self._send_json({"error": f"advance failed: {exc}", "done": True}, 500)
            return
        if resp.get("done") or resp.get("status") == "terminal":
            self._end_session(sid)
        self._send_json(resp)

    def _api_online_session_close(self):
        body = self._read_json_body()
        if body is None:
            return
        sid, _ = self._online_session_lookup(body)
        self._end_session(sid)
        self._send_json({"ok": True})

    def _api_online_runs(self):
        """List past online-advisory runs (those with an advisory.csv), newest
        first, so the Online tab can offer a "revisit a past run" picker.

        Layout is native_results/<name>/<name>/advisory.csv (run_name == the
        output dir name, mirrored one level deep by native_run_paths). Reads only
        the first data row of each file to surface the committed policy cheaply.
        """
        try:
            runs = []
            root = NATIVE_RESULTS_DIR
            if root.is_dir():
                for entry in root.iterdir():
                    if not entry.is_dir():
                        continue
                    adv = entry / entry.name / "advisory.csv"
                    if not adv.exists():
                        continue
                    committed = ""
                    try:
                        with open(adv, "r", encoding="utf-8", errors="ignore") as fh:
                            fh.readline()                      # header row
                            first = fh.readline().strip()      # first data row
                        parts = first.split(",") if first else []
                        if len(parts) >= 3:
                            committed = parts[2]                # committed_policy column
                    except Exception:
                        pass
                    st = adv.stat()
                    runs.append({
                        "run_name": entry.name,
                        "committed": committed,
                        "mtime": st.st_mtime,
                        "size_kb": round(st.st_size / 1024.0, 1),
                    })
            runs.sort(key=lambda r: r["mtime"], reverse=True)
            self._send_json({"runs": runs})
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_online_advisory(self, query: str):
        """Return chart-ready advisory series + summary for an online run."""
        try:
            params = urllib.parse.parse_qs(query or "")
            run = os.path.basename(str((params.get("run") or [""])[0]).strip())
            if not run:
                self._send_json({"error": "run query parameter is required"}, 400)
                return
            adv_path = nb.native_run_paths(BASE_DIR, run)["run_dir"] / "advisory.csv"
            if not adv_path.exists():
                self._send_json({"error": f"advisory.csv not found for run: {run}"}, 404)
                return
            self._send_json(_analyze_advisory_csv(adv_path, max_points=2000))
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_online_advisory_csv(self, query: str):
        """Stream the raw advisory.csv for download."""
        try:
            params = urllib.parse.parse_qs(query or "")
            run = os.path.basename(str((params.get("run") or [""])[0]).strip())
            if not run:
                self._send_json({"error": "run query parameter is required"}, 400)
                return
            adv_path = nb.native_run_paths(BASE_DIR, run)["run_dir"] / "advisory.csv"
            if not adv_path.exists():
                self._send_json({"error": f"advisory.csv not found for run: {run}"}, 404)
                return
            data = adv_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{run}_advisory.csv"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_upload(self):
        """Save a user-uploaded .swf file to data/InputFiles/."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            filename = os.path.basename(self.headers.get("X-Filename", "upload.swf"))
            if not filename.lower().endswith(".swf"):
                filename += ".swf"
            data = self.rfile.read(length)
            dest = INPUT_DIR / filename
            with open(dest, "wb") as fh:
                fh.write(data)
            self._send_json({"filename": filename, "size": len(data)})
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_worklog_upload(self):
        """Save a user-uploaded .swf file to dashboard/data/worklogs/."""
        try:
            WORKLOG_SWF_DIR.mkdir(parents=True, exist_ok=True)
            length = int(self.headers.get("Content-Length", 0))
            filename = os.path.basename(self.headers.get("X-Filename", "worklog.swf"))
            if not filename:
                filename = "worklog.swf"
            if not filename.lower().endswith(".swf"):
                filename += ".swf"

            data = self.rfile.read(length)
            dest = WORKLOG_SWF_DIR / filename
            with open(dest, "wb") as fh:
                fh.write(data)

            WORKLOG_ANALYSIS_CACHE.pop(filename, None)
            self._send_json({"filename": filename, "size": len(data)})
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_presets_save(self):
        """Save a preset JSON file under dashboard/preset/."""
        body = self._read_json_body()
        if body is None:
            return

        preset = body.get("preset")
        if not isinstance(preset, dict):
            self._send_json({"error": "preset object is required"}, 400)
            return

        filename = _safe_preset_filename(body.get("filename", ""))
        PRESET_DIR.mkdir(parents=True, exist_ok=True)
        path = PRESET_DIR / filename

        payload = {
            "version": 1,
            "saved_at": datetime.now().isoformat(timespec="seconds"),
            "preset": preset,
        }
        try:
            path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            self._send_json({"status": "ok", "filename": filename})
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_recommend(self):
        """Train on an SWF trace and emit a recommendation-adjusted SWF."""
        body = self._read_json_body()
        if body is None:
            return

        swf_file = str(body.get("swf_file") or body.get("job_trace") or "").strip()
        if not swf_file:
            self._send_json({"error": "swf_file is required"}, 400)
            return

        swf_path = INPUT_DIR / swf_file
        if not swf_path.exists():
            self._send_json({"error": f"File not found: {swf_file}"}, 404)
            return

        try:
            import recommend as rec
        except ModuleNotFoundError as exc:
            self._send_json({
                "error": (
                    "Recommendation feature unavailable: "
                    f"{exc}. Interpreter: {sys.executable}. "
                    "Install numpy for this interpreter, e.g. "
                    f"`{sys.executable} -m pip install --user numpy`."
                )
            }, 500)
            return

        try:
            result = rec.generate_recommendation(
                swf_path,
                INPUT_DIR,
                RECOMMENDATIONS_DIR,
                extra_buffer=float(body.get("user_p90_buffer", 0.0) or 0.0),
                test_fraction=float(body.get("test_fraction", 0.2) or 0.2),
                ridge_alpha=float(body.get("ridge_alpha", 8.0) or 8.0),
            )
            self._send_json(result)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_snapshot_preview(self):
        """Replay a completed run to a chosen time and fork a what-if scenario."""
        body = self._read_json_body()
        if body is None:
            return

        output_name = _safe_output_stem(body.get("run_name"))
        if not output_name:
            self._send_json({"error": "run_name is required"}, 400)
            return

        cfg_path = None
        output_json = None
        try:
            params = pp._load_run_params(output_name) or {}
            jobs = _raw_jobs_cache_get(output_name)
            cfg_path, output_json = _build_snapshot_preview_config(output_name, params, jobs, body)
            engine_bin = _resolve_engine_binary()
            cmd = _build_preview_command(engine_bin, cfg_path)
            proc = subprocess.run(
                cmd,
                cwd=str(BASE_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            if proc.returncode != 0:
                self._send_json({
                    "error": f"Snap Shot preview failed with code {proc.returncode}",
                    "log": proc.stdout,
                }, 500)
                return

            if not output_json or not output_json.exists():
                self._send_json({"error": "Snap Shot preview did not produce output."}, 500)
                return

            result = json.loads(output_json.read_text(encoding="utf-8"))
            result["run_name"] = output_name
            result["params"] = params
            self._send_json(result)
        except FileNotFoundError as exc:
            self._send_json({"error": str(exc)}, 404)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)
        finally:
            for path in (cfg_path, output_json):
                if isinstance(path, Path):
                    try:
                        path.unlink(missing_ok=True)
                    except Exception:
                        pass

    def _api_snapshot_forks_list(self, query: str):
        try:
            params = urllib.parse.parse_qs(query or "")
            limit = max(1, min(300, _norm_int((params.get("limit") or ["120"])[0], 120)))
            self._send_json({"forks": _list_snapshot_forks(limit=limit)})
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_snapshot_forks_get(self, fork_id_raw: str):
        try:
            path = _snapshot_fork_record_path(urllib.parse.unquote(fork_id_raw or ""))
            if not path.exists():
                self._send_json({"error": "Fork not found."}, 404)
                return
            record = json.loads(path.read_text(encoding="utf-8"))
            record["summary"] = _snapshot_fork_summary(record, path)
            self._send_json(record)
        except FileNotFoundError as exc:
            self._send_json({"error": str(exc)}, 404)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_snapshot_forks_save(self):
        body = self._read_json_body()
        if body is None:
            return

        try:
            request = body.get("request") if isinstance(body.get("request"), dict) else None
            result = body.get("result") if isinstance(body.get("result"), dict) else None
            run_name = _safe_output_stem(body.get("run_name") or (request or {}).get("run_name") or (result or {}).get("run_name"))
            if not run_name:
                self._send_json({"error": "run_name is required to save a fork."}, 400)
                return

            fork_name = str(body.get("name") or "").strip()
            created_at = datetime.now().isoformat(timespec="seconds")
            token = hashlib.sha1(json.dumps({
                "run_name": run_name,
                "snapshot_time": (request or {}).get("snapshot_time"),
                "preview_policy": (request or {}).get("preview_policy"),
                "force_job_id": (request or {}).get("force_job_id"),
                "selected_job_id": body.get("selected_job_id"),
                "created_at": created_at,
            }, sort_keys=True).encode("utf-8")).hexdigest()[:10]
            fork_id = f"fork_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{token}"
            record = {
                "id": fork_id,
                "name": fork_name,
                "created_at": created_at,
                "run_name": run_name,
                "selected_job_id": body.get("selected_job_id"),
                "request": request or {},
                "result": result or {},
            }

            path = _snapshot_fork_record_path(fork_id)
            path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
            self._send_json({
                "ok": True,
                "fork_id": fork_id,
                "fork": _snapshot_fork_summary(record, path),
            })
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_delete_results_preview(self, query: str):
        """Preview runs/files that would be deleted for a keyword."""
        try:
            params = urllib.parse.parse_qs(query or "")
            keyword = str((params.get("keyword") or [""])[0]).strip()
            if not keyword:
                self._send_json({"error": "keyword query parameter is required"}, 400)
                return

            try:
                limit = int((params.get("limit") or ["80"])[0])
            except Exception:
                limit = 80
            limit = max(1, min(300, limit))

            matched_runs, run_to_files = _find_matching_result_runs(keyword)
            total_result_files = sum(len(run_to_files.get(run_name, [])) for run_name in matched_runs)
            total_timeseries_files = 0
            for run_name in matched_runs:
                if (TIMESERIES_DIR / f"{run_name}.json").exists():
                    total_timeseries_files += 1
                if (TIMESERIES_DIR / f"{run_name}_scatter.json").exists():
                    total_timeseries_files += 1

            summary_rows = 0
            worklog_rows = 0
            if matched_runs:
                matched_set = set(matched_runs)
                summary = _load_json_file(SUMMARY_JSON, [])
                worklog = _load_json_file(WORKLOG_JSON, [])
                if isinstance(summary, list):
                    summary_rows = sum(
                        1 for row in summary
                        if str((row or {}).get("run_name") or "") in matched_set
                    )
                if isinstance(worklog, list):
                    worklog_rows = sum(
                        1 for row in worklog
                        if str((row or {}).get("run_name") or "") in matched_set
                    )

            self._send_json({
                "status": "ok",
                "keyword": keyword,
                "total_matches": len(matched_runs),
                "preview_runs": matched_runs[:limit],
                "has_more": len(matched_runs) > limit,
                "result_files": total_result_files,
                "timeseries_files": total_timeseries_files,
                "summary_rows": summary_rows,
                "worklog_rows": worklog_rows,
            })
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def _api_delete_results(self):
        """Delete result artifacts whose run names match a keyword."""
        body = self._read_json_body()
        if body is None:
            return

        keyword = str(body.get("keyword", "")).strip()
        if not keyword:
            self._send_json({"error": "keyword is required"}, 400)
            return

        if body.get("confirm_phrase") != "DELETE_MATCHING_RESULTS":
            self._send_json({"error": "Missing or invalid confirmation phrase"}, 400)
            return

        with _runs_lock:
            active = [rid for rid, r in ACTIVE_RUNS.items() if r.get("status") in {"starting", "running"}]
        if active:
            self._send_json({
                "error": "Cannot delete results while runs are active. Cancel running jobs first.",
                "active_runs": active,
            }, 409)
            return

        stats = _delete_matching_results(keyword)
        if stats.get("errors"):
            self._send_json({
                "error": "Deletion completed with some errors.",
                "keyword": keyword,
                "matched_runs": stats.get("matched_runs", []),
                "deleted": {
                    "result_files": stats.get("deleted_result_files", 0),
                    "timeseries_files": stats.get("deleted_timeseries_files", 0),
                    "run_cache_files": stats.get("deleted_run_cache_files", 0),
                    "summary_rows": stats.get("removed_summary_rows", 0),
                    "worklog_rows": stats.get("removed_worklog_rows", 0),
                    "active_runs": stats.get("removed_active_runs", 0),
                },
                "details": stats.get("errors", []),
            }, 500)
            return

        self._send_json({
            "status": "ok",
            "keyword": keyword,
            "matched_runs": stats.get("matched_runs", []),
            "deleted": {
                "result_files": stats.get("deleted_result_files", 0),
                "timeseries_files": stats.get("deleted_timeseries_files", 0),
                "run_cache_files": stats.get("deleted_run_cache_files", 0),
                "summary_rows": stats.get("removed_summary_rows", 0),
                "worklog_rows": stats.get("removed_worklog_rows", 0),
                "active_runs": stats.get("removed_active_runs", 0),
            },
        })

    def _api_clear_results(self):
        """Delete all simulation outputs and derived dashboard result files."""
        body = self._read_json_body()
        if body is None:
            return

        if body.get("confirm_phrase") != "DELETE_ALL_RESULTS":
            self._send_json({"error": "Missing or invalid confirmation phrase"}, 400)
            return

        with _runs_lock:
            active = [rid for rid, r in ACTIVE_RUNS.items() if r.get("status") in {"starting", "running"}]
        if active:
            self._send_json({
                "error": "Cannot clear results while runs are active. Cancel running jobs first.",
                "active_runs": active,
            }, 409)
            return

        timeseries_dir = TIMESERIES_DIR
        run_cache_dir = RUN_CACHE_DIR
        native_results_dir = NATIVE_RESULTS_DIR
        engine_runs_dir = ENGINE_RUNS_DIR
        summary_json = SUMMARY_JSON
        worklog_json = WORKLOG_JSON

        deleted_results, errs_a = _clear_directory(RESULTS_DIR)
        deleted_timeseries, errs_b = _clear_directory(timeseries_dir)
        deleted_run_cache, errs_c = _clear_directory(run_cache_dir)
        deleted_native_results, errs_d = _clear_directory(native_results_dir)
        deleted_engine_runs, errs_e = _clear_directory(engine_runs_dir)

        deleted_meta = 0
        meta_errors = []
        for p in (summary_json, worklog_json):
            try:
                if p.exists():
                    p.unlink()
                    deleted_meta += 1
            except Exception as exc:
                meta_errors.append(f"{p.name}: {exc}")

        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        timeseries_dir.mkdir(parents=True, exist_ok=True)
        run_cache_dir.mkdir(parents=True, exist_ok=True)
        native_results_dir.mkdir(parents=True, exist_ok=True)
        engine_runs_dir.mkdir(parents=True, exist_ok=True)

        with _run_payload_lock:
            RUN_PAYLOAD_CACHE.clear()
        with _run_compute_locks_lock:
            _run_compute_locks.clear()
        with _run_warm_lock:
            _run_warm_inflight.clear()
        with _historical_lock:
            _historical_payload_cache["summary_mtime_ns"] = -1
            _historical_payload_cache["worklog_mtime_ns"] = -1
            _historical_payload_cache["payload"] = {"summary": [], "worklog": []}
            _historical_stale_cache["checked_at"] = 0.0
            _historical_stale_cache["value"] = False

        with _runs_lock:
            ACTIVE_RUNS.clear()

        all_errors = errs_a + errs_b + errs_c + errs_d + errs_e + meta_errors
        if all_errors:
            self._send_json({
                "error": "Result cleanup completed with errors.",
                "details": all_errors,
                "deleted": {
                    "results_entries": deleted_results,
                    "timeseries_entries": deleted_timeseries,
                    "run_cache_entries": deleted_run_cache,
                    "native_result_entries": deleted_native_results,
                    "engine_run_entries": deleted_engine_runs,
                    "metadata_files": deleted_meta,
                },
            }, 500)
            return

        self._send_json({
            "status": "ok",
            "deleted": {
                "results_entries": deleted_results,
                "timeseries_entries": deleted_timeseries,
                "run_cache_entries": deleted_run_cache,
                "native_result_entries": deleted_native_results,
                "engine_run_entries": deleted_engine_runs,
                "metadata_files": deleted_meta,
            },
        })

    def _api_cancel(self):
        """Kill a running simulation subprocess."""
        body = self._read_json_body()
        if body is None:
            return
        run_id = body.get("run_id")
        with _runs_lock:
            run = ACTIVE_RUNS.get(run_id)
        if run and run.get("pid"):
            try:
                os.kill(run["pid"], signal.SIGTERM)
                with _runs_lock:
                    ACTIVE_RUNS[run_id]["status"] = "cancelled"
                    ACTIVE_RUNS[run_id]["stage"] = "Cancelled by user"
                    ACTIVE_RUNS[run_id]["finished_at"] = time.time()
                self._send_json({"cancelled": run_id})
            except Exception as exc:
                self._send_json({"error": str(exc)}, 500)
        else:
            self._send_json({"error": "Run not found"}, 404)

    # --- Helpers ---

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length))
        except Exception as exc:
            self._send_json({"error": f"Bad JSON: {exc}"}, 400)
            return None

    def _send_json(self, data, code: int = 200):
        body = json.dumps(data).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Client closed the socket before response completed.
            pass

    def log_message(self, fmt, *args):
        # Only log API calls and >=400 errors - suppress routine static file GETs.
        blob = " ".join(str(a) for a in args)
        if "/api/" in blob:
            super().log_message(fmt, *args)
            return

        if len(args) > 1:
            try:
                code = int(args[1])
            except Exception:
                code = 0
            if code >= 400:
                super().log_message(fmt, *args)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main():
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    MAINT_DIR.mkdir(parents=True, exist_ok=True)
    ENGINE_RUNS_DIR.mkdir(parents=True, exist_ok=True)
    NATIVE_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    PRESET_DIR.mkdir(parents=True, exist_ok=True)
    DASH_DATA_DIR.mkdir(parents=True, exist_ok=True)
    TIMESERIES_DIR.mkdir(parents=True, exist_ok=True)
    RUN_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    RECOMMENDATIONS_DIR.mkdir(parents=True, exist_ok=True)
    WORKLOG_SWF_DIR.mkdir(parents=True, exist_ok=True)

    # Pre-process existing results if summary/worklog index is stale.
    try:
        if _is_historical_index_stale():
            print("Preprocessing existing results...")
            pp.main()
    except Exception as exc:
        print(f"  Warning: {exc}")

    os.chdir(DASHBOARD_DIR)
    server = http.server.ThreadingHTTPServer(("", PORT), DashboardHandler)
    url = f"http://localhost:{PORT}"
    print(f"\n{PROJECT_NAME} Dashboard running at {url}")
    print("Press Ctrl+C to stop.\n")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
