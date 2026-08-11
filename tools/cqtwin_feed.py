#!/usr/bin/env python3
"""CQTwin trace-replay feeder — the stream-mode validation driver.

Reads an SWF file *client-side* and pushes its jobs to a stream-mode CQTwin
(`online-serve` with `workload.mode: "stream"`) over the NDJSON socket, exactly
as a live site adapter would. Two pacing strategies:

  --pace event  (default): deliver each submit-time group of jobs, then assert
                 `stream_advance(until=t)` — the twin simulates up to t, we drive
                 any decisions the agent must make, then move to the next group.
                 This exercises the frontier/waiting_for_events logic every step.
  --pace bulk :  push every job, then `stream_end` — the twin runs the whole
                 episode out. Fast path for tests; no frontier round-trips.

Works with any agent from cqsim_online (FixedSelector, GreedyProjectionSelector,
RandomSelector). The twin applies the SAME shared SWF record builder to the raw
fields we send, so a stream-fed run is byte-identical to a trace-fed one — see
tests/test_online_stream.cpp and docs/live-adapter.md.

Field mapping (SWF 1-indexed -> submit_job): we send the RAW fields and let the
engine clamp runtime to the request and validate, so the kept-job set and every
record match SwfReader exactly. Do not pre-clamp here.
"""
from __future__ import annotations

import argparse
import json
from typing import Iterable

from cqsim_online import (
    CQSimOnlineEnv,
    FixedSelector,
    GreedyProjectionSelector,
    RandomSelector,
)


# ── SWF parsing (client-side) ─────────────────────────────────────────────────

def read_swf_jobs(path: str) -> list[dict]:
    """Parse an SWF file into submit_job payloads carrying the RAW SWF fields.
    Invalid rows are NOT filtered here — the engine's shared record builder
    applies the identical validity filter, keeping the stream set == trace set."""
    jobs: list[dict] = []
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith(";"):
                continue
            f = line.split()
            if len(f) < 9:
                continue
            try:
                job = {
                    "id":                 int(float(f[0])),
                    "submit_time":        float(f[1]),
                    "runtime":            float(f[3]),          # SWF field 4
                    "allocated_procs":    int(float(f[4])),     # SWF field 5
                    "requested_procs":    int(float(f[7])),     # SWF field 8
                    "requested_walltime": float(f[8]),          # SWF field 9
                }
                if len(f) > 9:
                    job["requested_memory"] = int(float(f[9]))
                if len(f) > 11:
                    job["user_id"] = int(float(f[11]))
                if len(f) > 12:
                    job["group_id"] = int(float(f[12]))
                if len(f) > 14:
                    job["queue_id"] = int(float(f[14]))
            except (ValueError, IndexError):
                continue
            jobs.append(job)
    # Stable sort by submit_time preserving file order for ties — the same order
    # the engine's stable_sort produces, so decisions line up with trace mode.
    jobs.sort(key=lambda j: j["submit_time"])
    return jobs


# ── Stream-mode client (adds the stream cmds to the base env) ─────────────────

class CQTwinStreamEnv(CQSimOnlineEnv):
    """CQSimOnlineEnv plus the stream-ingestion commands, returning raw responses
    (so callers can read the `status` field: decision/waiting_for_events/terminal)."""

    def reset_raw(self) -> dict:
        resp = self._request({"cmd": "reset"})
        obs = resp.get("obs", {})
        self._pool = obs.get("pool", [])
        self.action_count = int(resp.get("info", {}).get("action_count", len(self._pool)))
        return resp

    def submit_jobs(self, jobs: Iterable[dict]) -> dict:
        jobs = list(jobs)
        if len(jobs) == 1:
            return self._request({"cmd": "submit_job", "job": jobs[0]})
        return self._request({"cmd": "submit_job", "jobs": jobs})

    def stream_advance(self, until: float) -> dict:
        return self._request({"cmd": "stream_advance", "until": float(until)})

    def stream_end(self) -> dict:
        return self._request({"cmd": "stream_end"})

    def step_raw(self, action: int) -> dict:
        return self._request({"cmd": "step", "action": int(action)})


# ── Driving decisions ─────────────────────────────────────────────────────────

