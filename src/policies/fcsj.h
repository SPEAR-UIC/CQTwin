#pragma once
#include "sort_policy.h"

// FCSJ: size-normalized wait-to-walltime. score = -wait / (walltime * procs) —
// the wait-to-walltime ratio further divided by job size, so among long-waiting
// jobs the smaller ones get priority (favors small jobs; curbs their starvation).
// Distinct from WFP1 (-wait/walltime, no size term) and SWW (-(wait/walltime)*procs,
// which multiplies rather than divides by size).
class FcsjPolicy : public SortPolicy {
public:
    explicit FcsjPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "fcsj"; }
protected:
    bool compare(const Job* a, const Job* b, const State& s) const override {
        double sa = score(a, s), sb = score(b, s);
        if (sa != sb) return sa < sb;
        return a->submit_time < b->submit_time;
    }
private:
    static double score(const Job* j, const State& s) {
        double wt = static_cast<double>(walltime_for(j, s));
        if (wt <= 0.0) wt = 1.0;
        double procs = static_cast<double>(j->requested.procs);
        if (procs <= 0.0) procs = 1.0;
        double wait = static_cast<double>(s.current_time - j->submit_time);
        return -wait / (wt * procs);
    }
};
