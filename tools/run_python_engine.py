#!/usr/bin/env python3
"""Run the legacy **Python CQSim** engine as a scripting-only alternative to the
CQTwin C++ engine.

This is the Python-engine counterpart of `cqtwin run`: it replays one SWF trace
under a chosen policy + backfill mode through the reference Python CQSim
(`CQSim/src/cqsim.py`) and writes a per-job `jobs.csv` in the *same schema* the
C++ engine emits, so the two are directly comparable by job id.

    CQSim/.venv/bin/python CQTwin/tools/run_python_engine.py \
        --trace polaris_norm --procs 560 --policy wfp3 --backfill easy \
        --out /tmp/py_wfp3

Design notes
------------
* SCRIPTING ONLY. The Python engine is deliberately **not** wired into the
  dashboard (native_bridge.py bridges only the C++ binary). It is kept as a
  reference/validation backend for scripts, not an end-user option.
* CQSim scores each waiting job by `eval(alg)` over {s,t,n,w,z,l,currentTime}
  and schedules **highest score first** (Job_trace.scoreCmp, descending). CQTwin
  ranks **lowest score first**. So each policy's CQSim expression is the negation
  of CQTwin's score formula:  `alg = -(CQTwin_score)`.
* The CQSim eval scope has no `math`; `log10/log2` are reached via
  `__import__('math')`, and `sqrt(x)` is written `x**0.5`. The config reader
  splits only on `=`, so expressions must contain no `=` (use strict `<`/`>`).
* Validation status. --self-check cross-checks every policy vs the C++ engine
  per-job (matched job sets). Results:
    - theta_p90 EASY & Conservative:  20/20 policies bit-exact (max Δ 0 s).
    - polaris_norm EASY (matched set): 18/20 bit-exact; lcfs & unicep diverge
      ~13% of jobs. That divergence is a tie-break CONVENTION difference, not a
      translation error: CQSim orders equal-priority jobs by stable insertion
      order, CQTwin by (submit_time, id). It appears only on traces with many
      simultaneous submissions (polaris has 6,827 such jobs; theta has none that
      matter) and cascades from small swaps. It is unfixable from `alg` (job id
      is not in CQSim's scoring scope) and is the same class as the known
      intrepid/EASY corner case (validation/VALIDATION.md). fcfs/sjf/wfp3 are the
      formally-validated policies; the other 17 are faithful score translations.
"""
from __future__ import annotations

import argparse
import csv
import shutil
import subprocess
import sys
from pathlib import Path

ROOT      = Path(__file__).resolve().parents[2]        # .../Project/CQTwin
CQSIM     = ROOT / "CQSim"
CQSIM_SRC = CQSIM / "src"
CQSIM_PY  = CQSIM / ".venv" / "bin" / "python"
CQSIM_IN  = CQSIM / "data" / "InputFiles"
CQSIM_RES = CQSIM / "data" / "Results"

# Policies validated bit-exact against the C++ engine (validation/VALIDATION.md).
VALIDATED = {"fcfs", "sjf", "wfp3", "wfp"}

