#pragma once
#include "sort_policy.h"

// Smallest Resource First — fewest procs gets highest priority
class SrfPolicy : public SortPolicy {
public:
    explicit SrfPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "srf"; }
protected:
    bool compare(const Job* a, const Job* b, const State&) const override {
        if (a->requested.procs != b->requested.procs)
            return a->requested.procs < b->requested.procs;
        return a->submit_time < b->submit_time;
    }
};
