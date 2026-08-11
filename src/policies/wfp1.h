#pragma once
#include "sort_policy.h"

// WFP1: score = -(wait/walltime) — lower score = higher priority
class Wfp1Policy : public SortPolicy {
public:
    explicit Wfp1Policy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "wfp1"; }
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
        return -(wait / wt);
    }
};
