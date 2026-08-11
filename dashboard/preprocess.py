#!/usr/bin/env python3
"""Preprocess CQSim result files into JSON for the dashboard."""

import json
import math
import os
import re
import statistics
from datetime import datetime
from pathlib import Path

_DEFAULT_DASHBOARD_DIR = Path(__file__).resolve().parent
_DEFAULT_BASE_DIR = _DEFAULT_DASHBOARD_DIR.parent

BASE_DIR = Path(os.environ.get("CQSIM_BASE_DIR", str(_DEFAULT_BASE_DIR))).resolve()
RESULTS_DIR = BASE_DIR / "data" / "Results"
OUTPUT_DIR = Path(os.environ.get("CQSIM_DASH_DATA_DIR", str(_DEFAULT_DASHBOARD_DIR / "data"))).resolve()
TIMESERIES_DIR = OUTPUT_DIR / "timeseries"

def _safe_mean(values):
    return float(statistics.fmean(values)) if values else 0.0


def _percentile(values, pct):
    """Linear-interpolated percentile in [0, 100]."""
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


def _gini(values):
    """Gini coefficient for non-negative values."""
    vals = sorted(max(0.0, float(v)) for v in values)
    n = len(vals)
    if n == 0:
        return 0.0
    total = sum(vals)
    if total == 0:
        return 0.0
    weighted_sum = 0.0
    for i, v in enumerate(vals, start=1):
        weighted_sum += i * v
    return (2 * weighted_sum) / (n * total) - (n + 1) / n


