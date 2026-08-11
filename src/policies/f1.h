#pragma once
#include <cmath>
#include "sort_policy.h"

// F1: score = log10(walltime) * procs + 870 * log10(submit_time)
class F1Policy : public SortPolicy {
public:
    explicit F1Policy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "f1"; }
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
        double sub = j->submit_time > 0 ? static_cast<double>(j->submit_time) : 1.0;
        return std::log10(wt) * j->requested.procs + 870.0 * std::log10(sub);
    }
};
