#pragma once
#include <cmath>
#include "sort_policy.h"

// UNICEP: score = -(wait) / (log2(procs/total_procs) * walltime)
// Same formula as UNICEF; preserved as a distinct policy for experiment registry compatibility.
class UnicepPolicy : public SortPolicy {
public:
    explicit UnicepPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "unicep"; }
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
        int total  = 0;
        for (const auto& n : s.nodes) total += n.total.procs;
        if (total == 0) return 0.0;
        double size_ratio = static_cast<double>(j->requested.procs) / total;
        if (size_ratio <= 0) size_ratio = 1e-10;
        double denom = std::log2(size_ratio) * wt;
        if (denom == 0.0) return 0.0;
        double wait = static_cast<double>(s.current_time - j->submit_time);
        return -wait / denom;
    }
};
