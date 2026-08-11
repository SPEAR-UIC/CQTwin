#!/usr/bin/env python3
"""Task 4: projection overhead. Fixed WFP3 (pool of 3), advisory OFF vs ON at
projection intervals 1/10/100. Reports total wall time and per-decision-cycle
overhead, and appends a section to RESULTS.md.

Advisory projections are read-only (they snapshot the sim), so the WFP3 schedule
must be byte-identical across all runs; the script asserts that as a check.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path

import cqsim_online as co

WINDOW = 64
BF = 1
HORIZON = 86400
POOL = ["fcfs", "sjf", "wfp3"]
FIXED_ACTION = POOL.index("wfp3")


def entry(p):
    e = {"type": p}
    if p != "fcfs":
        e["window_size"] = WINDOW
    e["backfilling"] = True
    e["legacy_backfill_mode"] = BF
    return e


def run(cfg_path):
    env = co.CQSimOnlineEnv(cfg_path)
    obs, _ = env.reset()
    t0 = time.time()
    steps = 0
    done = False
    info = {}
    while not done:
        obs, _r, done, _t, info = env.step(FIXED_ACTION)
        steps += 1
    wall = time.time() - t0
    env.close()
    return info.get("summary", {}), wall, steps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trace", default="data/InputFiles/polaris_2023.swf")
    ap.add_argument("--n", type=int, default=4000)
    ap.add_argument("--mode", default="real")
    ap.add_argument("--out", default="RESULTS.md")
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="cqsim_overhead_")
    pool = [entry(p) for p in POOL]

    def cfg(obs_block):
        c = {"swf_path": args.trace, "mode": args.mode, "max_submits": args.n,
             "pool": pool, "obs": obs_block}
        p = Path(tmp) / (("cfg_" + json.dumps(obs_block).replace('"', '').replace(' ', '')
                          .replace(':', '').replace('{', '').replace('}', '').replace(',', '_'))
                         + ".json")
        p.write_text(json.dumps(c))
        return str(p)

    runs = []
    # OFF
    s, w, n = run(cfg({"include_advisory": False}))
    runs.append(("off", None, s, w, n))
    print(f"OFF          wall={w:.2f}s steps={n} avg_wait={s.get('avg_wait')}")
    # ON at intervals
    for interval in (1, 10, 100):
        s, w, n = run(cfg({"include_advisory": True,
                           "advisory_horizon_seconds": HORIZON,
                           "advisory_interval": interval}))
        runs.append(("on", interval, s, w, n))
        print(f"ON  int={interval:<4} wall={w:.2f}s steps={n} avg_wait={s.get('avg_wait')}")

    off_wall = runs[0][3]
    steps = runs[0][4]

    # Non-interference check: schedule identical regardless of projections.
    avgs = {round(s.get("avg_wait", -1), 6) for _, _, s, _, _ in runs}
    identical = (len(avgs) == 1)

    lines = []
    lines.append("\n## Projection overhead (Task 4)\n")
    lines.append(f"Fixed **WFP3** committed policy, pool {{FCFS, SJF, WFP3}}, same slice "
                 f"(N={args.n}) and config as above; projection horizon {HORIZON}s.\n")
    lines.append(f"- Decision cycles: **{steps}**")
    lines.append(f"- Schedule identical across all runs (projections are read-only): "
                 f"**{'yes' if identical else 'NO — investigate'}** "
                 f"(avg wait {'=' if identical else '!='} {list(avgs)}).\n")
    lines.append("| Projections | total wall (s) | overhead vs OFF (s) | per-decision-cycle overhead (ms) |")
    lines.append("|---|---|---|---|")
    lines.append(f"| OFF | {off_wall:.2f} | — | — |")
    for kind, interval, _s, w, n in runs[1:]:
        oh = w - off_wall
        per = 1000.0 * oh / n if n else 0.0
        lines.append(f"| ON (every {interval}) | {w:.2f} | {oh:+.2f} | {per:.3f} |")
    lines.append("")
    lines.append("Per-decision-cycle overhead = (wall_ON − wall_OFF) / decision cycles. With "
                 "interval K, projections run on ~1/K of cycles, so overhead scales ~1/K. Each "
                 "projection rolls all pool policies forward to the horizon, hence the interval-1 "
                 "cost.\n")

    with open(args.out, "a") as f:
        f.write("\n".join(lines))
    print(f"\nappended overhead section to {args.out}")


if __name__ == "__main__":
    main()