# CQTwin policy -> CQSim `alg` expression (= negation of the CQTwin score, since
# CQSim ranks highest-first and CQTwin lowest-first). {T} = total procs literal.
# Variables: s=submit, t=reqTime(walltime), n=reqProc, w=int(wait). No '=' chars.
POLICY_ALG = {
    "fcfs":   "w",                                   # earliest submit first (max wait)
    "sjf":    "-t",                                  # shortest walltime first
    "ljf":    "t",                                   # longest walltime first
    "srf":    "-n",                                  # smallest resource first
    "lrf":    "n",                                   # largest resource first
    "scf":    "-(t*n)",                              # smallest core-hours first
    "lcf":    "t*n",                                 # largest core-hours first
    "lcfs":   "s",                                   # last-come first-served (max submit)
    "wfp3":   "n*(w/t)**3",                          # WFP3
    "wfp1":   "w/t",                                 # WFP1
    "wfp2":   "n*(w/t)**2",                          # WFP2
    "sww":    "n*w/t",                               # size-weighted wait
    "fcsj":   "w/(t*n)",                             # size-normalized wait ratio
    "fat":    "(w/t)*(n/{T})**3",                    # fractional-area, size^3
    "unicep": "(w/((__import__('math').log2(n/{T}))*t) if n<{T} else 0.0)",
    # bsld = max(1, (w+t)/max(t,3600)); written comma-free (CQSim comma-splits alg)
    "bsld":   "(((w+t)/(t if t>3600.0 else 3600.0)) if ((w+t)/(t if t>3600.0 else 3600.0))>1.0 else 1.0)",
    "f1":     "-(__import__('math').log10(t)*n + 870.0*__import__('math').log10(s if s>0 else 1.0))",
    "f2":     "-(t**0.5*n + 2.56e4*__import__('math').log10(s if s>0 else 1.0))",
    "f3":     "-(t*n + 6.86e6*__import__('math').log10(s if s>0 else 1.0))",
    "f4":     "-(t*n**0.5 + 5.30e5*__import__('math').log10(s if s>0 else 1.0))",
}
# aliases accepted on the CLI
ALIASES = {"fifo": "fcfs", "wfp": "wfp3", "unicef": "unicep"}

CQSIM_CFG = """cluster_fraction=1.0
start=0
start_date=None
anchor=0
read_num={read_num}
debug_lvl=1
alg={alg}
alg_sign=1,0,1
backfill={bf}
bf_para=
win=0
win_para=1,0,0
ad_win=0
ad_bf=0
ad_alg=0
ad_win_para=
ad_bf_para=ad_bf_para.set
ad_alg_para=
config_n=config_n.set
monitor=1000
log_freq=1
read_input_freq=2000
output={out}
debug=debug_{out}
job_save={out}
node_save={out}_node
job_trace={trace}.swf
node_struc={trace}.swf
"""

BACKFILL = {"easy": 1, "cons": 2, "none": 0}


def read_maxprocs(swf: Path) -> int:
    """Total procs = the SWF ';  MaxProcs:' header (what CQSim's node struct uses)."""
    with open(swf) as f:
        for line in f:
            if not line.startswith(";"):
                break
            low = line.lower()
            if "maxprocs" in low:
                return int(line.split(":", 1)[1].strip())
    raise SystemExit(f"[error] no ';  MaxProcs:' header in {swf}; pass --procs explicitly")


def resolve_trace(arg: str) -> Path:
    """Accept a path or a bare name already present in CQSim/data/InputFiles."""
    p = Path(arg)
    if p.exists():
        return p.resolve()
    cand = CQSIM_IN / (arg if arg.endswith(".swf") else f"{arg}.swf")
    if cand.exists():
        return cand.resolve()
    raise SystemExit(f"[error] trace not found: {arg} (looked at {p} and {cand})")


