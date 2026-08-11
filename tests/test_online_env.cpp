#include <gtest/gtest.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <unistd.h>   // getpid — make the shared temp path process-unique

#include "adapters/env/online_env.h"

namespace {

// Write a tiny 3-job SWF: one job fills a 2-proc cluster, two more queue behind
// it. Columns are standard SWF (18 fields).
std::string write_tiny_swf() {
    // Unique per process: `ctest -j` runs each test case as its own process, so a
    // fixed shared name lets one case truncate the file while another reads it.
    std::filesystem::path p =
        std::filesystem::temp_directory_path() /
        ("cqsim_online_env_test_" + std::to_string(::getpid()) + ".swf");
    std::ofstream f(p, std::ios::trunc);
    f << "; MaxProcs: 2\n";
    // id sub wait run alloc cpu mem reqproc reqtime reqmem status uid gid exe q part prec think
    f << "1 0 0 100 2 -1 -1 2 100 -1 1 1 1 1 1 1 -1 -1\n";  // fills cluster 0..100
    f << "2 5 0 10  2 -1 -1 2 10  -1 1 1 1 1 1 1 -1 -1\n";  // short, queues
    f << "3 6 0 100 2 -1 -1 2 100 -1 1 1 1 1 1 1 -1 -1\n";  // long, queues
    f.close();
    return p.string();
}

OnlineEnvConfig make_config(const std::string& swf) {
    OnlineEnvConfig cfg;
    cfg.swf_path    = swf;
    cfg.total_procs = 2;
    cfg.mode        = SimMode::Normal;
    cfg.pool = {
        PoolEntry{ "fcfs", INT_MAX, {} },
        PoolEntry{ "sjf",  INT_MAX, {} },
        PoolEntry{ "ljf",  INT_MAX, {} },
    };
    return cfg;
}

// Drive the env to completion with a fixed action; return the terminal summary.
nlohmann::json run_episode(OnlineEnv& env, int action) {
    nlohmann::json last = env.reset();
    nlohmann::json terminal;
    int guard = 0;
    while (!env.done() && guard++ < 10000) {
        last = env.step(action);
    }
    EXPECT_TRUE(env.done());
    EXPECT_TRUE(last["info"].contains("summary"));
    return last["info"]["summary"];
}

}  // namespace

TEST(OnlineEnv, ResetProducesDecisionObservation) {
    std::string swf = write_tiny_swf();
    OnlineEnv env(make_config(swf));

    nlohmann::json out = env.reset();
    ASSERT_TRUE(out.contains("obs"));
    const auto& obs = out["obs"];

    EXPECT_TRUE(obs.contains("system"));
    EXPECT_TRUE(obs.contains("queue"));
    EXPECT_TRUE(obs.contains("running"));
    ASSERT_TRUE(obs.contains("pool"));
    EXPECT_EQ(obs["pool"].size(), 3u);               // fcfs, sjf, ljf
    EXPECT_FALSE(env.done());                        // there is work to schedule
    EXPECT_GE(obs["system"]["queue_len"].get<int>(), 1);
    EXPECT_EQ(env.action_count(), 3);
}

TEST(OnlineEnv, RunsToCompletionAndSchedulesAllJobs) {
    std::string swf = write_tiny_swf();
    OnlineEnv env(make_config(swf));

    nlohmann::json summary = run_episode(env, /*fcfs*/ 0);
    EXPECT_EQ(summary["completed"].get<int>(), 3);   // all three jobs finished
    EXPECT_GE(summary["makespan"].get<double>(), 200.0);  // serialized on 2 procs
}

TEST(OnlineEnv, StepAfterDoneThrows) {
    std::string swf = write_tiny_swf();
    OnlineEnv env(make_config(swf));
    run_episode(env, 0);
    EXPECT_THROW(env.step(0), std::runtime_error);
}

TEST(OnlineEnv, OutOfRangeActionThrows) {
    std::string swf = write_tiny_swf();
    OnlineEnv env(make_config(swf));
    env.reset();
    EXPECT_THROW(env.step(99), std::runtime_error);
    EXPECT_THROW(env.step(-1), std::runtime_error);
}

TEST(OnlineEnv, ResetIsRepeatableAcrossEpisodes) {
    std::string swf = write_tiny_swf();
    OnlineEnv env(make_config(swf));

    nlohmann::json s1 = run_episode(env, 0);
    nlohmann::json s2 = run_episode(env, 0);   // second episode, same fixed policy
    EXPECT_EQ(s1["completed"].get<int>(), s2["completed"].get<int>());
    EXPECT_DOUBLE_EQ(s1["makespan"].get<double>(), s2["makespan"].get<double>());
}