def _as_float(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return float(default)


def _as_int(value, default=0):
    try:
        return int(value)
    except Exception:
        try:
            return int(float(value))
        except Exception:
            return int(default)


def _norm_token(value, default="default_config"):
    token = re.sub(r"[^A-Za-z0-9]+", "_", str(value or "").strip().lower()).strip("_")
    return token or default


def infer_policy_variant(params=None):
    """Infer scheduling-policy variant token from run params/config."""
    if not isinstance(params, dict):
        return "default_config"

    explicit = str(params.get("variant_label") or params.get("variant") or "").strip()
    if explicit:
        return _norm_token(explicit)

    alg = str(params.get("alg") or params.get("algorithm") or "").strip()
    if not alg:
        return "default_config"

    compact = re.sub(r"\s+", "", alg.lower())
    if compact == "w,+,2":
        return "weighted_wait2"
    if compact == "w":
        return "fifo_wait"
    if compact == "t":
        return "sjf"
    if compact == "-t":
        return "ljf"
    if compact == "w/t":
        return "wait_time_ratio"
    if "n*(w/(tift>0else1))**3" in compact:
        return "wfp_alcf"
    return _norm_token(alg, default="custom_policy")


def _load_run_params(run_name):
    """Load persisted run params from data/Results/<run>.meta.json, if present."""
    meta_path = RESULTS_DIR / f"{run_name}.meta.json"
    if not meta_path.exists():
        return None
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None

    if isinstance(payload.get("params"), dict):
        params = dict(payload.get("params"))
    else:
        params = dict(payload)

    if "algorithm" not in params and isinstance(payload.get("algorithm"), str):
        params["algorithm"] = payload.get("algorithm")
    if "alg" not in params and isinstance(payload.get("alg"), str):
        params["alg"] = payload.get("alg")
    if "variant_label" not in params and isinstance(payload.get("variant"), str):
        params["variant_label"] = payload.get("variant")
    return params


def parse_run_identity(run_name, params=None):
    """Infer system/variant/scenario from output stem and config params.

    Examples:
      aurora_norm                    -> system=aurora, trace_variant=norm
      aurora_p90__exp1               -> system=aurora, trace_variant=p90
      custom_trace__exp_20260217     -> system=custom_trace, trace_variant=custom
    Variant is scheduling-policy variant from input config (algorithm), not from file suffix.
    """
    core, _, raw_scenario = run_name.partition("__")
    scenario = raw_scenario.replace("_", " ").strip()

    core_low = core.lower()
    system = core
    trace_variant = "custom"
    if core_low.endswith("_p90"):
        system = core[:-4]
        trace_variant = "p90"
    elif core_low.endswith("_p95"):
        system = core[:-4]
        trace_variant = "p95"
    elif core_low.endswith("_norm"):
        system = core[:-5]
        trace_variant = "norm"

    variant = infer_policy_variant(params)
    if variant in {"unknown_config", "default_config"} and raw_scenario:
        first_token = raw_scenario.split("__")[0]
        token = _norm_token(first_token, default="")
        m = re.match(r"((weighted_wait2|fifo_wait|sjf|ljf|wait_time_ratio|wfp_alcf|custom_policy)(?:_bf\d+)?)", token)
        if m:
            variant = m.group(1)

    return {
        "run_name": run_name,
        "base_name": core,
        "system": system,
        "variant": variant,
        "trace_variant": trace_variant,
        "scenario": scenario,
    }


def _rescued_resource_group_key(summary):
    """Build a stable group key for baseline-vs-adjusted rescued-resource comparison."""
    return (
        str(summary.get("system", "")).strip().lower(),
        str(summary.get("trace_variant", "")).strip().lower(),
        str(summary.get("variant", "")).strip().lower(),
        str(summary.get("algorithm", "")).strip().lower(),
        _as_int(summary.get("backfill", 2), 2),
        _as_int(summary.get("win", 5), 5),
        _as_int(summary.get("read_num", -1), -1),
        _as_int(summary.get("start", 0), 0),
        _as_int(summary.get("anchor", 0), 0),
        _as_int(summary.get("ad_bf", 0), 0),
        _as_int(summary.get("ad_win", 0), 0),
        _as_int(summary.get("ad_alg", 0), 0),
    )


def _idle_resource_seconds(summary):
    """Compute idle capacity-time proxy (fraction * makespan)."""
    util = _as_float(summary.get("avg_utilization", 0.0), 0.0)
    util = min(max(util, 0.0), 1.0)
    makespan = max(_as_float(summary.get("makespan", 0.0), 0.0), 0.0)
    return max(0.0, (1.0 - util) * makespan)


def annotate_rescued_resource(summaries):
    """Annotate rows with rescued resource percentage vs same-config baseline.

    Rescued resource proxy:
      rescued_pct = max(0, idle_baseline - idle_run) / idle_baseline * 100
      where idle = (1 - avg_utilization) * makespan
      baseline = same config group with cluster_fraction ~= 1.0
    """
    if not summaries:
        return summaries

    groups = {}
    for row in summaries:
        if not isinstance(row, dict):
            continue
        row["rescued_resource_pct"] = 0.0
        row["rescued_resource_idle_saved"] = 0.0
        row["rescued_resource_baseline_idle"] = 0.0
        row["rescued_resource_baseline_run"] = ""
        groups.setdefault(_rescued_resource_group_key(row), []).append(row)

    for rows in groups.values():
        baselines = []
        for row in rows:
            frac = _as_float(row.get("cluster_fraction", 1.0), 1.0)
            if abs(frac - 1.0) <= 1e-6:
                baselines.append(row)
        if not baselines:
            continue

        # Prefer newest baseline entry if there are multiple for the same config.
        baseline = sorted(baselines, key=lambda r: str(r.get("timestamp", "")))[-1]
        idle_base = _idle_resource_seconds(baseline)
        if idle_base <= 0:
            continue

        baseline_name = str(baseline.get("run_name", ""))
        for row in rows:
            idle_run = _idle_resource_seconds(row)
            saved = max(0.0, idle_base - idle_run)
            pct = (saved / idle_base) * 100.0
            row["rescued_resource_pct"] = round(pct, 2)
            row["rescued_resource_idle_saved"] = round(saved, 2)
            row["rescued_resource_baseline_idle"] = round(idle_base, 2)
            row["rescued_resource_baseline_run"] = baseline_name

    return summaries


def parse_rst(filepath):
    """Parse a .rst file into a list of job dicts."""
    jobs = []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split(";")
            if len(parts) < 9:
                continue
            try:
                jobs.append({
                    "job_id": int(parts[0]),
                    "reqProc": int(parts[1]),
                    "reqTime": float(parts[3]),
                    "run": float(parts[4]),
                    "wait": float(parts[5]),
                    "submit": float(parts[6]),
                    "start": float(parts[7]),
                    "end": float(parts[8]),
                })
            except (ValueError, IndexError):
                continue
    return jobs


def parse_ult(filepath):
    """Parse a .ult file into time-series arrays."""
    times, utilization, queue_depth, queue_size = [], [], [], []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split(";")
            if len(parts) < 4:
                continue
            try:
                # Event log format is: start_date ; event ; virtual_time ; key=value...
                # Use virtual_time (index 2) per design docs.
                t = float(parts[2])
                uti, wn, ws = 0.0, 0, 0
                for m in parts[3].split():
                    if m.startswith("uti="):
                        uti = float(m[4:])
                    elif m.startswith("waitNum="):
                        wn = int(m[8:])
                    elif m.startswith("waitSize="):
                        ws = int(m[9:])
                times.append(t)
                utilization.append(round(uti, 4))
                queue_depth.append(wn)
                queue_size.append(ws)
            except (ValueError, IndexError):
                continue
    return times, utilization, queue_depth, queue_size


def downsample(times, *arrays):
    """Return full series (no downsampling)."""
    return [times] + list(arrays)


def compute_summary(jobs, utilization_series, queue_depth=None, queue_size=None):
    """Compute aggregate metrics from parsed job/system data."""
    if not jobs:
        return {}

    waits = [j["wait"] for j in jobs]
    runtimes = [j["run"] for j in jobs]
    req_times = [j["reqTime"] for j in jobs]
    turnarounds = [j["wait"] + j["run"] for j in jobs]

    slowdowns = []
    bounded_slowdowns = []
    for j in jobs:
        turnaround = j["wait"] + j["run"]
        slowdowns.append(turnaround / max(j["run"], 1.0))
        bounded_slowdowns.append(turnaround / max(j["run"], 10.0))

    submit_min = min(j["submit"] for j in jobs)
    end_max = max(j["end"] for j in jobs)
    makespan = max(end_max - submit_min, 0.0)
    throughput_day = (len(jobs) / makespan * 86400.0) if makespan > 0 else 0.0

    avg_uti = _safe_mean(utilization_series)
    peak_uti = max(utilization_series) if utilization_series else 0.0

    queue_depth = queue_depth or []
    queue_size = queue_size or []

    return {
        "total_jobs": len(jobs),
        "avg_wait": round(_safe_mean(waits), 2),
        "median_wait": round(_percentile(waits, 50), 2),
        "wait_p90": round(_percentile(waits, 90), 2),
        "wait_p95": round(_percentile(waits, 95), 2),
        "wait_p99": round(_percentile(waits, 99), 2),
        "max_wait": round(max(waits), 2),
        "wait_std": round(statistics.pstdev(waits) if len(waits) > 1 else 0.0, 2),
        "wait_gini": round(_gini(waits), 3),
        "avg_runtime": round(_safe_mean(runtimes), 1),
        "runtime_p90": round(_percentile(runtimes, 90), 1),
        "runtime_p95": round(_percentile(runtimes, 95), 1),
        "avg_req_runtime": round(_safe_mean(req_times), 1),
        "avg_turnaround": round(_safe_mean(turnarounds), 1),
        "turnaround_p95": round(_percentile(turnarounds, 95), 1),
        "avg_utilization": round(avg_uti, 4),
        "peak_utilization": round(peak_uti, 4),
        "utilization_std": round(statistics.pstdev(utilization_series) if len(utilization_series) > 1 else 0.0, 4),
        "idle_fraction": round(max(0.0, 1.0 - avg_uti), 4),
        "makespan": round(makespan, 1),
        "throughput_jobs_per_day": round(throughput_day, 2),
        "avg_slowdown": round(_safe_mean(slowdowns), 2),
        "avg_bounded_slowdown": round(_safe_mean(bounded_slowdowns), 2),
        "slowdown_p95": round(_percentile(slowdowns, 95), 2),
        "jobs_wait_under_1m_pct": round(sum(1 for w in waits if w <= 60.0) / len(waits) * 100.0, 2),
        "jobs_wait_under_10m_pct": round(sum(1 for w in waits if w <= 600.0) / len(waits) * 100.0, 2),
        "avg_queue_depth": round(_safe_mean(queue_depth), 2),
        "peak_queue_depth": int(max(queue_depth) if queue_depth else 0),
        "queue_depth_p95": round(_percentile(queue_depth, 95), 2),
        "avg_queue_size": round(_safe_mean(queue_size), 2),
        "peak_queue_size": int(max(queue_size) if queue_size else 0),
    }


def _fmt_seconds(s):
    """Format seconds as human-readable string for chart labels."""
    if s < 60:
        return f"{s:.0f}s"
    if s < 3600:
        return f"{s / 60:.1f}m"
    if s < 86400:
        return f"{s / 3600:.1f}h"
    return f"{s / 86400:.1f}d"


def compute_wait_by_runtime_buckets(jobs):
    """Group jobs into short/medium/long using data-driven runtime thresholds."""
    empty = {"count": 0, "avg_wait": 0, "median_wait": 0, "max_wait": 0, "avg_runtime": 0}
    if not jobs:
        return {"thresholds": [0, 0], "short": empty, "medium": empty, "long": empty}

    runtimes = [j["run"] for j in jobs]
    min_rt = min(runtimes)
    max_rt = max(runtimes)
    span = max_rt - min_rt
    if span == 0:
        t1 = t2 = min_rt
    else:
        t1 = min_rt + span / 3
        t2 = min_rt + 2 * span / 3

    bucket_waits = {"short": [], "medium": [], "long": []}
    bucket_runs = {"short": [], "medium": [], "long": []}
    for j in jobs:
        if j["run"] < t1:
            bucket_waits["short"].append(j["wait"])
            bucket_runs["short"].append(j["run"])
        elif j["run"] < t2:
            bucket_waits["medium"].append(j["wait"])
            bucket_runs["medium"].append(j["run"])
        else:
            bucket_waits["long"].append(j["wait"])
            bucket_runs["long"].append(j["run"])

    result = {"thresholds": [round(t1, 1), round(t2, 1)]}
    for name, waits in bucket_waits.items():
        runs = bucket_runs[name]
        if waits:
            result[name] = {
                "count": len(waits),
                "avg_wait": round(_safe_mean(waits), 2),
                "median_wait": round(_percentile(waits, 50), 2),
                "max_wait": round(max(waits), 2),
                "avg_runtime": round(_safe_mean(runs), 2),
            }
        else:
            result[name] = dict(empty)
    return result


def compute_runtime_distribution(jobs, n_bins=12):
    """Histogram of actual job runtimes using log-spaced bins."""
    if not jobs:
        return {"labels": [], "edges": [], "counts": []}

    runtimes = [j["run"] for j in jobs]
    min_rt = max(1.0, min(runtimes))
    max_rt = max(runtimes)

    if max_rt <= min_rt:
        return {
            "labels": [_fmt_seconds(min_rt)],
            "edges": [round(min_rt, 1), round(min_rt + 1, 1)],
            "counts": [len(jobs)],
        }

    log_min = math.log10(min_rt)
    log_max = math.log10(max_rt)
    edges = [10 ** (log_min + i * (log_max - log_min) / n_bins) for i in range(n_bins + 1)]

    counts = [0] * n_bins
    for rt in runtimes:
        placed = False
        for i in range(n_bins - 1):
            if rt < edges[i + 1]:
                counts[i] += 1
                placed = True
                break
        if not placed:
            counts[n_bins - 1] += 1

    labels = [f"{_fmt_seconds(edges[i])}-{_fmt_seconds(edges[i + 1])}" for i in range(n_bins)]
    return {"labels": labels, "edges": [round(e, 1) for e in edges], "counts": counts}


def compute_wait_by_runtime(jobs, runtime_dist):
    """Average wait by runtime bin, aligned to runtime_distribution bins."""
    if not jobs:
        return {"labels": [], "avg_wait": [], "job_counts": []}
    if not isinstance(runtime_dist, dict):
        return {"labels": [], "avg_wait": [], "job_counts": []}

    labels = list(runtime_dist.get("labels") or [])
    edges = list(runtime_dist.get("edges") or [])
    if not labels or len(edges) != len(labels) + 1:
        return {"labels": [], "avg_wait": [], "job_counts": []}

    sums = [0.0] * len(labels)
    counts = [0] * len(labels)

    for j in jobs:
        try:
            run = max(0.0, float(j.get("run", 0.0)))
            wait = max(0.0, float(j.get("wait", 0.0)))
        except Exception:
            continue

        idx = len(labels) - 1
        for i in range(len(labels) - 1):
            if run < edges[i + 1]:
                idx = i
                break

        sums[idx] += wait
        counts[idx] += 1

    avg_wait = [round((sums[i] / counts[i]) if counts[i] else 0.0, 2) for i in range(len(labels))]
    return {
        "labels": labels,
        "avg_wait": avg_wait,
        "job_counts": counts,
    }


def compute_wait_distribution(jobs, n_bins=12):
    """Histogram of wait times using a zero bucket plus log-spaced positive bins."""
    if not jobs:
        return {"labels": [], "edges": [], "counts": []}

    waits = [max(0.0, float(j.get("wait", 0.0))) for j in jobs]
    zero_count = sum(1 for w in waits if w <= 0.0)
    positive = [w for w in waits if w > 0.0]

    if not positive:
        return {"labels": ["0s"], "edges": [0.0, 1.0], "counts": [len(waits)]}

    min_w = max(1.0, min(positive))
    max_w = max(positive)
    pos_bins = max(1, n_bins - 1)

    if max_w <= min_w:
        labels = ["0s", f"{_fmt_seconds(min_w)}-{_fmt_seconds(min_w + 1)}"]
        return {"labels": labels, "edges": [0.0, round(min_w, 1), round(min_w + 1, 1)], "counts": [zero_count, len(positive)]}

    log_min = math.log10(min_w)
    log_max = math.log10(max_w)
    pos_edges = [10 ** (log_min + i * (log_max - log_min) / pos_bins) for i in range(pos_bins + 1)]

    pos_counts = [0] * pos_bins
    for w in positive:
        placed = False
        for i in range(pos_bins - 1):
            if w < pos_edges[i + 1]:
                pos_counts[i] += 1
                placed = True
                break
        if not placed:
            pos_counts[pos_bins - 1] += 1

    labels = ["0s"] + [f"{_fmt_seconds(pos_edges[i])}-{_fmt_seconds(pos_edges[i + 1])}" for i in range(pos_bins)]
    counts = [zero_count] + pos_counts
    edges = [0.0] + [round(e, 1) for e in pos_edges]
    return {"labels": labels, "edges": edges, "counts": counts}


def compute_wait_by_job_size(jobs):
    """Wait-time metrics by requested processor bucket."""
    if not jobs:
        return {
            "labels": [],
            "avg_wait_nonzero": [],
            "p95_wait_nonzero": [],
            "waited_jobs": [],
            "total_jobs": [],
            "waited_pct": [],
        }

    proc_edges = [1, 8, 32, 128, 512, 2048, 8192, 32768]
    labels = []
    avg_wait_nonzero = []
    p95_wait_nonzero = []
    waited_jobs = []
    total_jobs = []
    waited_pct = []

    for i in range(len(proc_edges) - 1):
        lo, hi = proc_edges[i], proc_edges[i + 1]
        waits = []
        for j in jobs:
            try:
                req = int(float(j.get("reqProc", 0)))
                wait = max(0.0, float(j.get("wait", 0.0)))
            except Exception:
                continue
            in_bucket = (req >= lo and req < hi) if i < len(proc_edges) - 2 else (req >= lo and req <= hi)
            if in_bucket:
                waits.append(wait)

        if not waits:
            continue

        waited = [w for w in waits if w > 0.0]
        waited_n = len(waited)
        total_n = len(waits)
        labels.append(f"{_fmt_procs(lo)}-{_fmt_procs(hi)}")
        avg_wait_nonzero.append(round(_safe_mean(waited) if waited else 0.0, 2))
        p95_wait_nonzero.append(round(_percentile(waited, 95) if waited else 0.0, 2))
        waited_jobs.append(waited_n)
        total_jobs.append(total_n)
        waited_pct.append(round((waited_n / total_n) * 100.0 if total_n else 0.0, 2))

    return {
        "labels": labels,
        "avg_wait_nonzero": avg_wait_nonzero,
        "p95_wait_nonzero": p95_wait_nonzero,
        "waited_jobs": waited_jobs,
        "total_jobs": total_jobs,
        "waited_pct": waited_pct,
    }


def _fmt_procs(v):
    """Format processor counts for compact axis labels."""
    x = int(round(v))
    if x >= 1_000_000:
        return f"{x / 1_000_000:.1f}M"
    if x >= 1_000:
        return f"{x / 1_000:.1f}K"
    return str(x)


def compute_job_size_distribution(jobs):
    """Histogram of requested processors (job size)."""
    if not jobs:
        return {"labels": [], "edges": [], "counts": [], "total_jobs": 0}

    reqs = []
    for j in jobs:
        try:
            req = max(1, int(float(j.get("reqProc", 0))))
            reqs.append(req)
        except Exception:
            continue

    if not reqs:
        return {"labels": [], "edges": [], "counts": [], "total_jobs": 0}

    max_req = max(reqs)
    edges = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]
    while max_req > edges[-1] and len(edges) < 24:
        edges.append(edges[-1] * 2)

    counts = [0] * (len(edges) - 1)
    for req in reqs:
        placed = False
        for i in range(len(edges) - 1):
            lo, hi = edges[i], edges[i + 1]
            if i < len(edges) - 2:
                if req >= lo and req < hi:
                    counts[i] += 1
                    placed = True
                    break
            else:
                if req >= lo and req <= hi:
                    counts[i] += 1
                    placed = True
                    break
        if not placed:
            counts[-1] += 1

    labels = [f"{_fmt_procs(edges[i])}-{_fmt_procs(edges[i + 1])}" for i in range(len(edges) - 1)]
    return {
        "labels": labels,
        "edges": edges,
        "counts": counts,
        "total_jobs": len(reqs),
    }


