#pragma once
#include "sort_policy.h"

// WFP2: score = -(wait/walltime)^2 * procs — lower score = higher priority.
// The quadratic sibling of WFP1 (linear, no size factor) and WFP3 (cubic * procs);
// mirrors WFP3's structure with a squared wait-to-walltime ratio, so it orders
// distinctly from both.
class Wfp2Policy : public SortPolicy {
public:
    explicit Wfp2Policy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "wfp2"; }
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
        double wait = static_cast<double>(s.current_time - j->submit_time);
        double r = wait / wt;
        return -(r * r) * j->requested.procs;
    }
};
