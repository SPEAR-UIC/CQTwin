#pragma once

#include "simulator.h"
#include "../../core/policy.h"
#include <deque>
#include <vector>

struct LegacyDispatchConfig {
    bool backfill = false;
    int  backfill_mode = 0;
};

std::vector<int> legacy_backfill_candidates(const Simulator& s,
                                            const std::deque<int>& remaining,
                                            SimTime current_time,
                                            SimMode mode,
                                            int backfill_mode);

std::deque<int> dispatch_ordered_jobs(Simulator& s,
                                      SchedulerPolicy* policy,
                                      SimTime current_time,
                                      int& primary_started,
                                      int& backfill_started);

void install_legacy_scheduling_callback(Simulator& sim,
                                        SchedulerPolicy* policy,
                                        const LegacyDispatchConfig& config,
                                        int* cycle_primary_started,
                                        int* cycle_backfill_started);