def compute_wait_timeline(jobs, bins=24):
    """Wait percentile trend over submission-time bins."""
    if not jobs:
        return {"labels": [], "p50": [], "p90": [], "p99": [], "avg": [], "count": []}

    submit_min = min(j["submit"] for j in jobs)
    submit_max = max(j["submit"] for j in jobs)
    if submit_max <= submit_min:
        waits = [j["wait"] for j in jobs]
        return {
            "labels": ["0s"],
            "p50": [round(_percentile(waits, 50), 2)],
            "p90": [round(_percentile(waits, 90), 2)],
            "p99": [round(_percentile(waits, 99), 2)],
            "avg": [round(_safe_mean(waits), 2)],
            "count": [len(waits)],
        }

    span = submit_max - submit_min
    step = span / bins
    by_bin = [[] for _ in range(bins)]

    for j in jobs:
        idx = int((j["submit"] - submit_min) / step)
        if idx >= bins:
            idx = bins - 1
        by_bin[idx].append(j["wait"])

    labels, p50, p90, p99, avg, count = [], [], [], [], [], []
    for i, waits in enumerate(by_bin):
        # Use bin-start offset so timeline begins at 0s and is easier to read.
        offset = i * step
        labels.append(_fmt_seconds(offset))
        if waits:
            p50.append(round(_percentile(waits, 50), 2))
            p90.append(round(_percentile(waits, 90), 2))
            p99.append(round(_percentile(waits, 99), 2))
            avg.append(round(_safe_mean(waits), 2))
            count.append(len(waits))
        else:
            p50.append(0.0)
            p90.append(0.0)
            p99.append(0.0)
            avg.append(0.0)
            count.append(0)

    return {
        "labels": labels,
        "p50": p50,
        "p90": p90,
        "p99": p99,
        "avg": avg,
        "count": count,
    }


