# Benchmarks — Online Environment (reference)

> **Note.** These are reference results from the online-mode development work. They were produced on the
> **Polaris-2023** trace (`polaris_2023.swf`, 560 procs), which is **not bundled** with this repository (only
> `test.swf` and `mira_norm.swf` ship). The numbers are kept as documentation of the engine's online-mode
> behavior, the online↔offline equivalence guarantees, and the performance characteristics; reproduce them by
> supplying your own Polaris trace. Absolute wall-times are machine-dependent.

---

# Online Environment — Polaris-2023 Experiments

All runs go through the **same** `OnlineEnv` on the **same** trace slice, so the only difference is the per-cycle policy decision. Fixed runs are validated bit-exact against the offline engine (`tests/test_online_fidelity.cpp`), and projection forks are validated to contain no future arrivals (`tests/test_online_fork_visibility.cpp`).

## Configuration

- Trace: `data/InputFiles/polaris_2023.swf` (Polaris-2023, 560 procs)
- Slice: first **4000** jobs (by submit time); submit times shifted so the first arrival is t=0
- Mode: `real`  |  Backfill: **EASY** (mode 1)  |  Window: 64
- Greedy pool: {FCFS, SJF, WFP3}  |  projection horizon: 86400s
- Machine wall-clock; engine built Release.
- **Projections are online-correct:** each projection fork is a `get_copy` of the live sim, which under just-in-time (JIT) submit injection holds NO future arrivals (verified by `tests/test_online_fork_visibility.cpp`). A projection answers "how would policy X clear exactly what is queued/running now", not a future-aware forecast.
- **Slice:** N=4000 jobs. With JIT the per-cycle projection cost is modest (sub-ms/cycle/policy; see overhead section), so the full 159,731-job trace is feasible (see the full-trace section). The fixed runs use the identical slice.

## Comparison

| Run | avg wait (s) | p90 (s) | p99 (s) | completed | wall (s) |
|---|---|---|---|---|---|
| Fixed FCFS | 3035.1 | 7644.0 | 56781.0 | 4000 | 0.8 |
| Fixed SJF | 2870.3 | 5656.0 | 43710.0 | 4000 | 0.8 |
| Fixed WFP3 | 2902.0 | 6853.0 | 43661.0 | 4000 | 0.8 |
| **Greedy proj.** | 2812.5 | 5652.0 | 43710.0 | 4000 | 6.0 |

## Key result

- Best fixed policy by avg wait: **SJF** (2870.3s).
- Greedy projection: **2812.5s**.
- Greedy **beats** the best fixed policy on avg wait (delta = -57.8s, -2.0%).

## Greedy switch summary (run 4)

- Decision cycles: **6233**  |  policy switches (cycle-to-cycle): **90**
- Cycles each policy was chosen:
  - FCFS: 4975 (79.8%)
  - SJF: 64 (1.0%)
  - WFP3: 1194 (19.2%)
- Deviation from each single fixed policy (cycles where greedy chose differently):
  - vs always-FCFS: 1258 cycles (20.2%)
  - vs always-SJF: 6169 cycles (99.0%)
  - vs always-WFP3: 5039 cycles (80.8%)

_Switch timeline (cycle, sim_time, chosen) written alongside as `greedy_switches.csv`._

## Projection overhead (Task 4)

Fixed **WFP3** committed policy, pool {FCFS, SJF, WFP3}, same slice (N=4000) and config as above; projection horizon 86400s.

- Decision cycles: **6234**
- Schedule identical across all runs (projections are read-only): **yes** (avg wait = [2901.9685]).

| Projections | total wall (s) | overhead vs OFF (s) | per-decision-cycle overhead (ms) |
|---|---|---|---|
| OFF | 0.80 | — | — |
| ON (every 1) | 6.08 | +5.28 | 0.846 |
| ON (every 10) | 1.46 | +0.66 | 0.106 |
| ON (every 100) | 0.85 | +0.05 | 0.007 |

Per-decision-cycle overhead = (wall_ON − wall_OFF) / decision cycles. With interval K, projections run on ~1/K of cycles, so overhead scales ~1/K. Each projection rolls all pool policies forward to the horizon, hence the interval-1 cost.

### Before/after the JIT fix (same N=4000, 6234 cycles)

The env originally **preloaded all submit events** at construction, which (a) let projection forks see future arrivals — the semantic bug fixed in this pass — and (b) made every `get_copy` copy an O(N) heap, so per-cycle projection cost was ~O(N). Switching to JIT submit injection (heap depth O(active window)) both fixes the semantics and drops the cost:

| Projections | preload wall (s) | JIT wall (s) | preload ms/cycle | JIT ms/cycle |
|---|---|---|---|---|
| OFF | 0.82 | 0.80 | — | — |
| ON (every 1) | 39.77 | 6.08 | 6.248 | 0.846 |
| ON (every 10) | 5.08 | 1.46 | 0.684 | 0.106 |
| ON (every 100) | 1.22 | 0.85 | 0.064 | 0.007 |

