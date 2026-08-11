#pragma once
#include <cmath>
#include "sort_policy.h"

// F3: score = walltime * procs + 6.86e6 * log10(submit_time)
class F3Policy : public SortPolicy {
public:
    explicit F3Policy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "f3"; }
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
        return wt * j->requested.procs + 6.86e6 * std::log10(sub);
    }
};
