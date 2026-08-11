#pragma once
#include "sort_policy.h"

// SWW: size-weighted wait. score = -(wait/walltime) * procs — lower score =
// higher priority. Linear weighted wait-to-walltime scaled by job size (requested
// processors), prioritizing large, long-waiting jobs to curb big-job starvation.
// Distinct from WFP1 (no size factor), the WFP2/WFP3 higher powers, and FAT
// (which cubes the *fractional* size procs/total instead of absolute procs).
class SwwPolicy : public SortPolicy {
public:
    explicit SwwPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "sww"; }
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
        return -(wait / wt) * j->requested.procs;
    }
};