def compute_utilization_distribution(utilization_series, n_bins=10):
    """Histogram of utilization percentages over time samples."""
    if not utilization_series:
        return {"labels": [], "counts": []}

    counts = [0] * n_bins
    for u in utilization_series:
        pct = max(0.0, min(100.0, float(u) * 100.0))
        idx = min(n_bins - 1, int(pct / (100.0 / n_bins)))
        counts[idx] += 1

    labels = []
    for i in range(n_bins):
        lo = int(i * (100 / n_bins))
        hi = int((i + 1) * (100 / n_bins))
        labels.append(f"{lo}-{hi}%")
    return {"labels": labels, "counts": counts}


def compute_proc_wait_heatmap(jobs):
    """Matrix: avg wait by requested-proc bucket and runtime bucket."""
    if not jobs:
        return {"columns": [], "column_labels": [], "rows": [], "max_avg_wait": 0.0}

    proc_edges = [1, 8, 32, 128, 512, 2048, 8192, 32768]
    runtimes = [j["run"] for j in jobs]
    min_rt, max_rt = min(runtimes), max(runtimes)
    t1 = min_rt + (max_rt - min_rt) / 3.0
    t2 = min_rt + 2.0 * (max_rt - min_rt) / 3.0

    def rt_bucket(run_s):
        if run_s < t1:
            return 0
        if run_s < t2:
            return 1
        return 2

    columns = ["short", "medium", "long"]
    column_labels = [
        f"Short (<{_fmt_seconds(t1)})",
        f"Medium ({_fmt_seconds(t1)}-{_fmt_seconds(t2)})",
        f"Long (>{_fmt_seconds(t2)})",
    ]

    rows = []
    max_cell = 0.0
    for i in range(len(proc_edges) - 1):
        lo, hi = proc_edges[i], proc_edges[i + 1]
        label = f"{lo}-{hi}"
        waits_by_col = [[], [], []]

        for j in jobs:
            req = j["reqProc"]
            in_bucket = (req >= lo and req < hi) if i < len(proc_edges) - 2 else (req >= lo and req <= hi)
            if not in_bucket:
                continue
            waits_by_col[rt_bucket(j["run"])].append(j["wait"])

        avg_wait = []
        counts = []
        for waits in waits_by_col:
            c = len(waits)
            counts.append(c)
            v = round(_safe_mean(waits), 2) if c else 0.0
            avg_wait.append(v)
            max_cell = max(max_cell, v)

        rows.append({
            "label": label,
            "avg_wait": avg_wait,
            "counts": counts,
        })

    return {
        "columns": columns,
        "column_labels": column_labels,
        "rows": rows,
        "max_avg_wait": round(max_cell, 2),
    }


