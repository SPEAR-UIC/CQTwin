// Projection-copy equivalence guard.
//
// OnlineEnv::project_policy() rolls a bounded-horizon projection forward on
// sim_->get_projection_copy() instead of sim_->get_copy(false). The projection
// copy starts the append-only history structures (completed_jobs_,
// first_start_times_, completed_end_times_) EMPTY to avoid an O(N) copy per
// projection. That is only safe if a bounded rollout never depends on pre-fork
// history — i.e. a rollout on the light copy produces exactly the same schedule
// as one on a full copy.
//
// This test forks BOTH ways at several mid-run decision points, rolls each fork
// forward under the same policy + backfill to the same horizon, and asserts the
// projection-relevant outputs are identical: per-queued-job start time and
// completion, plus post-rollout free procs and the set of completions. If the
// light copy ever diverged (e.g. some path read pre-fork history), this fails.

#include <gtest/gtest.h>

#include <filesystem>
#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

#include "adapters/env/online_env.h"
#include "adapters/simulation/legacy_dispatch.h"
#include "adapters/simulation/simulator.h"
#include "policies/policy_factory.h"

namespace {

std::string find_trace() {
    for (const char* c : {"../data/InputFiles/polaris_2023.swf",
                          "data/InputFiles/polaris_2023.swf",
                          "../data/InputFiles/polaris_norm.swf",
                          "data/InputFiles/polaris_norm.swf",
                          // fallback bundled in the clean repo (self-contained test)
                          "../data/InputFiles/mira_norm.swf",
                          "data/InputFiles/mira_norm.swf"})
        if (std::filesystem::exists(c)) return c;
    return "";
}

// Roll a fork forward to `deadline` under `policy` + `bf`, exactly as
// OnlineEnv::project_policy does (inject an initial cycle if none is pending).
void roll_forward(Simulator& fork, SchedulerPolicy* policy,
                  const LegacyDispatchConfig& bf, SimTime deadline) {
    install_legacy_scheduling_callback(fork, policy, bf, nullptr, nullptr);
    auto nx = fork.peek();
    if (!nx || nx->type != EventType::SchedulingCycle)
        fork.inject_scheduling_cycle();
    while (fork.has_events()) {
        auto e = fork.peek();
        if (!e || e->time > deadline) break;
        fork.step();
    }
}

}  // namespace

TEST(OnlineProjectionCopy, LightCopyRolloutMatchesFullCopy) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";

    OnlineEnvConfig cfg;
    cfg.swf_path    = swf;
    cfg.mode        = SimMode::Normal;
    cfg.max_submits = 2000;                       // contended: real backlog + running jobs
    const LegacyDispatchConfig bf{ true, 1 };     // EASY backfill — exercises reservations
    cfg.pool = { PoolEntry{ "wfp3", 64, bf } };

    OnlineEnv env(cfg);
    env.reset();

    const SimTime H = 86400;
    int inspected = 0;
    int inspections_with_history = 0;   // non-vacuity: pre-fork completions existed

    for (int step = 0; !env.done(); ++step) {
        if (step == 20 || (step > 0 && step % 400 == 0)) {
            const Simulator& live = env.simulator();
            auto pk = live.peek();
            ASSERT_TRUE(pk.has_value());
            const SimTime decision_time = pk->time;
            const SimTime deadline      = decision_time + H;

            // The optimization only means anything once history has accumulated.
            if (!live.completed_jobs().empty()) ++inspections_with_history;

            std::vector<int> queued(live.get_job_queue().begin(),
                                    live.get_job_queue().end());

            // Two independent policy objects so neither fork shares mutable state.
            auto pol_full  = make_heuristic_policy("wfp3", 64);
            auto pol_light = make_heuristic_policy("wfp3", 64);

            Simulator full  = live.get_copy(false);
            Simulator light = live.get_projection_copy();

            // Pre-rollout: the projection-relevant "now" state must match.
            ASSERT_EQ(full.available_procs(), light.available_procs());
            ASSERT_EQ(full.current_time(),    light.current_time());
            ASSERT_EQ(full.get_job_queue().size(), light.get_job_queue().size());
            ASSERT_EQ(full.running_jobs().size(),  light.running_jobs().size());

            roll_forward(full,  pol_full.get(),  bf, deadline);
            roll_forward(light, pol_light.get(), bf, deadline);

            // Per-queued-job outcomes drive proj_avg_wait / jobs_completed, so
            // these are exactly what a projection reports. They must be equal.
            std::unordered_set<int> full_done(full.completed_jobs().begin(),
                                              full.completed_jobs().end());
            std::unordered_set<int> light_done(light.completed_jobs().begin(),
                                               light.completed_jobs().end());
            for (int id : queued) {
                EXPECT_EQ(full.job_start_time(id), light.job_start_time(id))
                    << "start-time divergence for queued job " << id
                    << " (step " << step << ")";
                EXPECT_EQ(full_done.count(id), light_done.count(id))
                    << "completion divergence for queued job " << id
                    << " (step " << step << ")";
            }

            // Post-rollout resource state must also agree.
            EXPECT_EQ(full.available_procs(), light.available_procs())
                << "free-proc divergence after rollout (step " << step << ")";

            ++inspected;
        }
        env.step(0);
    }

    EXPECT_GE(inspected, 3) << "expected early/middle/late inspection points";
    EXPECT_GE(inspections_with_history, 1)
        << "test is vacuous: no inspected fork had pre-fork completion history";
}
