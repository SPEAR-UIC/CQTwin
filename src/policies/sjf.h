#pragma once
#include "sort_policy.h"

// Shortest Job First — shortest walltime gets highest priority
class SjfPolicy : public SortPolicy {
public:
    explicit SjfPolicy(int window_size = INT_MAX) : SortPolicy(window_size) {}
    std::string name() const override { return "sjf"; }
protected:
    bool compare(const Job* a, const Job* b, const State& s) const override {
        SimTime wa = walltime_for(a, s);
        SimTime wb = walltime_for(b, s);
        if (wa != wb) return wa < wb;
        return a->submit_time < b->submit_time;
    }
};