def _build_violin_profile(waits, n_bins=56):
    """Build a smoothed wait-time density profile from raw wait values."""
    clean = [max(0.0, float(w)) for w in waits if w is not None]
    if not clean:
        return {
            "job_count": 0,
            "clip_wait": 0.0,
            "max_wait": 0.0,
            "tail_clipped_jobs": 0,
            "quantiles": {},
            "points": [],
        }

    max_wait = max(clean)
    positive = [w for w in clean if w > 0]
    zero_wait_pct = (sum(1 for w in clean if w <= 0) / len(clean)) * 100.0 if clean else 0.0

    clip_wait = _percentile(clean, 99.5)
    clip_source = "p99.5_all"
    if clip_wait <= 0:
        # Zero-inflated case (most waits are exactly zero):
        # build the violin body from non-zero waits instead of max tail.
        if positive:
            clip_wait = _percentile(positive, 90)
            if clip_wait <= 0:
                clip_wait = max(positive)
            clip_source = "p90_nonzero"
        else:
            clip_wait = 1.0
            clip_source = "fallback_1s"
    clip_wait = max(1.0, clip_wait)

    # Keep the body readable on long-tail traces by clipping only the top tail.
    hist = [0] * n_bins
    tail_clipped = 0
    for w in clean:
        if w > clip_wait:
            tail_clipped += 1
            idx = n_bins - 1
        else:
            idx = int((w / clip_wait) * n_bins) if clip_wait > 0 else 0
            if idx >= n_bins:
                idx = n_bins - 1
        hist[idx] += 1

    # Light smoothing to remove jagged bin edges.
    smooth = []
    for i in range(n_bins):
        lo = max(0, i - 2)
        hi = min(n_bins - 1, i + 2)
        window = hist[lo:hi + 1]
        smooth.append(_safe_mean(window))

    # For highly zero-inflated traces, bleed a small amount of zero-mass upward
    # so the rendered body is not a single needle at y=0.
    if hist and hist[0] > 0 and zero_wait_pct >= 95.0:
        bleed = hist[0] * 0.22
        for i in range(1, min(n_bins, 9)):
            smooth[i] += bleed * math.exp(-i / 2.0)

    peak = max(smooth) if smooth else 0.0
    if peak <= 0:
        peak = 1.0

    points = []
    for i, c in enumerate(smooth):
        y0 = (i / n_bins) * clip_wait
        y1 = ((i + 1) / n_bins) * clip_wait
        points.append({
            "y0": round(y0, 1),
            "y1": round(y1, 1),
            "mid": round((y0 + y1) * 0.5, 1),
            "density": round(max((c / peak) ** 0.65, 0.06 if hist[i] > 0 else 0.0), 6),
            "count": int(hist[i]),
        })

    quantiles = {
        "q05": round(_percentile(clean, 5), 2),
        "q10": round(_percentile(clean, 10), 2),
        "q25": round(_percentile(clean, 25), 2),
        "q50": round(_percentile(clean, 50), 2),
        "q75": round(_percentile(clean, 75), 2),
        "q90": round(_percentile(clean, 90), 2),
        "q95": round(_percentile(clean, 95), 2),
        "q99": round(_percentile(clean, 99), 2),
        "mean": round(_safe_mean(clean), 2),
    }

    return {
        "job_count": len(clean),
        "clip_wait": round(clip_wait, 2),
        "clip_source": clip_source,
        "zero_wait_pct": round(zero_wait_pct, 2),
        "max_wait": round(max_wait, 2),
        "tail_clipped_jobs": tail_clipped,
        "quantiles": quantiles,
        "points": points,
    }


