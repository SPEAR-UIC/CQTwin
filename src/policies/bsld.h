#pragma once
#include <algorithm>
#include "sort_policy.h"

// BSLD: bounded-slowdown priority. Dispatch the job with the largest projected
// bounded slowdown first, which improves fairness for jobs delayed relative to
// their runtime. Bounded slowdown is the standard HPC fairness metric:
//     bsld = max(1, (wait + run) / max(run, tau))
// At dispatch time the actual runtime is unknown, so the requested walltime
// estimates `run` (as the other ratio policies do via walltime_for).
//
// `tau` is the short-job threshold that bounds the slowdown of small jobs. It
// must be set within the walltime distribution to actually bite: with the classic
// tau=10s, every HPC job has walltime >> tau, so max(run,tau)=run and bsld reduces
// to 1 + wait/run — the *same ordering* as WFP1. We use tau = 1h (3600s), a
// characteristic short-job length, so the bound is active for a large fraction of
// jobs and BSLD orders distinctly from WFP1. SortPolicy treats a lower score as
// higher priority, so we return -bsld.
class BsldPolicy : public SortPolicy {
public:
    explicit BsldPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "bsld"; }
protected:
    bool compare(const Job* a, const Job* b, const State& s) const override {
        double sa = score(a, s), sb = score(b, s);
        if (sa != sb) return sa < sb;
        return a->submit_time < b->submit_time;
    }
private:
    static constexpr double kTau = 3600.0;  // short-job threshold, 1h (seconds)
    static double score(const Job* j, const State& s) {
        double wt = static_cast<double>(walltime_for(j, s));
        if (wt <= 0.0) wt = 1.0;
        double wait = static_cast<double>(s.current_time - j->submit_time);
        if (wait < 0.0) wait = 0.0;
        double bsld = (wait + wt) / std::max(wt, kTau);
        if (bsld < 1.0) bsld = 1.0;
        return -bsld;
    }
};
