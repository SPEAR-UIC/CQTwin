#pragma once
#include "sort_policy.h"

// Largest Resource First — most procs gets highest priority
class LrfPolicy : public SortPolicy {
public:
    explicit LrfPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "lrf"; }
protected:
    bool compare(const Job* a, const Job* b, const State&) const override {
        if (a->requested.procs != b->requested.procs)
            return a->requested.procs > b->requested.procs;
        return a->submit_time < b->submit_time;
    }
};
