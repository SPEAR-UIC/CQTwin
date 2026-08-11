#pragma once

#include <vector>

#include "../../core/sim_time.h"

// A period during which nodes are unavailable.
// If node_ids is empty, the entire cluster is affected.
// If node_ids is populated, only those specific nodes are affected.
// Scheduled windows are known in advance (notice_time < start_time).
// Unscheduled (emergency) windows have notice_time == start_time.
struct MaintenanceWindow {
    SimTime          notice_time;  // when the scheduler learns about this
    SimTime          start_time;   // nodes go down
    SimTime          end_time;     // nodes come back
    bool             scheduled;    // true = planned, false = emergency
    std::vector<int> node_ids;     // affected nodes; empty = whole cluster
};
