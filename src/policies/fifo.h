#pragma once

#include <string>
#include <vector>
#include "../core/policy.h"

class FifoPolicy : public SchedulerPolicy {
public:
    std::vector<Decision> schedule(const State& s) override {
        std::vector<Decision> decisions;

        // Copy node availability so we can track tentative allocations
        std::vector<NodeInfo> nodes = s.nodes;

        bool any_higher_skipped = false;
        for (const Job* job : s.pending) {
            bool is_backfill = any_higher_skipped;
            bool scheduled = false;
            for (NodeInfo& node : nodes) {
                if (node.can_fit(job->requested)) {
                    node.allocate(job->requested);
                    decisions.push_back({DecisionType::Start, job->id, {node.id}, is_backfill});
                    scheduled = true;
                    break;
                }
            }
            if (!scheduled)
                any_higher_skipped = true;
        }

        return decisions;
    }

    std::string name() const override { return "fifo"; }
};
