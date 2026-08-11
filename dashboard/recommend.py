#!/usr/bin/env python3
"""Runtime recommendation pipeline for SWF traces.

This module trains a lightweight regression model directly from an input SWF,
then emits adjusted requested times using:

    adjusted_requested_time = max(base_prediction, runtime) + user_p90_buffer + extra_buffer

`user_p90_buffer` is estimated from holdout absolute errors per user.
"""

from __future__ import annotations

import csv
import math
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

SWF_WIDTH = 18

COL_JOB_ID = 0
COL_SUBMIT = 1
COL_WAIT = 2
COL_RUN = 3
COL_ALLOC_PROCS = 4
COL_REQ_PROCS = 7
COL_REQ_TIME = 8
COL_STATUS = 10
COL_USER = 11
COL_GROUP = 12


@dataclass
class RidgeModel:
    weights: np.ndarray
    mean: np.ndarray
    std: np.ndarray

    def predict(self, x: np.ndarray) -> np.ndarray:
        x_norm = (x - self.mean) / self.std
        x_aug = np.hstack([np.ones((x_norm.shape[0], 1)), x_norm])
        return x_aug @ self.weights


def _percentile(values: np.ndarray, q: float) -> float:
    if values.size == 0:
        return 0.0
    return float(np.percentile(values, q))


def _safe_float(token: str, default: float = -1.0) -> float:
    try:
        return float(token)
    except Exception:
        return default


def parse_swf(path: Path):
    """Return (headers, rows ndarray shape[n,18])."""
    headers = []
    rows = []

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            if line.startswith(";"):
                headers.append(line)
                continue

            parts = line.split()
            if not parts:
                continue
            if len(parts) < SWF_WIDTH:
                parts += ["-1"] * (SWF_WIDTH - len(parts))
            elif len(parts) > SWF_WIDTH:
                parts = parts[:SWF_WIDTH]

            rows.append([_safe_float(tok) for tok in parts])

    if not rows:
        raise ValueError(f"No SWF job rows found in: {path.name}")

    arr = np.asarray(rows, dtype=float)
    return headers, arr


def _running_feature_matrix(rows_sorted: np.ndarray):
    """Create user-history enriched features in submit-time order."""
    n = rows_sorted.shape[0]
    feat = np.zeros((n, 17), dtype=float)

    hist = defaultdict(lambda: {
        "count": 0,
        "sum_runtime": 0.0,
        "max_runtime": 0.0,
        "sum_acc": 0.0,
        "max_acc": 0.0,
        "last1": None,
        "last2": None,
        "last10": deque(maxlen=10),
    })

    submit0 = float(rows_sorted[0, COL_SUBMIT])

    for i in range(n):
        row = rows_sorted[i]

        user = int(row[COL_USER])
        group_id = float(row[COL_GROUP])
        submit = float(row[COL_SUBMIT])
        wait = max(0.0, float(row[COL_WAIT]))
        run = max(0.0, float(row[COL_RUN]))
        req_time = max(1.0, float(row[COL_REQ_TIME]))
        req_procs = max(1.0, float(row[COL_REQ_PROCS]))
        alloc_procs = max(1.0, float(row[COL_ALLOC_PROCS]))
        status = float(row[COL_STATUS])

        s = hist[user]
        c = s["count"]

        runtime1 = s["last1"] if s["last1"] is not None else req_time
        runtime2 = s["last2"] if s["last2"] is not None else req_time
        runtime12 = 0.5 * (runtime1 + runtime2)

        runtime_mean = (s["sum_runtime"] / c) if c else req_time
        runtime_max = s["max_runtime"] if c else req_time
        acc_mean = (s["sum_acc"] / c) if c else 1.0
        acc_max = s["max_acc"] if c else 1.0

        if s["last10"]:
            last10_mean = float(np.mean(s["last10"]))
            last10_max = float(np.max(s["last10"]))
        else:
            last10_mean = req_time
            last10_max = req_time

        feat[i] = np.array([
            submit - submit0,
            wait,
            req_procs,
            alloc_procs,
            req_time,
            status,
            group_id,
            runtime1,
            runtime2,
            runtime12,
            runtime_mean,
            runtime_max,
            last10_mean,
            last10_max,
            acc_mean,
            acc_max,
            float(c),
        ], dtype=float)

        # Update history after using this row's historical context
        acc = min(run, req_time) / max(run, req_time) if max(run, req_time) > 0 else 1.0
        s["count"] += 1
        s["sum_runtime"] += run
        s["max_runtime"] = max(s["max_runtime"], run)
        s["sum_acc"] += acc
        s["max_acc"] = max(s["max_acc"], acc)
        s["last2"] = s["last1"]
        s["last1"] = run
        s["last10"].append(run)

    return feat