def compute_wait_violin(jobs, n_bins=56):
    """Legacy single-violin payload (kept for compatibility)."""
    waits = [j["wait"] for j in jobs] if jobs else []
    return _build_violin_profile(waits, n_bins=n_bins)


def compute_wait_violin_by_runtime(jobs, n_bins=56):
    """Three violins by runtime size bucket: small, medium, large."""
    if not jobs:
        return {"runtime_thresholds": [0.0, 0.0], "groups": [], "total_jobs": 0}

    runtimes = [j["run"] for j in jobs]
    min_rt = min(runtimes)
    max_rt = max(runtimes)
    span = max_rt - min_rt
    if span == 0:
        t1 = t2 = min_rt
    else:
        t1 = min_rt + span / 3.0
        t2 = min_rt + 2.0 * span / 3.0

    small_waits = []
    medium_waits = []
    large_waits = []
    for j in jobs:
        if j["run"] < t1:
            small_waits.append(j["wait"])
        elif j["run"] < t2:
            medium_waits.append(j["wait"])
        else:
            large_waits.append(j["wait"])

    def _group(key, label, waits, runtime_range):
        out = _build_violin_profile(waits, n_bins=n_bins)
        out.update({
            "key": key,
            "label": label,
            "runtime_range": runtime_range,
        })
        return out

    groups = [
        _group("small", "Small Runtime", small_waits, f"<{_fmt_seconds(t1)}"),
        _group("medium", "Medium Runtime", medium_waits, f"{_fmt_seconds(t1)}-{_fmt_seconds(t2)}"),
        _group("large", "Large Runtime", large_waits, f">{_fmt_seconds(t2)}"),
    ]

    return {
        "runtime_thresholds": [round(t1, 1), round(t2, 1)],
        "groups": groups,
        "total_jobs": len(jobs),
    }


def compute_jobsize_wait_heatmap(jobs):
    """Matrix heatmap: requested processor bucket (Y) vs wait-time bucket (X)."""
    if not jobs:
        return {
            "x_labels": [],
            "y_labels": [],
            "counts": [],
            "max_count": 0,
            "total_jobs": 0,
        }

    proc_edges = [1, 8, 32, 128, 512, 2048, 8192, 32768]
    wait_edges = [0, 60, 300, 900, 1800, 3600, 14400, 43200, 86400, 259200, 604800, 2592000]
    max_wait = max(max(0.0, float(j["wait"])) for j in jobs)
    if max_wait > wait_edges[-1]:
        wait_edges.append(max_wait)

    y_labels = [f"{proc_edges[i]}-{proc_edges[i + 1]}" for i in range(len(proc_edges) - 1)]
    x_labels = [f"{_fmt_seconds(wait_edges[i])}-{_fmt_seconds(wait_edges[i + 1])}" for i in range(len(wait_edges) - 1)]
    counts = [[0 for _ in range(len(wait_edges) - 1)] for _ in range(len(proc_edges) - 1)]

    def _proc_bucket(req):
        for i in range(len(proc_edges) - 1):
            lo, hi = proc_edges[i], proc_edges[i + 1]
            if i < len(proc_edges) - 2:
                if req >= lo and req < hi:
                    return i
            else:
                if req >= lo and req <= hi:
                    return i
        return len(proc_edges) - 2

    def _wait_bucket(wait_s):
        for i in range(len(wait_edges) - 1):
            lo, hi = wait_edges[i], wait_edges[i + 1]
            if i < len(wait_edges) - 2:
                if wait_s >= lo and wait_s < hi:
                    return i
            else:
                if wait_s >= lo and wait_s <= hi:
                    return i
        return len(wait_edges) - 2

    for j in jobs:
        y = _proc_bucket(int(j["reqProc"]))
        x = _wait_bucket(max(0.0, float(j["wait"])))
        counts[y][x] += 1

    max_count = max((max(row) if row else 0) for row in counts) if counts else 0
    return {
        "x_labels": x_labels,
        "y_labels": y_labels,
        "counts": counts,
        "max_count": int(max_count),
        "total_jobs": len(jobs),
    }


def build_top_wait_jobs(jobs, n=15):
    """Top-N jobs by queue wait."""
    top = sorted(jobs, key=lambda j: j["wait"], reverse=True)[:n]
    out = []
    for j in top:
        out.append({
            "job_id": j["job_id"],
            "wait": round(j["wait"], 2),
            "run": round(j["run"], 1),
            "reqProc": int(j["reqProc"]),
            "reqTime": round(j["reqTime"], 1),
            "submit": round(j["submit"], 1),
            "start": round(j["start"], 1),
        })
    return out


