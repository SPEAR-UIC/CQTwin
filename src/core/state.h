#pragma once

#include <vector>
#include <unordered_map>
#include "job.h"
#include "node.h"
#include "sim_time.h"

class Simulator;  // forward declaration for policies that need simulator access

struct State {
    std::vector<NodeInfo>                     nodes;
    std::vector<const Job*>                   pending;
    std::vector<const Job*>                   running;
    std::unordered_map<int, std::vector<int>> job_to_nodes;
    std::unordered_map<int, SimTime>          job_walltimes;
    SimTime                                   current_time = 0;
    const Simulator*                          sim = nullptr;  // set in simulation context; null elsewhere
};
