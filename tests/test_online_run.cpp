// online-run determinism / equivalence: the headless online-advisory run
// (OnlineEnv driven with a CONSTANT committed policy) must write a committed
// jobs.csv byte-identical to an offline Driver run of that same policy, using the
// shared write_job_results_csv writer. This is the assertion that lets the
// dashboard trust online-advisory runs with zero new preprocessing. Also: the
// advisory.csv is deterministic (same config twice -> byte-identical).

#include <gtest/gtest.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "adapters/env/online_env.h"
#include "adapters/simulation/driver.h"
#include "io/swf_reader.h"
#include "policies/policy_factory.h"

namespace {

std::string find_trace() {
    const char* candidates[] = {
        "../data/InputFiles/polaris_norm.swf", "data/InputFiles/polaris_norm.swf",
        "../data/InputFiles/aurora_norm.swf",  "data/InputFiles/aurora_norm.swf",
        // mira_norm.swf is the trace bundled in the clean repo; kept as a fallback
        // so this equivalence test runs self-contained after a fresh clone.
        "../data/InputFiles/mira_norm.swf",    "data/InputFiles/mira_norm.swf",
    };
    for (const char* c : candidates)
        if (std::filesystem::exists(c)) return c;
    return "";
}

std::vector<SimJob> load_slice(const std::string& path, int n) {
    SwfReader reader(path);
    std::vector<SimJob> jobs = reader.read();
    std::stable_sort(jobs.begin(), jobs.end(),
                     [](const SimJob& a, const SimJob& b) { return a.submit_time < b.submit_time; });
    if (static_cast<int>(jobs.size()) > n) jobs.erase(jobs.begin() + n, jobs.end());
    return jobs;
}

int trace_total_procs(const std::string& path, const std::vector<SimJob>& jobs) {
    SwfReader reader(path); reader.read();
    int tp = reader.max_procs();
    if (tp <= 0) for (const auto& j : jobs) tp = std::max(tp, j.requested.procs);
    return std::max(tp, 1);
}

std::string slurp(const std::string& p) {
    std::ifstream f(p); std::stringstream ss; ss << f.rdbuf(); return ss.str();
}

std::string tmp(const std::string& name) {
    return (std::filesystem::temp_directory_path() / name).string();
}

constexpr int kN = 3000;

}  // namespace

// The gate: committed jobs.csv (online, fixed action) == offline Driver jobs.csv.
TEST(OnlineRun, CommittedJobsCsvByteIdenticalToOfflineDriver) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);

    // Offline Driver: WFP3 + EASY, window 64.
    auto off_pol = make_heuristic_policy("wfp3", 64);
    std::vector<NodeInfo> nodes{ NodeInfo(0, "cluster", Resources{ tp, 0, 0 }) };
    DriverConfig dc;
    dc.tag = "online_run_offline"; dc.output_dir = tmp("cqsim_online_run");
    dc.mode = SimMode::Normal; dc.backfill = true; dc.backfill_mode = 1;
    Driver driver(jobs, nodes, off_pol.get(), dc);
    driver.run();
    std::string off_csv = tmp("online_run_offline.csv");
    write_job_results_csv(driver.simulator(), off_csv);

    // Online env driven with a constant action = committed WFP3 (pool index 0).
    OnlineEnvConfig cfg;
    cfg.swf_path = swf; cfg.total_procs = tp; cfg.mode = SimMode::Normal; cfg.max_submits = kN;
    cfg.pool = { PoolEntry{ "wfp3", 64, LegacyDispatchConfig{ true, 1 } } };
    OnlineEnv env(cfg);
    env.reset();
    int guard = 0;
    while (!env.done() && guard++ < 10'000'000) env.step(0);
    std::string on_csv = tmp("online_run_online.csv");
    write_job_results_csv(env.simulator(), on_csv);

    EXPECT_EQ(slurp(off_csv), slurp(on_csv))
        << "committed jobs.csv differs from the offline Driver run of the same policy";
}

// advisory.csv is deterministic: same config twice -> byte-identical.
TEST(OnlineRun, AdvisoryCsvDeterministic) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, 1500);
    int tp = trace_total_procs(swf, jobs);

    auto run_once = [&](const std::string& adv_path) {
        OnlineEnvConfig cfg;
        cfg.swf_path = swf; cfg.total_procs = tp; cfg.mode = SimMode::Normal; cfg.max_submits = 1500;
        cfg.pool = { PoolEntry{ "fcfs", INT_MAX, LegacyDispatchConfig{ true, 1 } },
                     PoolEntry{ "sjf",  64,      LegacyDispatchConfig{ true, 1 } },
                     PoolEntry{ "wfp3", 64,      LegacyDispatchConfig{ true, 1 } } };
        cfg.include_advisory = true;
        cfg.advisory_horizon_seconds = 86400;
        cfg.advisory_interval = 1;
        cfg.advisory_csv = adv_path;
        OnlineEnv env(cfg);
        env.reset();
        int guard = 0;
        while (!env.done() && guard++ < 10'000'000) env.step(2);  // committed = wfp3
    };

    std::string a = tmp("online_run_adv_a.csv"), b = tmp("online_run_adv_b.csv");
    run_once(a);
    run_once(b);
    EXPECT_EQ(slurp(a), slurp(b)) << "advisory.csv not deterministic across identical runs";
    EXPECT_FALSE(slurp(a).empty()) << "advisory.csv was empty";
}