def _drive_decisions(env: CQTwinStreamEnv, resp: dict, agent, stats: dict) -> dict:
    """While the twin is parked at a decision, let the agent step it. Returns the
    first non-decision response (waiting_for_events or terminal)."""
    while resp.get("status") == "decision":
        action = agent.choose(resp["obs"])
        resp = env.step_raw(action)
        stats["steps"] += 1
        stats["total_reward"] += float(resp.get("reward", 0.0))
    return resp


def _account_rejections(resp: dict, stats: dict) -> None:
    rej = resp.get("rejected") or []
    stats["accepted"] += len(resp.get("accepted") or [])
    stats["rejected"] += len(rej)
    for r in rej:
        stats["reject_reasons"][r.get("reason", "?")] = (
            stats["reject_reasons"].get(r.get("reason", "?"), 0) + 1)


# ── Pacing strategies ─────────────────────────────────────────────────────────

def feed_bulk(env: CQTwinStreamEnv, jobs: list[dict], agent,
              batch_size: int = 5000) -> dict:
    stats = _new_stats()
    env.reset_raw()
    for i in range(0, len(jobs), batch_size):
        _account_rejections(env.submit_jobs(jobs[i:i + batch_size]), stats)
    resp = env.stream_end()
    resp = _drive_decisions(env, resp, agent, stats)
    if resp.get("status") != "terminal":
        raise RuntimeError(f"bulk feed did not terminate: status={resp.get('status')}")
    stats["summary"] = resp.get("info", {}).get("summary", {})
    return stats


def feed_event(env: CQTwinStreamEnv, jobs: list[dict], agent) -> dict:
    stats = _new_stats()
    env.reset_raw()
    i, n = 0, len(jobs)
    while i < n:
        t = jobs[i]["submit_time"]
        j = i
        while j < n and jobs[j]["submit_time"] == t:   # all jobs at exactly t
            j += 1
        _account_rejections(env.submit_jobs(jobs[i:j]), stats)
        i = j
        # Assert the stream is complete through t and drive resulting decisions.
        resp = env.stream_advance(t)
        _drive_decisions(env, resp, agent, stats)
    resp = env.stream_end()
    resp = _drive_decisions(env, resp, agent, stats)
    if resp.get("status") != "terminal":
        raise RuntimeError(f"event feed did not terminate: status={resp.get('status')}")
    stats["summary"] = resp.get("info", {}).get("summary", {})
    return stats


def _new_stats() -> dict:
    return {"steps": 0, "total_reward": 0.0, "accepted": 0, "rejected": 0,
            "reject_reasons": {}, "summary": {}}


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="CQTwin trace-replay stream feeder")
    ap.add_argument("config", help="stream-mode online_env.json (workload.mode=stream)")
    ap.add_argument("swf", help="SWF trace to replay as a live stream")
    ap.add_argument("--pace", choices=["event", "bulk"], default="event")
    ap.add_argument("--agent", choices=["fixed", "greedy", "random"], default="fixed")
    ap.add_argument("--fixed-policy", default="wfp3")
    ap.add_argument("--batch-size", type=int, default=5000)
    ap.add_argument("--engine-bin", default=None)
    args = ap.parse_args()

    jobs = read_swf_jobs(args.swf)
    env = CQTwinStreamEnv(args.config, engine_bin=args.engine_bin)
    try:
        env.reset_raw()  # populate action_count (RandomSelector needs it); feed_* resets again
        agent = (FixedSelector(args.fixed_policy) if args.agent == "fixed"
                 else GreedyProjectionSelector() if args.agent == "greedy"
                 else RandomSelector(env.action_count))
        if args.pace == "bulk":
            stats = feed_bulk(env, jobs, agent, batch_size=args.batch_size)
        else:
            stats = feed_event(env, jobs, agent)
    finally:
        env.close()

    out = {
        "pace": args.pace,
        "agent": args.agent,
        "jobs_read": len(jobs),
        "accepted": stats["accepted"],
        "rejected": stats["rejected"],
        "reject_reasons": stats["reject_reasons"],
        "steps": stats["steps"],
        "summary": stats["summary"],
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
