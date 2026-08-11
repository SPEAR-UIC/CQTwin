# CQTwin Formulas and Metrics Reference

This document is the code-level definition of how CQTwin computes:
- scheduling priority scores,
- run/result metrics shown in the dashboard,
- worklog analysis metrics,
- recommendation outputs.

All formulas below are based on the current implementation in:
- `src/CqSim/Basic_algorithm.py`
- `src/CqSim/Job_trace.py`
- `src/CqSim/Backfill.py`
- `src/CqSim/Start_window.py`
- `dashboard/preprocess.py`
- `dashboard/serve.py`
- `dashboard/recommend.py`

## 1) Notation

For a job `j`:
- `submit_j`: submission time
- `start_j`: start time
- `end_j`: end time
- `wait_j = start_j - submit_j`
- `run_j`: actual runtime
- `req_time_j`: requested runtime (walltime request)
- `req_proc_j`: requested processors
- `turnaround_j = wait_j + run_j`

Symbols used in scheduling expressions:
- `w`: wait time at scheduling decision time (`current_time - submit`)
- `t`: requested runtime (`reqTime`)
- `n`: requested processors (`reqProc`)
- `s`: submit time
- `z`: max `w` among current waiting jobs
- `l`: min `t` among current waiting jobs

All dashboard time metrics are in seconds internally; UI formats into `s/m/h/d`.

## 2) Percentile Definition (Used Across Dashboard and Worklog)

CQTwin uses linear interpolation percentile:

1. Sort values ascending: `x_0 <= x_1 <= ... <= x_(N-1)`.
2. Compute index: `k = (N - 1) * p / 100`.
3. Let `lo = floor(k)`, `hi = ceil(k)`.
4. If `lo == hi`: `Q_p = x_lo`.
5. Else: `Q_p = x_lo * (1 - frac) + x_hi * frac`, where `frac = k - lo`.

Interpretation:
- `p90` means 90% of jobs are at or below that value.
- `p99` means 99% are at or below that value; about 1% are above it.

So if `p90 = 0` and `p99 = 1h`, that means at least 90% had zero wait, while the tail (roughly top 1-10%) includes delayed jobs and the top 1% reaches about 1 hour.

## 3) Scheduling Policy Formulas

### 3.1 Score evaluation

In `Basic_algorithm.get_score`, score is:

`score_j = eval(alg_expression)`

with variables (`w,t,n,s,z,l`) defined above.

Queue ordering in `Job_trace.refresh_score` is descending by score (higher score first).

### 3.2 Presets used by dashboard

Current preset expressions:
- Weighted Wait+2: `w + 2`
- FIFO (wait): `w`
- SJF preset text: `t`
- LJF preset text: `-t`
- Wait/Time: `w / t`
- WFP (ALCF): `(n * (w / (t if t > 0 else 1)) ** 3)`

### 3.3 Important implementation note about `alg_sign`

`alg_sign` is parsed and stored, but current score computation uses only `alg_expression` text and does not apply `alg_sign` during evaluation or ranking.

Practical consequence:
- Since ranking is descending score, expression `t` favors larger `t` values.
- Expression `-t` favors smaller `t` values.

If you rely on strict SJF/LJF semantics, verify the expression itself (do not assume `alg_sign` changes ordering in current code).

## 4) Backfill and Window Behavior

### 4.1 Backfill (`Backfill.py`)

- `None (0)`: no backfill.
- `EASY (1)`:
  - Reserve the head-of-line job.
  - Allow later jobs only if they can start without delaying that reserved head job.
- `Conservative (2)`:
  - Reserve head job.
  - For each later job, reserve it in sequence (whether or not it starts now), so no earlier waiting job is delayed by later backfilled choices.

### 4.2 Start Window (`Start_window.py`)

When enabled (`mode=1`), it permutes a window of waiting jobs and selects the permutation minimizing:

`min over permutations pi: end_time_of_last_reserved_job(pi)`

This is a combinational search over the configured check size.

## 5) Core Run Summary Metrics (Dashboard Overview/Per-System/Compare)

Defined in `dashboard/preprocess.py::compute_summary`.

Given all jobs in one run:

- `total_jobs = N`
- `avg_wait = mean(wait_j)`
- `median_wait = p50(wait_j)`
- `wait_p90 = p90(wait_j)`
- `wait_p95 = p95(wait_j)`
- `wait_p99 = p99(wait_j)`
- `max_wait = max(wait_j)`
- `wait_std = population_std(wait_j)`

- `avg_runtime = mean(run_j)`
- `runtime_p90 = p90(run_j)`
- `runtime_p95 = p95(run_j)`
- `avg_req_runtime = mean(req_time_j)`

