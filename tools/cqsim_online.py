#!/usr/bin/env python3
"""Gym-style Python client for the CQTwin online scheduling environment.

Offline = trace replay under one fixed policy (`cqtwin run`).
Online  = the same trace/cluster, but your agent picks which policy (from the
          configured pool) to apply at each scheduling decision.

This module spawns `cqtwin online-serve <config>` and drives it over the
NDJSON socket protocol (docs/CQTwin_ONLINE_SIMULATION.md §8), exposing a
reset()/step() loop your auto-policy-selection agent drives:

    from cqsim_online import make_online_env, RandomSelector

    env = make_online_env("online_env.json")          # C++ engine (default)
    obs, info = env.reset()
    agent = RandomSelector(env.action_count)
    done = False
    while not done:
        action = agent.choose(obs)
        obs, reward, done, truncated, info = env.step(action)
    env.close()

Engine choice (scripting-only): `make_online_env(cfg, engine="python")` — or a
top-level `"engine": "python"` in the config, or `--engine python` on the CLI —
runs the legacy **Python CQSim** engine instead of the C++ engine. The Python
engine is batch-only, so it supports a **fixed committed policy only** (identical
to its offline replay); advisory projections and adaptive per-cycle selection
stay C++-only and raise if requested. Default is the C++ engine.
"""

from __future__ import annotations

import csv
import json
import math
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional


def _default_engine_bin() -> str:
    env = os.environ.get("CQTWIN_BIN")
    if env:
        return env
    # tools/cqsim_online.py -> repo root -> build/cqtwin
    return str(Path(__file__).resolve().parent.parent / "build" / "cqtwin")