def _fit_ridge(x: np.ndarray, y: np.ndarray, alpha: float) -> RidgeModel:
    mean = x.mean(axis=0)
    std = x.std(axis=0)
    std[std < 1e-8] = 1.0

    x_norm = (x - mean) / std
    x_aug = np.hstack([np.ones((x_norm.shape[0], 1)), x_norm])

    p = x_aug.shape[1]
    eye = np.eye(p)
    eye[0, 0] = 0.0  # no regularization on bias

    lhs = x_aug.T @ x_aug + alpha * eye
    rhs = x_aug.T @ y
    try:
        w = np.linalg.solve(lhs, rhs)
    except np.linalg.LinAlgError:
        w = np.linalg.lstsq(lhs, rhs, rcond=None)[0]

    return RidgeModel(weights=w, mean=mean, std=std)


def _metrics(y_true: np.ndarray, y_pred: np.ndarray):
    err = y_true - y_pred
    mse = float(np.mean(err ** 2))
    rmse = math.sqrt(mse)
    mae = float(np.mean(np.abs(err)))

    y_mean = float(np.mean(y_true))
    ss_tot = float(np.sum((y_true - y_mean) ** 2))
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 1e-12 else 0.0

    return {
        "rmse": rmse,
        "mae": mae,
        "r2": r2,
    }


def _unique_output_name(base: str, output_dir: Path) -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    candidate = f"{base}__recommended_{stamp}.swf"
    i = 2
    while (output_dir / candidate).exists():
        candidate = f"{base}__recommended_{stamp}_{i}.swf"
        i += 1
    return candidate


def _write_swf(path: Path, headers: list[str], rows: np.ndarray):
    if not headers:
        headers = ["; Generated by CQTwin Recommendation"]

    with open(path, "w", encoding="utf-8") as f:
        for h in headers:
            f.write(h.rstrip("\n") + "\n")

        for row in rows:
            ints = [str(int(round(v))) for v in row[:SWF_WIDTH]]
            f.write(" ".join(ints) + "\n")


def _write_report_csv(path: Path, rows: list[dict]):
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = [
        "job_id", "user", "runtime", "requested_time_old",
        "base_prediction", "user_p90_buffer", "extra_buffer",
        "adjusted_requested_time",
    ]

    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for row in rows:
            w.writerow(row)


