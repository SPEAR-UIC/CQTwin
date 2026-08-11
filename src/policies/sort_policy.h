#pragma once

#include <algorithm>
#include <climits>
#include "../core/policy.h"

// Base for policies that sort a window of pending jobs then dispatch greedily.
// Subclasses implement compare() to define priority ordering.
class SortPolicy : public SchedulerPolicy {
public:
    explicit SortPolicy(int window_size = INT_MAX) : window_size_(window_size) {}

    std::vector<const Job*> order(const State& s) override {
        std::vector<const Job*> jobs = s.pending;

        int w = std::min(window_size_, static_cast<int>(jobs.size()));
        std::stable_sort(jobs.begin(), jobs.begin() + w,
                         [this, &s](const Job* a, const Job* b) {
                             return compare(a, b, s);
                         });
        return jobs;
    }

    std::vector<Decision> schedule(const State& s) override {
        std::vector<const Job*> jobs = order(s);
        int w = std::min(window_size_, static_cast<int>(jobs.size()));

        last_head_job_id_ = jobs.empty() ? -1 : jobs[0]->id;

        std::vector<NodeInfo> nodes = s.nodes;
        std::vector<Decision> decisions;
        bool any_higher_skipped = false;

        for (int i = 0; i < static_cast<int>(jobs.size()); ++i) {
            const Job* job = jobs[i];
            bool is_backfill = any_higher_skipped || (i >= w);

            bool scheduled = false;
            for (NodeInfo& node : nodes) {
                if (node.can_fit(job->requested)) {
                    node.allocate(job->requested);
                    decisions.push_back({DecisionType::Start, job->id, {node.id}, is_backfill});
                    scheduled = true;
                    break;
                }
            }

            if (!scheduled && i < w)
                any_higher_skipped = true;
        }
        return decisions;
    }

    int last_cycle_root_branching() const override { return 1; }
    std::string last_cycle_possible_policies() const override {
        return last_head_job_id_ >= 0
            ? "|" + std::to_string(last_head_job_id_) + "|"
            : "";
    }

    // Return true if a has higher priority than b.
    // Public so MCTS can reuse comparators without going through schedule().
    virtual bool compare(const Job* a, const Job* b, const State& s) const = 0;

protected:
    static SimTime walltime_for(const Job* job, const State& s) {
        auto it = s.job_walltimes.find(job->id);
        if (it != s.job_walltimes.end())
            return it->second;
        return job->walltime;
    }

    int window_size_;
    int last_head_job_id_ = -1;
};
