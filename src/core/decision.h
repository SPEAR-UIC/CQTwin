#pragma once

#include <vector>

enum class DecisionType {
    Start,    // dispatch a job to nodes
    Hold,     // move job to held state, stop it being scheduled
    Cancel,   // terminate a job
    Preempt,  // kill a running job to free resources for another
};

struct Decision {
    DecisionType      type;
    int               job_id;
    std::vector<int>  node_ids;  // target nodes (required for Start and Preempt)
    bool              is_backfill = false;
};
