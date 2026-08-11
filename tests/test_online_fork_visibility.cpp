// Fork future-visibility audit.
//
// The paper's central online claim is that a policy is evaluated WITHOUT
// visibility into future submissions: a projection fork must answer "how would
// policy X clear exactly what is queued and running NOW", not forecast with
// future knowledge. That rests on projection forks structurally not containing
// future Submit events.
//
// This test builds a projection fork exactly as the projection code does
// (`sim_->get_copy(false)`) at several mid-run decision points and asserts:
//   (1)/(2) no Submit event in the fork's heap is for a job that submits after
//           the decision time;
//   (4)     replaying the fork to the horizon never starts or completes a job
//           that submits after the decision time.

#include <gtest/gtest.h>

#include <filesystem>
#include <string>

#include "adapters/env/online_env.h"

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

}  // namespace

TEST(OnlineForkVisibility, ForkNeverContainsOrRunsFutureSubmits) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";

    OnlineEnvConfig cfg;
    cfg.swf_path    = swf;
    cfg.mode        = SimMode::Normal;
    cfg.max_submits = 2000;                         // contended slice with many future arrivals
    cfg.pool = { PoolEntry{ "wfp3", 64, LegacyDispatchConfig{ true, 1 } } };

    OnlineEnv env(cfg);
    env.reset();

    const SimTime H = 86400;
    int inspected = 0;
    int inspections_with_pending_future = 0;

    for (int step = 0; !env.done(); ++step) {
        if (step == 5 || (step > 0 && step % 500 == 0)) {
            const Simulator& live = env.simulator();
            auto pk = live.peek();
            ASSERT_TRUE(pk.has_value());
            const SimTime decision_time = pk->time;

            const int pending_future = env.pending_arrivals();
            if (pending_future > 0) ++inspections_with_pending_future;

            Simulator fork = live.get_copy(false);

            // (1)/(2) — no future Submit event sits in the fork's event queue.
            for (const Event& e : fork.kpeek(1'000'000)) {
                if (e.type == EventType::Submit) {
                    SimTime st = fork.get_job(e.job_id).submit_time;
                    EXPECT_LE(st, decision_time)
                        << "fork holds a FUTURE submit: job " << e.job_id
                        << " submit=" << st << " > decision=" << decision_time
                        << " (step " << step << ", pending_future=" << pending_future << ")";
                }
            }

            // (4) — replay to horizon; nothing that submits after the decision
            // time may run or complete inside the fork.
            const SimTime deadline = decision_time + H;
            while (fork.has_events()) {
                auto n = fork.peek();
                if (!n || n->time > deadline) break;
                fork.step();
            }
            for (int id : fork.running_jobs())
                EXPECT_LE(fork.get_job(id).submit_time, decision_time)
                    << "future job " << id << " RUNNING inside fork (step " << step << ")";
            for (int id : fork.completed_jobs())
                EXPECT_LE(fork.get_job(id).submit_time, decision_time)
                    << "future job " << id << " COMPLETED inside fork (step " << step << ")";

            ++inspected;
        }
        env.step(0);
    }

    EXPECT_GE(inspected, 3) << "expected early/middle/late inspection points";
    // Non-vacuity: at some inspected decision points there really were future
    // arrivals still to come (which must be absent from the fork).
    EXPECT_GE(inspections_with_pending_future, 1)
        << "test is vacuous: no decision point had pending future arrivals";
}