def build_insights(summary):
    """Generate short, human-readable diagnostic insights from summary stats."""
    if not summary:
        return []

    notes = []

    avg_uti = summary.get("avg_utilization", 0.0)
    if avg_uti >= 0.85:
        notes.append("Cluster ran near saturation; queueing pressure is likely capacity-driven.")
    elif avg_uti <= 0.25:
        notes.append("Cluster utilization stayed low; schedule policy may be leaving capacity idle.")

    wait_p95 = summary.get("wait_p95", 0.0)
    avg_wait = summary.get("avg_wait", 0.0)
    if wait_p95 > max(4 * avg_wait, 3600):
        notes.append("Wait-time tail is heavy: a minority of jobs see much longer delays than average.")

    wait_gini = summary.get("wait_gini", 0.0)
    if wait_gini >= 0.6:
        notes.append("Wait inequality is high (Gini >= 0.6), suggesting fairness issues across job classes.")

    under_1m = summary.get("jobs_wait_under_1m_pct", 0.0)
    if under_1m >= 85:
        notes.append("Most jobs start within 1 minute, indicating strong responsiveness for short queues.")

    peak_qd = summary.get("peak_queue_depth", 0)
    if peak_qd >= 500:
        notes.append("Queue depth spikes are large; backfill/window tuning could reduce burst congestion.")

    slowdown_p95 = summary.get("slowdown_p95", 1.0)
    if slowdown_p95 >= 10:
        notes.append("Tail slowdown is high (p95 >= 10x); long delays for selected jobs dominate QoS risk.")

    return notes[:6]


def _build_scatter(jobs):
    sampled = jobs
    return {
        "reqProc": [j["reqProc"] for j in sampled],
        "wait": [round(j["wait"], 2) for j in sampled],
        "run": [round(j["run"], 1) for j in sampled],
        "reqTime": [round(j["reqTime"], 1) for j in sampled],
    }