def run_cqsim(trace_name: str, alg: str, bf: int, tag: str, read_num: int) -> Path:
    """Write a CQSim config, run the engine, return the per-job .rst path."""
    cfg_name = f"{tag}.set"
    (CQSIM_SRC / "Config" / cfg_name).write_text(
        CQSIM_CFG.format(alg=alg, bf=bf, out=tag, trace=trace_name, read_num=read_num))
    cmd = [str(CQSIM_PY), "-u", "cqsim.py", "-C", cfg_name,
           "-j", f"{trace_name}.swf", "-n", f"{trace_name}.swf",
           "-o", tag, "--debug", f"d_{tag}", "-J", tag, "-N", f"{tag}_node"]
    proc = subprocess.run(cmd, cwd=str(CQSIM_SRC),
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    rst = CQSIM_RES / f"{tag}.rst"
    if proc.returncode != 0 or not rst.exists():
        tail = "\n".join((proc.stdout or "").splitlines()[-3:])
        raise RuntimeError(f"CQSim failed for alg={alg!r} (rc={proc.returncode}): {tail}")
    return rst


def rst_to_jobscsv(rst: Path, out_csv: Path):
    """CQSim .rst (id;proc;proc;reqTime;run;wait;submit;start;end) -> C++ jobs.csv."""
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    n, wait_sum = 0, 0.0
    with open(rst) as f, open(out_csv, "w", newline="") as o:
        wr = csv.writer(o)
        wr.writerow(["job_id", "req_proc", "req_time", "run", "wait", "submit", "start", "end"])
        for line in f:
            x = line.strip().split(";")
            if len(x) < 9:
                continue
            jid, proc, reqt, run, wait, submit, start, end = (
                x[0], x[1], x[3], x[4], x[5], x[6], x[7], x[8])
            wr.writerow([jid, proc, reqt, run, wait, submit, start, end])
            n += 1
            wait_sum += float(wait)
    return n, (wait_sum / n if n else 0.0)


def cleanup(tag: str, temp_swf: Path | None):
    for pth in [CQSIM_SRC / "Config" / f"{tag}.set", temp_swf]:
        if pth and pth.exists():
            try:
                pth.unlink()
            except OSError:
                pass


def run_one(trace_arg, policy, alg_override, sign_unused, backfill, out_dir,
            procs, read_num):
    src = resolve_trace(trace_arg)
    total = procs if procs else read_maxprocs(src)
    tag = f"_pyeng_{policy or 'raw'}_{backfill}"

    # CQSim resolves the trace from its InputFiles dir; stage a copy there.
    temp_swf = None
    trace_name = src.stem
    if src.parent.resolve() != CQSIM_IN.resolve():
        trace_name = f"_pyeng_{src.stem}"
        temp_swf = CQSIM_IN / f"{trace_name}.swf"
        shutil.copyfile(src, temp_swf)

    if alg_override is not None:
        alg = alg_override
    else:
        alg = POLICY_ALG[policy].replace("{T}", f"{float(total)}")
    if "," in alg or "=" in alg:
        raise RuntimeError(f"alg must not contain ',' or '=' (CQSim corrupts them): {alg!r}")

    try:
        rst = run_cqsim(trace_name, alg, BACKFILL[backfill], tag, read_num)
        n, avg = rst_to_jobscsv(rst, Path(out_dir) / "jobs.csv")
    finally:
        cleanup(tag, temp_swf)
    return dict(trace=src.name, total=total, alg=alg, jobs=n, avg_wait=avg,
                out=str(Path(out_dir) / "jobs.csv"))


def main():
    ap = argparse.ArgumentParser(
        description="Run the legacy Python CQSim engine (scripting-only alternative "
                    "to the CQTwin C++ engine). Emits a C++-schema jobs.csv.")
    ap.add_argument("--trace",
                    help="SWF path, or a bare name in CQSim/data/InputFiles (e.g. polaris_norm)")
    ap.add_argument("--policy", help="one of: " + ", ".join(POLICY_ALG))
    ap.add_argument("--alg", help="raw CQSim score expression (overrides --policy); "
                                  "ranked highest-first, no '=' chars")
    ap.add_argument("--backfill", choices=list(BACKFILL), default="easy")
    ap.add_argument("--procs", type=int, default=0,
                    help="total procs (default: read ';  MaxProcs:' from the SWF)")
    ap.add_argument("--out", default="py_engine_out", help="output dir for jobs.csv")
    ap.add_argument("--read-num", type=int, default=200000)
    ap.add_argument("--list", action="store_true", help="list policies + validation status and exit")
    ap.add_argument("--self-check", metavar="TRACE", nargs="?", const="polaris_norm",
                    help="run every policy through Python vs the C++ engine on TRACE "
                         "and report per-job wait exact-match %% (default polaris_norm)")
    args = ap.parse_args()

    if args.list:
        print(f"{'policy':8} {'status':10} alg (CQSim, highest-first)")
        for p, a in POLICY_ALG.items():
            print(f"{p:8} {'VALIDATED' if p in VALIDATED else 'translated':10} {a}")
        return

    if args.self_check is not None:
        return self_check(args.self_check, args.backfill, args.read_num)

    if not args.trace:
        ap.error("--trace is required (or use --list / --self-check)")

    policy = None
    if args.alg is None:
        if not args.policy:
            ap.error("give --policy NAME or --alg EXPR")
        policy = ALIASES.get(args.policy, args.policy)
        if policy not in POLICY_ALG:
            ap.error(f"unknown policy {args.policy!r}; see --list")

    try:
        r = run_one(args.trace, policy, args.alg, None, args.backfill,
                    args.out, args.procs, args.read_num)
    except RuntimeError as e:
        raise SystemExit(f"[error] {e}")
    status = "VALIDATED bit-exact" if policy in VALIDATED else \
             "translated (NOT bit-validated — run --self-check)" if policy else "raw alg"
    print(f"[python-engine] trace={r['trace']} policy={policy or '(raw)'} "
          f"backfill={args.backfill} total_procs={r['total']}")
    print(f"  alg = {r['alg']}")
    print(f"  status: {status}")
    print(f"  jobs={r['jobs']:,}  avg_wait={r['avg_wait']:.3f}s  ->  {r['out']}")


def self_check(trace_arg, backfill, read_num):
    """Cross-check every named policy: Python engine vs C++ engine, per-job wait."""
    import json, tempfile
    src = resolve_trace(trace_arg)
    total = read_maxprocs(src)
    bin_cpp = ROOT / "CQTwin" / "build" / "cqtwin"
    print(f"self-check on {src.name} (procs={total}, backfill={backfill})")
    print(f"{'policy':8} {'status':10} {'jobs':>7} {'exact%':>8} {'maxΔ(s)':>10}")
    for policy in POLICY_ALG:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            try:
                py = run_one(str(src), policy, None, None, backfill,
                             td / "py", total, read_num)
                pw = {int(r["job_id"]): float(r["wait"])
                      for r in csv.DictReader(open(td / "py" / "jobs.csv"))}
                # Match workloads: CQSim's SWF filter drops some jobs (e.g. polaris
                # 28,941/30,482). Feed C++ ONLY CQSim's admitted ids so both engines
                # schedule the identical set — same step run_validation.py performs.
                fswf = td / "filtered.swf"
                with open(src) as f, open(fswf, "w") as o:
                    for line in f:
                        if line.startswith(";"):
                            o.write(line); continue
                        p = line.split()
                        if p and int(p[0]) in pw:
                            o.write(line)
                drv = {"type": policy, "tag": "d", "backfilling": BACKFILL[backfill] > 0,
                       "legacy_backfill_mode": BACKFILL[backfill], "window_size": 1000000}
                cfg = {"swf_path": str(fswf), "mode": "real", "total_procs": total,
                       "legacy_cluster_fraction": 1.0, "legacy_start_time": 0,
                       "output_dir": str(td / "cpp"), "drivers": [drv]}
                (td / "c.json").write_text(json.dumps(cfg))
                subprocess.run([str(bin_cpp), "run", str(td / "c.json")],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                cw = {int(r["job_id"]): float(r["wait"])
                      for r in csv.DictReader(open(td / "cpp" / "d" / "jobs.csv"))}
                ids = set(pw) & set(cw)
                dmax = max((abs(pw[i] - cw[i]) for i in ids), default=0.0)
                exact = sum(1 for i in ids if pw[i] == cw[i])
                pct = 100.0 * exact / len(ids) if ids else 0.0
            except Exception as e:
                print(f"{policy:8} {'ERROR':10} {str(e)[:40]}")
                continue
            tag = "VALIDATED" if policy in VALIDATED else "translated"
            print(f"{policy:8} {tag:10} {len(ids):>7} {pct:>7.2f}% {dmax:>10.1f}")


if __name__ == "__main__":
    main()
