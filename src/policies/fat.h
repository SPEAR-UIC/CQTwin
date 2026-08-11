#pragma once
#include <cmath>
#include "sort_policy.h"

// FAT: score = -(wait/walltime) * (procs/total_procs)^3
class FatPolicy : public SortPolicy {
public:
    explicit FatPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "fat"; }
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
        int total   = 0;
        for (const auto& n : s.nodes) total += n.total.procs;
        if (total == 0) return 0.0;
        double nr = static_cast<double>(j->requested.procs) / total;
        return -(wait / wt) * nr * nr * nr;
    }
};
