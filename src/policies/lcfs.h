#pragma once
#include "sort_policy.h"

// Last Come First Served — latest submit_time gets highest priority
class LcfsPolicy : public SortPolicy {
public:
    explicit LcfsPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "lcfs"; }
protected:
    bool compare(const Job* a, const Job* b, const State&) const override {
        if (a->submit_time != b->submit_time) return a->submit_time > b->submit_time;
        return a->id < b->id;
    }
};