class CQSimOnlineEnv:
    """Drives one `cqtwin online-serve` process as a steppable environment."""

    def __init__(
        self,
        config_path: str,
        engine_bin: Optional[str] = None,
        host: str = "127.0.0.1",
        connect_timeout: float = 10.0,
    ):
        self.config_path = str(config_path)
        self.engine_bin = engine_bin or _default_engine_bin()
        self.host = host
        self._proc: Optional[subprocess.Popen] = None
        self._sock: Optional[socket.socket] = None
        self._rfile = None
        self._wfile = None
        self.action_count = 0
        self._pool: list[str] = []
        self._launch(connect_timeout)

    # ── lifecycle ────────────────────────────────────────────────────────────

    def _launch(self, timeout: float) -> None:
        if not Path(self.engine_bin).exists():
            raise FileNotFoundError(
                f"engine binary not found: {self.engine_bin} "
                f"(build it, or set CQTWIN_BIN)"
            )
        self._proc = subprocess.Popen(
            [self.engine_bin, "online-serve", self.config_path,
             "--host", self.host, "--port", "0"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        # Wait for the "LISTENING <port>" handshake line.
        port = None
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if line.startswith("LISTENING"):
                port = int(line.split()[1])
                break
        if port is None:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"engine failed to start: {err.strip()}")

        self._sock = socket.create_connection((self.host, port), timeout=timeout)
        self._sock.settimeout(None)
        self._rfile = self._sock.makefile("r", encoding="utf-8", newline="\n")
        self._wfile = self._sock.makefile("w", encoding="utf-8", newline="\n")

    def _request(self, obj: dict) -> dict:
        assert self._wfile is not None and self._rfile is not None
        self._wfile.write(json.dumps(obj) + "\n")
        self._wfile.flush()
        line = self._rfile.readline()
        if not line:
            raise RuntimeError("engine closed the connection unexpectedly")
        resp = json.loads(line)
        if isinstance(resp, dict) and "error" in resp:
            raise RuntimeError(f"engine error: {resp['error']}")
        return resp

    # ── gym-style API ────────────────────────────────────────────────────────

    def reset(self) -> tuple[dict, dict]:
        resp = self._request({"cmd": "reset"})
        obs = resp["obs"]
        info = resp.get("info", {})
        self._pool = obs.get("pool", [])
        self.action_count = int(info.get("action_count", len(self._pool)))
        return obs, info

    def step(self, action: int) -> tuple[dict, float, bool, bool, dict]:
        resp = self._request({"cmd": "step", "action": int(action)})
        return (
            resp["obs"],
            float(resp["reward"]),
            bool(resp["done"]),
            bool(resp.get("truncated", False)),
            resp.get("info", {}),
        )

    def close(self) -> None:
        try:
            if self._wfile is not None:
                self._request({"cmd": "close"})
        except Exception:
            pass
        for f in (self._rfile, self._wfile):
            try:
                if f:
                    f.close()
            except Exception:
                pass
        try:
            if self._sock:
                self._sock.close()
        except Exception:
            pass
        if self._proc is not None:
            try:
                self._proc.wait(timeout=5)
            except Exception:
                self._proc.kill()

    def __enter__(self) -> "CQSimOnlineEnv":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ── Python-engine backend (optional, fixed committed policy only) ─────────────


def _summary_from_jobscsv(path: Path) -> dict:
    waits, ends, submits = [], [], []
    for r in csv.DictReader(open(path)):
        waits.append(float(r["wait"])); ends.append(float(r["end"]))
        submits.append(float(r["submit"]))
    n = len(waits)
    if n == 0:
        return {"avg_wait": 0.0, "completed": 0, "makespan": 0.0,
                "p90_wait": 0.0, "p99_wait": 0.0}
    sw = sorted(waits)
    pct = lambda p: sw[min(n - 1, max(0, math.ceil(p * n) - 1))]
    return {"avg_wait": sum(waits) / n, "completed": n,
            "makespan": max(ends) - min(submits),
            "p90_wait": pct(0.90), "p99_wait": pct(0.99)}


class PythonFixedOnlineEnv:
    """Online-env façade backed by the **legacy Python CQSim engine**.

    Same reset()/step()/close() API as CQSimOnlineEnv so scripts can swap engines
    with one flag. The Python engine is a batch simulator with no per-cycle
    switching or forking, so this supports **only a fixed committed policy** — a
    run that is, by construction, identical to the Python engine's offline replay
    of that policy (fixed online ≡ offline; see docs/live-adapter.md).

    Advisory projections and adaptive per-cycle selection are NOT available on the
    Python engine — an `obs.include_advisory` config, or an agent that changes the
    committed policy mid-episode, raises RuntimeError. Use the C++ engine (default)
    for those.
    """

    _BF = {0: "none", 1: "easy", 2: "cons"}

    def __init__(self, config_path: str):
        # Import the offline Python runner (sibling module).
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import run_python_engine as _pyeng
        self._pyeng = _pyeng

        self.config_path = str(config_path)
        cfg = json.loads(Path(config_path).read_text())
        cfg_dir = Path(config_path).resolve().parent

        if cfg.get("obs", {}).get("include_advisory", False):
            raise RuntimeError(
                "Python engine does not support advisory projections "
                "(obs.include_advisory=true); use the C++ engine (default) for "
                "advisory or adaptive online.")

        pool = cfg.get("pool", [])
        if not pool:
            raise RuntimeError("online config has no 'pool'")
        self._pool_entries = pool
        self._pool = [p["type"] for p in pool]
        self.action_count = len(pool)

        # Resolve trace + cluster from the same config the C++ engine reads.
        swf = cfg.get("swf_path", "")
        self._swf = self._resolve_swf(cfg_dir, swf)
        self._procs = (cfg.get("cluster", {}).get("total_procs")
                       or cfg.get("total_procs") or 0)
        self._read_num = int(cfg.get("max_submits") or 200000)
        if self._read_num >= 2_147_483_647:
            self._read_num = 200000
        self._out_dir = cfg.get("output_dir")
        self._committed: Optional[int] = None
        self._summary: dict = {}
        self._tmp: Optional[str] = None

    @staticmethod
    def _resolve_swf(cfg_dir: Path, swf: str) -> str:
        if not swf:
            raise RuntimeError("online config missing 'swf_path' (needed for the Python engine)")
        p = Path(swf)
        for cand in (p, cfg_dir / swf, Path.cwd() / swf,
                     Path(__file__).resolve().parent.parent / swf):  # repo/<swf_path>
            if cand.exists():
                return str(cand.resolve())
        return swf  # let run_python_engine try its InputFiles lookup by name

    # ── gym-style API ────────────────────────────────────────────────────────

    def reset(self) -> tuple[dict, dict]:
        self._committed = None
        self._summary = {}
        obs = {"pool": list(self._pool), "step": 0, "time": 0, "queued": [], "engine": "python"}
        return obs, {"action_count": self.action_count, "engine": "python"}

    def step(self, action: int) -> tuple[dict, float, bool, bool, dict]:
        action = int(action)
        if self._committed is not None and action != self._committed:
            raise RuntimeError(
                f"Python engine is fixed-policy only: cannot switch committed policy "
                f"from '{self._pool[self._committed]}' to '{self._pool[action]}' "
                f"mid-episode. Use the C++ engine (default) for adaptive selection.")
        if self._committed is None:
            self._committed = action
            entry = self._pool_entries[action]
            policy = entry["type"]
            bf = self._BF.get(entry.get("legacy_backfill_mode",
                                        1 if entry.get("backfilling", False) else 0), "easy")
            if self._out_dir:
                out = Path(self._out_dir)
            else:
                self._tmp = tempfile.mkdtemp()
                out = Path(self._tmp)
            r = self._pyeng.run_one(self._swf, self._pyeng.ALIASES.get(policy, policy),
                                    None, None, bf, out, self._procs, self._read_num)
            self._summary = _summary_from_jobscsv(Path(r["out"]))
            self._summary["engine"] = "python"
            self._summary["committed_policy"] = policy
        obs = {"pool": list(self._pool), "step": 1, "time": 0, "done": True, "engine": "python"}
        return obs, 0.0, True, False, {"summary": self._summary, "engine": "python"}

    def close(self) -> None:
        if self._tmp:
            shutil.rmtree(self._tmp, ignore_errors=True)
            self._tmp = None

    def __enter__(self) -> "PythonFixedOnlineEnv":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def make_online_env(config_path: str, engine: Optional[str] = None,
                    engine_bin: Optional[str] = None, **kw):
    """Return an online env backed by the chosen engine.

    engine: "cpp" (default) or "python". If None, read the config's top-level
    "engine" field, else default to "cpp". The Python backend supports a fixed
    committed policy only (see PythonFixedOnlineEnv).
    """
    if engine is None:
        try:
            engine = json.loads(Path(config_path).read_text()).get("engine", "cpp")
        except Exception:
            engine = "cpp"
    if engine == "python":
        return PythonFixedOnlineEnv(config_path)
    if engine != "cpp":
        raise ValueError(f"unknown engine {engine!r} (expected 'cpp' or 'python')")
    return CQSimOnlineEnv(config_path, engine_bin=engine_bin, **kw)


# ── Example agents ───────────────────────────────────────────────────────────


class RandomSelector:
    """Uniformly random policy each decision (a baseline for 'does it matter?')."""

    def __init__(self, action_count: int, seed: int = 0):
        self.n = action_count
        self.rng = random.Random(seed)

    def choose(self, obs: dict) -> int:
        return self.rng.randrange(self.n)


class FixedSelector:
    """Always apply one policy (name or pool index). Reproduces an offline run,
    and is the driver for headless advisory.csv logging (fixed committed policy)."""

    def __init__(self, policy):
        self.policy = policy
        self._idx = None

    def choose(self, obs: dict) -> int:
        if self._idx is None:
            self._idx = (self.policy if isinstance(self.policy, int)
                         else obs.get("pool", []).index(self.policy))
        return self._idx


class GreedyProjectionSelector:
    """Pick the pool policy with the smallest projected average wait.

    Requires `obs.include_advisory: true` in the config so each observation
    carries per-policy projections. Falls back to action 0 if unavailable.
    """

    def choose(self, obs: dict) -> int:
        pool = obs.get("pool", [])
        adv = obs.get("advisory", [])
        if not adv or not pool:
            return 0
        best_name, best_wait = None, float("inf")
        for row in adv:
            w = row.get("proj_avg_wait", float("inf"))
            if row.get("proj_jobs_started", 0) > 0 and w < best_wait:
                best_name, best_wait = row.get("policy"), w
        if best_name is None:  # nobody could start a job; take lowest projection
            best_name = min(adv, key=lambda r: r.get("proj_avg_wait", float("inf")))["policy"]
        try:
            return pool.index(best_name)
        except ValueError:
            return 0


# ── CLI: run one episode and print the summary ───────────────────────────────


def run_episode(env: CQSimOnlineEnv, agent) -> dict:
    obs, _info = env.reset()
    done = False
    total_reward = 0.0
    steps = 0
    last_info: dict = {}
    while not done:
        action = agent.choose(obs)
        obs, reward, done, _trunc, last_info = env.step(action)
        total_reward += reward
        steps += 1
    summary = last_info.get("summary", {})
    summary["steps"] = steps
    summary["total_reward"] = total_reward
    return summary


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Drive the CQTwin online environment.")
    ap.add_argument("config", help="path to online_env.json")
    ap.add_argument("--engine", choices=["cpp", "python"], default=None,
                    help="simulation engine (default: config 'engine' field, else cpp). "
                         "python = legacy CQSim, fixed committed policy only.")
    ap.add_argument("--agent", choices=["random", "greedy", "fixed"], default="random")
    ap.add_argument("--fixed-policy", default="fcfs",
                    help="policy name or pool index for --agent fixed")
    ap.add_argument("--episodes", type=int, default=1)
    ap.add_argument("--engine-bin", default=None)
    args = ap.parse_args()

    def make_agent(env):
        if args.agent == "greedy":
            return GreedyProjectionSelector()
        if args.agent == "fixed":
            p = args.fixed_policy
            return FixedSelector(int(p) if p.isdigit() else p)
        return RandomSelector(env.action_count if env.action_count else 1)

    with make_online_env(args.config, engine=args.engine, engine_bin=args.engine_bin) as env:
        agent = make_agent(env)
        for ep in range(args.episodes):
            summary = run_episode(env, agent)
            print(f"[episode {ep}] {json.dumps(summary)}")


if __name__ == "__main__":
    main()