- `avg_turnaround = mean(turnaround_j)`
- `turnaround_p95 = p95(turnaround_j)`

- `slowdown_j = turnaround_j / max(run_j, 1.0)`
- `bounded_slowdown_j = turnaround_j / max(run_j, 10.0)`
- `avg_slowdown = mean(slowdown_j)`
- `avg_bounded_slowdown = mean(bounded_slowdown_j)`
- `slowdown_p95 = p95(slowdown_j)`

- `makespan = max(end_j) - min(submit_j)` (clamped at `>= 0`)
- `throughput_jobs_per_day = N / makespan * 86400` (if makespan > 0, else 0)

### 5.1 Utilization and queue metrics

From `.ult` stream:
- `utilization` sample comes from logged `uti=...`
- `queue_depth` sample comes from logged `waitNum=...`
- `queue_size` sample comes from logged `waitSize=...`

Derived:
- `avg_utilization = mean(utilization_samples)`
- `peak_utilization = max(utilization_samples)`
- `utilization_std = population_std(utilization_samples)`
- `idle_fraction = max(0, 1 - avg_utilization)`
- `avg_queue_depth = mean(queue_depth_samples)`
- `peak_queue_depth = max(queue_depth_samples)`
- `queue_depth_p95 = p95(queue_depth_samples)`
- `avg_queue_size = mean(queue_size_samples)`
- `peak_queue_size = max(queue_size_samples)`

### 5.2 Fairness metric (Gini of waits)

For non-negative sorted waits `v_i`, `i=1..N`:

`G = (2 * sum(i * v_i) / (N * sum(v_i))) - (N + 1)/N`

Stored as `wait_gini`.

### 5.3 Rescued Resource (%)

Displayed as `rescued_resource_pct`.

Purpose:
- Proxy for "how much baseline idle resource-time was recovered" by a capacity-adjusted run.

Grouping (baseline matching):
- Runs are grouped by:
  - `system`
  - `trace_variant`
  - `variant` (policy/backfill config token)
  - `algorithm`
  - `backfill`, `win`
  - `read_num`, `start`, `anchor`
  - `ad_bf`, `ad_win`, `ad_alg`
- Baseline in each group is the newest run with `cluster_fraction = 1.0`.

Per-run computation:
- `idle(run) = (1 - avg_utilization_run) * makespan_run`
- `idle(base) = (1 - avg_utilization_base) * makespan_base`
- `saved_idle = max(0, idle(base) - idle(run))`
- `rescued_resource_pct = 100 * saved_idle / idle(base)` if `idle(base) > 0`, else `0`

Notes:
- This metric is capability/config-specific and only meaningful when a valid same-config baseline exists.
- It is a resource-time proxy based on utilization and makespan (not direct per-job injected tagging).

## 6) Chart/Visualization Data Formulas (Run Results)

### 6.1 Wait timeline (submission-time bins)

`compute_wait_timeline`:
- Split submission span into fixed bins (default 24).
- For each bin:
  - `p50/p90/p99` of waits in bin,
  - `avg` wait in bin,
  - `count` jobs in bin.

### 6.2 Runtime distribution histogram

`compute_runtime_distribution`:
- Log-spaced runtime bins between min and max runtime.
- Count jobs in each bin.

### 6.3 Wait violin

`compute_wait_violin` and `compute_wait_violin_by_runtime`:
- Build wait histogram over `n_bins` (default 56).
- Clip display at `clip_wait = p99.5(wait)` to avoid long-tail flattening.
- Smooth histogram with local moving average.
- Normalize density by peak density.
- Report quantiles (`q05..q99`, mean), clipped-tail count.
- By-runtime version splits jobs into 3 groups using runtime thirds of observed span:
  - Small: `run < t1`
  - Medium: `t1 <= run < t2`
  - Large: `run >= t2`

### 6.4 Job size vs wait heatmap (overview/per-system)

`compute_jobsize_wait_heatmap`:
- Y buckets: requested procs (`1-8, 8-32, ...`).
- X buckets: wait-time buckets (`0-60s, 60-300s, ...`, extend if needed).
- Cell value: job count in `(req_proc_bucket, wait_bucket)`.
- `max_count` used for color normalization in UI.

## 7) Worklog SWF Analysis Formulas

Defined in `dashboard/serve.py::_analyze_worklog_swf`.

### 7.1 Input parsing and fallbacks

From SWF columns:
- submit, wait, run, alloc procs, req procs, req time, user, group.
- Fallbacks:
  - if `req_proc <= 0` and `alloc_proc > 0`, use `alloc_proc`.
  - if `req_time <= 0` and `run > 0`, use `run`.

### 7.2 Summary metrics

Core formulas are consistent with run summary, plus:

- `jobs_per_day = total_jobs / submit_span * 86400` (if span > 0)
- `req_to_run = req_time / max(run, 1)`
- `run_to_req = run / max(req_time, 1)`
- `under_requested_pct = 100 * count(req_time < run) / N`
- `zero_wait_pct = 100 * count(wait <= 0) / N`

If SWF header provides `max_procs`:
- `avg_cluster_demand_share = mean(req_procs) / max_procs`
- `p95_cluster_demand_share = p95(req_procs) / max_procs`
- `peak_cluster_demand_share = max(req_procs) / max_procs`

### 7.3 Queue pressure timeline

Sample time axis from submit/start/end ranges.

At sample time `t`:
- `submitted(t) = #jobs with submit <= t`
- `started(t) = #jobs with start <= t`
- `ended(t) = #jobs with end <= t`
- `queue_depth(t) = max(0, submitted - started)`
- `running_depth(t) = max(0, started - ended)`

Processor-weighted:
- `subp(t) = sum(req_proc for jobs with submit <= t)`
- `stp(t) = sum(req_proc for jobs with start <= t)`
- `endp(t) = sum(req_proc for jobs with end <= t)`
- `queue_procs(t) = max(0, subp - stp)`
- `running_procs(t) = max(0, stp - endp)`
- `queue_share(t) = queue_procs / max_procs` (if known, else 0)
- `running_share(t) = running_procs / max_procs` (if known, else 0)

### 7.4 Worklog wait heatmap

`_build_wait_heatmap` computes:
- `counts[r][c]`: number of jobs in each `(req_proc_bucket r, wait_bucket c)`
- `avg_wait[r][c]`: average wait in that cell

UI rendering (`dashboard/js/worklog.js`):
- Cell color is based on job count density (`sqrt(count/max_count)`).
- Cell text shows job count.
- Hover tooltip shows avg wait and share.

### 7.5 User-level stats in worklog

For each user:
- `jobs`
- `avg_wait = sum_wait / jobs`
- `avg_runtime = sum_run / jobs`
- `avg_req_procs = sum_req_procs / jobs`
- `max_wait = max(wait)`

Across users (using per-user average wait `x_i`):
- `user_wait_p50/p90/p95 = percentiles of x_i`
- `user_wait_p90_to_p50 = p90 / max(p50, 1e-9)`
- Jain fairness:
  - `J = (sum x_i)^2 / (m * sum x_i^2)` for `m` users

## 8) Recommendation Module Formulas (Train + Adjust)

Defined in `dashboard/recommend.py`.

### 8.1 Model

Ridge regression on feature matrix `X` and target runtime `y`:

- Normalize features: `Xn = (X - mean) / std`
- Add bias column.
- Solve:
  - `w = argmin ||Xw - y||^2 + alpha * ||w_except_bias||^2`
  - Closed form by linear solve on normal equations.

### 8.2 Validation metrics

On holdout split:
- `RMSE = sqrt(mean((y - y_hat)^2))`
- `MAE = mean(|y - y_hat|)`
- `R2 = 1 - SS_res / SS_tot`

### 8.3 Adjustment formula written into output SWF

1. Base prediction floor:
   - `pred_floor_i = max(pred_i, runtime_i)`

2. User buffer:
   - Compute holdout absolute error `|y - y_hat|`.
   - For users with at least 3 holdout points:
     - `user_p90_buffer_u = p90(abs_error for user u)`
   - Else fallback to:
     - `global_p90_buffer = p90(all holdout abs_error)`

3. Final adjusted request:
   - `adjusted_i = ceil(pred_floor_i + user_p90_buffer_i + extra_buffer)`
   - `adjusted_i = max(adjusted_i, ceil(runtime_i))`

This adjusted value replaces SWF requested runtime (`REQ_TIME` column).

## 9) UI Terminology Clarification

- Queue Depth: number of waiting jobs.
- Queue Size (procs): total requested processors of waiting jobs.
- Running Share: estimated running processors divided by cluster max processors.

Overview vs Per-System:
- Overview: one selected run, full dashboard across that run.
- Per-System: filtered picker scoped by selected system; same run-level metrics/charts for that selected run.

## 10) Where to Verify in Code

Primary references:
- `src/CqSim/Basic_algorithm.py`: score expression evaluation
- `src/CqSim/Job_trace.py`: queue sort order by score
- `src/CqSim/Backfill.py`: EASY/Conservative logic
- `src/CqSim/Start_window.py`: window permutation objective
- `dashboard/preprocess.py`: run metrics and run-result visualization payloads
- `dashboard/serve.py`: worklog analysis and pressure/heatmap/user metrics
- `dashboard/recommend.py`: training metrics and adjusted-request-time formula