def generate_recommendation(
    input_swf: Path,
    output_input_dir: Path,
    report_dir: Path,
    *,
    extra_buffer: float = 0.0,
    test_fraction: float = 0.2,
    ridge_alpha: float = 8.0,
):
    """Train and recommend adjusted requested times for an SWF trace."""
    if not input_swf.exists():
        raise FileNotFoundError(f"SWF file not found: {input_swf}")

    headers, rows = parse_swf(input_swf)
    n = rows.shape[0]

    if n < 8:
        raise ValueError("Need at least 8 rows in SWF for training/recommendation")

    # Sort by submit time for time-aware feature generation/splitting
    order = np.argsort(rows[:, COL_SUBMIT], kind="mergesort")
    inv_order = np.empty_like(order)
    inv_order[order] = np.arange(n)
    rows_sorted = rows[order]

    x = _running_feature_matrix(rows_sorted)
    y = np.maximum(0.0, rows_sorted[:, COL_RUN])
    users_sorted = rows_sorted[:, COL_USER].astype(int)

    # Time split: first chunk train, tail chunk validation
    test_fraction = min(max(float(test_fraction), 0.05), 0.5)
    test_n = max(1, int(round(n * test_fraction)))
    split = max(2, n - test_n)

    x_train, x_test = x[:split], x[split:]
    y_train, y_test = y[:split], y[split:]
    users_test = users_sorted[split:]

    model_holdout = _fit_ridge(x_train, y_train, alpha=max(float(ridge_alpha), 1e-4))
    pred_test = np.maximum(0.0, model_holdout.predict(x_test))

    eval_metrics = _metrics(y_test, pred_test)
    abs_err_test = np.abs(y_test - pred_test)
    global_p90 = _percentile(abs_err_test, 90)

    user_buf = {}
    for u in np.unique(users_test):
        vals = abs_err_test[users_test == u]
        # Need enough points for stable per-user percentile
        if vals.size >= 3:
            user_buf[int(u)] = _percentile(vals, 90)

    # Final model on all rows for production predictions
    model_final = _fit_ridge(x, y, alpha=max(float(ridge_alpha), 1e-4))
    pred_all = np.maximum(0.0, model_final.predict(x))

    # Replace prediction floor with true runtime to avoid under-allocating known jobs
    pred_floor = np.maximum(pred_all, y)

    extra = max(float(extra_buffer), 0.0)
    p90_by_user = np.array([user_buf.get(int(u), global_p90) for u in users_sorted], dtype=float)
    adjusted = np.ceil(pred_floor + p90_by_user + extra)
    adjusted = np.maximum(adjusted, np.ceil(y))

    # Restore original order
    pred_floor_orig = pred_floor[inv_order]
    p90_orig = p90_by_user[inv_order]
    adjusted_orig = adjusted[inv_order]
    runtime_orig = np.maximum(0.0, rows[:, COL_RUN])

    under_base = float(np.mean(pred_floor_orig < runtime_orig) * 100.0)
    under_adjusted = float(np.mean(adjusted_orig < runtime_orig) * 100.0)

    # Emit recommended SWF into InputFiles so it is directly runnable
    base = input_swf.stem
    out_name = _unique_output_name(base, output_input_dir)
    out_path = output_input_dir / out_name

    out_rows = rows.copy()
    out_rows[:, COL_REQ_TIME] = adjusted_orig
    _write_swf(out_path, headers, out_rows)

    # Save recommendation report CSV
    report_dir.mkdir(parents=True, exist_ok=True)
    report_name = out_name.replace(".swf", "_report.csv")
    report_path = report_dir / report_name

    report_rows = []
    for i in range(n):
        report_rows.append({
            "job_id": int(round(rows[i, COL_JOB_ID])),
            "user": int(round(rows[i, COL_USER])),
            "runtime": int(round(runtime_orig[i])),
            "requested_time_old": int(round(rows[i, COL_REQ_TIME])),
            "base_prediction": int(round(pred_floor_orig[i])),
            "user_p90_buffer": int(round(p90_orig[i])),
            "extra_buffer": int(round(extra)),
            "adjusted_requested_time": int(round(adjusted_orig[i])),
        })

    _write_report_csv(report_path, report_rows)

    preview = report_rows[:20]

    return {
        "status": "ok",
        "input_swf": input_swf.name,
        "output_swf": out_name,
        "report_csv": report_name,
        "summary": {
            "model": "ridge_regression_numpy",
            "jobs": int(n),
            "users": int(len(np.unique(rows[:, COL_USER]))),
            "features": int(x.shape[1]),
            "train_rows": int(split),
            "test_rows": int(n - split),
            "rmse": round(eval_metrics["rmse"], 3),
            "mae": round(eval_metrics["mae"], 3),
            "r2": round(eval_metrics["r2"], 4),
            "global_p90_buffer": round(global_p90, 2),
            "extra_buffer": round(extra, 2),
            "base_underestimation_pct": round(under_base, 3),
            "adjusted_underestimation_pct": round(under_adjusted, 3),
            "mean_runtime": round(float(np.mean(runtime_orig)), 2),
            "mean_base_prediction": round(float(np.mean(pred_floor_orig)), 2),
            "mean_adjusted_prediction": round(float(np.mean(adjusted_orig)), 2),
        },
        "preview": preview,
    }