def preprocess_single_run(output_name, params=None):
    """Process one run and return complete payload for dashboard rendering."""
    rst_path = RESULTS_DIR / f"{output_name}.rst"
    ult_path = RESULTS_DIR / f"{output_name}.ult"
    run_params = params if isinstance(params, dict) else _load_run_params(output_name)

    jobs = parse_rst(str(rst_path))

    uti_series, qd_series, qs_series = [], [], []
    ts_data = None
    if ult_path.exists():
        times, uti, qd, qs = parse_ult(str(ult_path))
        uti_series, qd_series, qs_series = uti, qd, qs
        ds = downsample(times, uti, qd, qs)
        ts_data = {
            "time": ds[0],
            "utilization": ds[1],
            "queue_depth": ds[2],
            "queue_size": ds[3],
        }

    wait_timeline = compute_wait_timeline(jobs)
    if ts_data is None:
        ts_data = {
            "time": [],
            "utilization": [],
            "queue_depth": [],
            "queue_size": [],
        }
    ts_data["wait_timeline"] = wait_timeline

    summary = compute_summary(jobs, uti_series, qd_series, qs_series)
    identity = parse_run_identity(output_name, run_params)
    summary.update({
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "run_name": identity["run_name"],
        "system": identity["system"],
        "variant": identity["variant"],
        "trace_variant": identity["trace_variant"],
        "scenario": identity["scenario"],
        "algorithm": str((run_params or {}).get("algorithm", "")),
        "run_type": str((run_params or {}).get("run_type", "offline")),
        "cluster_fraction": round(_as_float((run_params or {}).get("cluster_fraction", 1.0), 1.0), 6),
        "backfill": _as_int((run_params or {}).get("backfill", 2), 2),
        "win": _as_int((run_params or {}).get("win", 5), 5),
        "read_num": _as_int((run_params or {}).get("read_num", -1), -1),
        "start": _as_int((run_params or {}).get("start", 0), 0),
        "anchor": _as_int((run_params or {}).get("anchor", 0), 0),
        "ad_bf": _as_int((run_params or {}).get("ad_bf", 0), 0),
        "ad_win": _as_int((run_params or {}).get("ad_win", 0), 0),
        "ad_alg": _as_int((run_params or {}).get("ad_alg", 0), 0),
    })

    # Compute rescued-resource metric against the most recent same-config baseline.
    historical_summary = []
    summary_path = OUTPUT_DIR / "summary.json"
    if summary_path.exists():
        try:
            payload = json.loads(summary_path.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                historical_summary = [x for x in payload if isinstance(x, dict)]
        except Exception:
            historical_summary = []

    candidates = [row for row in historical_summary if row.get("run_name") != summary.get("run_name")]
    candidates.append(summary)
    annotate_rescued_resource(candidates)

    wait_buckets = compute_wait_by_runtime_buckets(jobs)
    runtime_dist = compute_runtime_distribution(jobs)
    wait_by_runtime = compute_wait_by_runtime(jobs, runtime_dist)
    wait_dist = compute_wait_distribution(jobs)
    wait_by_size = compute_wait_by_job_size(jobs)
    job_size_dist = compute_job_size_distribution(jobs)
    util_dist = compute_utilization_distribution(uti_series)
    proc_wait_heatmap = compute_proc_wait_heatmap(jobs)
    wait_violin = compute_wait_violin(jobs)
    wait_violin_by_runtime = compute_wait_violin_by_runtime(jobs)
    jobsize_wait_heatmap = compute_jobsize_wait_heatmap(jobs)
    top_wait_jobs = build_top_wait_jobs(jobs)
    insights = build_insights(summary)
    scatter = _build_scatter(jobs) if jobs else {}

    if params:
        _append_worklog(output_name, summary, run_params or params, identity)

    return {
        "summary": summary,
        "timeseries": ts_data,
        "scatter": scatter,
        "wait_buckets": wait_buckets,
        "wait_by_runtime": wait_by_runtime,
        "wait_distribution": wait_dist,
        "wait_by_job_size": wait_by_size,
        "runtime_distribution": runtime_dist,
        "job_size_distribution": job_size_dist,
        "wait_timeline": wait_timeline,
        "utilization_distribution": util_dist,
        "proc_wait_heatmap": proc_wait_heatmap,
        "wait_violin": wait_violin,
        "wait_violin_by_runtime": wait_violin_by_runtime,
        "jobsize_wait_heatmap": jobsize_wait_heatmap,
        "top_wait_jobs": top_wait_jobs,
        "insights": insights,
        "meta": identity,
        "params": run_params or {},
    }


def _append_worklog(output_name, summary, params, identity):
    """Append a run entry to worklog.json."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    worklog_path = OUTPUT_DIR / "worklog.json"
    worklog = []
    if worklog_path.exists():
        try:
            with open(worklog_path) as f:
                worklog = json.load(f)
        except Exception:
            worklog = []

    bf_names = {0: "None", 1: "EASY", 2: "Conservative"}
    try:
        bf_id = int(params.get("backfill", 2))
    except Exception:
        bf_id = 2

    worklog.append({
        "id": len(worklog) + 1,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "run_name": identity["run_name"],
        "system": identity["system"],
        "variant": identity["variant"],
        "trace_variant": identity["trace_variant"],
        "scenario": identity["scenario"],
        "input_file": output_name,
        "backfill": bf_names.get(bf_id, "Conservative"),
        "algorithm": params.get("algorithm", ""),
        "run_type": str(params.get("run_type", "offline")),
        "win": params.get("win", 5),
        "read_num": params.get("read_num", -1),
        "total_jobs": summary.get("total_jobs", 0),
        "avg_wait": summary.get("avg_wait", 0),
        "wait_p95": summary.get("wait_p95", 0),
        "avg_utilization": summary.get("avg_utilization", 0),
        "peak_queue_depth": summary.get("peak_queue_depth", 0),
        "makespan": summary.get("makespan", 0),
    })
    with open(worklog_path, "w") as f:
        json.dump(worklog, f, indent=2)


def detect_runs(results_dir):
    """Detect all simulation runs from .rst files."""
    runs = []
    for rst_file in sorted(results_dir.glob("*.rst")):
        name = rst_file.stem
        run_params = _load_run_params(name)
        ident = parse_run_identity(name, run_params)
        ult_file = results_dir / f"{name}.ult"
        mtime = datetime.fromtimestamp(rst_file.stat().st_mtime)
        runs.append({
            "name": name,
            "run_name": ident["run_name"],
            "system": ident["system"],
            "variant": ident["variant"],
            "trace_variant": ident["trace_variant"],
            "scenario": ident["scenario"],
            "rst_file": str(rst_file),
            "ult_file": str(ult_file) if ult_file.exists() else None,
            "timestamp": mtime.isoformat(timespec="seconds"),
            "params": run_params or {},
        })
    return runs


def main():
    os.makedirs(TIMESERIES_DIR, exist_ok=True)
    runs = detect_runs(RESULTS_DIR)
    summaries, worklog = [], []

    for i, run in enumerate(runs, 1):
        print(f"Processing [{i}/{len(runs)}] {run['name']}...")
        jobs = parse_rst(run["rst_file"])

        uti_series, qd_series, qs_series = [], [], []
        ts_data = {
            "time": [],
            "utilization": [],
            "queue_depth": [],
            "queue_size": [],
        }
        if run["ult_file"] and os.path.exists(run["ult_file"]):
            times, uti, qd, qs = parse_ult(run["ult_file"])
            uti_series, qd_series, qs_series = uti, qd, qs
            ds = downsample(times, uti, qd, qs)
            ts_data = {
                "time": ds[0],
                "utilization": ds[1],
                "queue_depth": ds[2],
                "queue_size": ds[3],
            }

        ts_data["wait_timeline"] = compute_wait_timeline(jobs)
        with open(TIMESERIES_DIR / f"{run['name']}.json", "w") as f:
            json.dump(ts_data, f)

        summary = compute_summary(jobs, uti_series, qd_series, qs_series)
        summary.update({
            "timestamp": run["timestamp"],
            "run_name": run["run_name"],
            "system": run["system"],
            "variant": run["variant"],
            "trace_variant": run["trace_variant"],
            "scenario": run["scenario"],
            "algorithm": str((run.get("params") or {}).get("algorithm", "")),
            "run_type": str((run.get("params") or {}).get("run_type", "offline")),
            "cluster_fraction": round(_as_float((run.get("params") or {}).get("cluster_fraction", 1.0), 1.0), 6),
            "backfill": _as_int((run.get("params") or {}).get("backfill", 2), 2),
            "win": _as_int((run.get("params") or {}).get("win", 5), 5),
            "read_num": _as_int((run.get("params") or {}).get("read_num", -1), -1),
            "start": _as_int((run.get("params") or {}).get("start", 0), 0),
            "anchor": _as_int((run.get("params") or {}).get("anchor", 0), 0),
            "ad_bf": _as_int((run.get("params") or {}).get("ad_bf", 0), 0),
            "ad_win": _as_int((run.get("params") or {}).get("ad_win", 0), 0),
            "ad_alg": _as_int((run.get("params") or {}).get("ad_alg", 0), 0),
        })
        summaries.append(summary)

        run_params = run.get("params") or {}
        try:
            bf_id = int(run_params.get("backfill", 2))
        except Exception:
            bf_id = 2
        bf_names = {0: "None", 1: "EASY", 2: "Conservative"}

        worklog.append({
            "id": i,
            "timestamp": run["timestamp"],
            "run_name": run["run_name"],
            "system": run["system"],
            "variant": run["variant"],
            "trace_variant": run["trace_variant"],
            "scenario": run["scenario"],
            "input_file": run["name"],
            "backfill": bf_names.get(bf_id, "Conservative"),
            "algorithm": run_params.get("algorithm", ""),
            "win": run_params.get("win", 5),
            "read_num": run_params.get("read_num", -1),
            "total_jobs": summary.get("total_jobs", 0),
            "avg_wait": summary.get("avg_wait", 0),
            "wait_p95": summary.get("wait_p95", 0),
            "avg_utilization": summary.get("avg_utilization", 0),
            "peak_queue_depth": summary.get("peak_queue_depth", 0),
            "makespan": summary.get("makespan", 0),
        })

        if jobs:
            with open(TIMESERIES_DIR / f"{run['name']}_scatter.json", "w") as f:
                json.dump(_build_scatter(jobs), f)

    annotate_rescued_resource(summaries)

    with open(OUTPUT_DIR / "summary.json", "w") as f:
        json.dump(summaries, f, indent=2)
    with open(OUTPUT_DIR / "worklog.json", "w") as f:
        json.dump(worklog, f, indent=2)
    print(f"Done. Processed {len(runs)} runs.")


if __name__ == "__main__":
    main()