The earlier "O(N^2) / full-trace impractical" caveat no longer holds: JIT removed the O(N) `get_copy`, per-cycle cost is now ~constant in N, and the full trace is feasible (below).

## Full-trace run (Task 5)

**Full Polaris-2023 trace** — all 147,513 schedulable jobs (159,731 SWF lines; the rest are filtered by the reader), 560 procs, `real` mode, EASY backfill, fixed **WFP3**. This row is full-trace, NOT the 4000-job slice above — do not compare across the two directly.

| Run (full trace) | avg wait (s) | p90 (s) | p99 (s) | completed | decision cycles | wall (s) |
|---|---|---|---|---|---|---|
| Fixed WFP3, projections OFF | 1384.1 | 1250.0 | 33857.0 | 147513 | 208012 | **26.9** |
| Fixed WFP3, projections ON (interval 1) | 1384.1 | 1250.0 | 33857.0 | 147513 | 208012 | **134.4** |

All wall times are **post-optimization** (both O(N²) fixes below applied). Metrics are identical with projections off vs on (projections are read-only), confirming non-interference at full-trace scale, and both fixes are provably behaviour-preserving: avg_wait `1384.149485130124` and total_reward `-51170.53066805891` are bit-identical across OFF/ON and before/after each fix, and the full interval-1 `advisory.csv` (624,036 projection rows = 208,012 cycles × 3 pool policies) is **byte-for-byte identical** before and after the fork-copy fix (same MD5).

The OFF wall is 26.9s (down from 179.6s pre-fix); the native engine alone replays this trace in ~2s, and the residual is per-cycle JSON observation building + the socket round-trip over 208,012 cycles. The ON interval-1 wall is **134.4s (down from 3871.0s pre-fix, ~29×)** — the projection compute now adds only ~107s over OFF (≈0.51 ms/cycle for all 3 pool rollouts), because each projection fork is now O(running) rather than O(N). Any interval K>1 divides that projection cost by ~K.

## Per-cycle observation cost — O(N²) fix

`Simulator::completed_jobs_` is an append-only vector that grows to N over a run. Two env hot loops used to rescan the **entire** completed history every decision cycle — `build_obs()`'s `avg_wait_so_far` metric and `step()`'s reward accounting — making each independent of the others but O(completed) per cycle, i.e. **O(N²)** over the trace (≈208k cycles × up to 147k completions × 2 scans ≈ 3×10¹⁰ hashmap lookups). Both were replaced with incremental folds over only the newly-completed tail; because `completed_jobs_` is append-only and the fold preserves index order, the running sums are **bit-identical** to the from-scratch loops.

Full Polaris-2023 trace, fixed WFP3, projections OFF (same config as the full-trace table):

| | wall (real) | CPU (user) | avg_wait | total_reward |
|---|---|---|---|---|
| Before (rescan all completions) | 192.0s | 162.8s | 1384.149485130124 | −51170.53066805891 |
| After (incremental tail fold) | **26.9s** | **16.5s** | 1384.149485130124 | −51170.53066805891 |

**7.1× wall / 9.8× CPU**, output bit-identical (and the full test suite still passes, including the offline-fidelity tests). The collapse in *user* CPU (163s→17s) confirms the cost was the compute-bound rescan, not socket I/O. This fix reduces the *base* per-cycle cost shared by OFF and ON.

## Projection fork copy — O(N²) fix (ON path)

Each advisory projection forks the live sim with `get_copy`, which deep-copied the three append-only, O(N)-growing history structures (`completed_jobs_`, `first_start_times_`, `completed_end_times_`). At full-trace scale that made every projection O(N) and the whole ON path O(N²). A bounded rollout, however, never reads pre-fork history: backfill reservations read only running jobs' `end_times_` (which is O(running) — erased on End), and the rollout writes its own start/completion entries for the jobs it advances. So `Simulator::get_projection_copy()` starts those three structures **empty** (copy is now O(running), not O(N)); `project_policy` uses it, while `scenario_preview` keeps the full `get_copy`. Safety is guarded by `tests/test_online_projection_copy.cpp`, which asserts a light-copy rollout is identical to a full-copy rollout (per-queued-job start time + completion + post-rollout free procs) at several decision points.

Full Polaris-2023 trace, fixed WFP3, projections ON at interval 1 (all 3 pool rollouts every cycle):

| | wall (real) | CPU (user) | avg_wait | total_reward | advisory.csv |
|---|---|---|---|---|---|
| Before (full fork copy) | 3871.0s | — | 1384.149485130124 | −51170.53066805891 | 624,036 rows |
| After (`get_projection_copy`) | **134.4s** | 119.6s | 1384.149485130124 | −51170.53066805891 | byte-identical (same MD5) |

**~29× wall**, projection output byte-for-byte unchanged. Suite is **170/170** (added the guard test). The two fixes compound on the ON path (it carried both O(N²) costs); together they make full-trace interval-1 advisory logging a ~2-minute run instead of ~65 minutes.
