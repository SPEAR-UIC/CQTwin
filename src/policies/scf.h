#pragma once
#include "sort_policy.h"

// Smallest Core Hours First — walltime * procs ascending
class ScfPolicy : public SortPolicy {
public:
    explicit ScfPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "scf"; }
protected:
    bool compare(const Job* a, const Job* b, const State& s) const override {
        double ca = static_cast<double>(walltime_for(a, s)) * a->requested.procs;
        double cb = static_cast<double>(walltime_for(b, s)) * b->requested.procs;
        if (ca != cb) return ca < cb;
        return a->submit_time < b->submit_time;
    }
};
