// Fixed-action fidelity: the online environment, driven with a CONSTANT action
// (one policy every cycle), must reproduce the offline Driver's schedule for
// that same policy EXACTLY — per-job start and wait times identical, not close.
//
// Fidelity chain:  online env  ==  offline engine (Driver)  ==  Python CQSim.
// The offline engine already matches Python CQSim exactly (validated .rst/.ult
// on 10 traces); this test closes the remaining link so the online path
// inherits that validation.

#include <gtest/gtest.h>

#include <algorithm>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

#include "adapters/env/online_env.h"
#include "adapters/simulation/driver.h"
#include "io/swf_reader.h"
#include "policies/policy_factory.h"

namespace {

std::string find_trace() {
    const char* candidates[] = {
        "../data/InputFiles/polaris_norm.swf",  // ctest runs with CWD=build/
        "data/InputFiles/polaris_norm.swf",
        "../data/InputFiles/aurora_norm.swf",
        "data/InputFiles/aurora_norm.swf",
        // fallback trace bundled in the clean repo (keeps the test self-contained)
        "../data/InputFiles/mira_norm.swf",
        "data/InputFiles/mira_norm.swf",
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
    if (static_cast<int>(jobs.size()) > n)
        jobs.erase(jobs.begin() + n, jobs.end());
    return jobs;
}

int trace_total_procs(const std::string& path, const std::vector<SimJob>& jobs) {
    SwfReader reader(path);
    reader.read();
    int tp = reader.max_procs();
    if (tp <= 0)
        for (const auto& j : jobs) tp = std::max(tp, j.requested.procs);
    return std::max(tp, 1);
}

// Offline path: run the Driver, return job_id -> start_time (shifted timeline).
std::map<int, SimTime> run_offline(const std::vector<SimJob>& jobs, int total_procs,
                                   const std::string& policy_type, int window,
                                   int backfill_mode) {
    auto policy = make_heuristic_policy(policy_type, window);
    std::vector<NodeInfo> nodes{ NodeInfo(0, "cluster", Resources{ total_procs, 0, 0 }) };

    DriverConfig dc;
    dc.tag           = "fidelity_offline_" + policy_type;
    dc.output_dir    = (std::filesystem::temp_directory_path() / "cqsim_fidelity").string();
    dc.mode          = SimMode::Normal;
    dc.backfill      = backfill_mode > 0;
    dc.backfill_mode = backfill_mode;

    Driver driver(jobs, nodes, policy.get(), dc);
    driver.run();

    const Simulator& s = driver.simulator();
    std::map<int, SimTime> out;
    for (int id : s.completed_jobs()) out[id] = s.job_start_time(id);
    return out;
}

// Online path: run OnlineEnv with a fixed action (pool has one policy).
std::map<int, SimTime> run_online(const std::string& swf, int n, int total_procs,
                                  const std::string& policy_type, int window,
                                  int backfill_mode) {
    OnlineEnvConfig cfg;
    cfg.swf_path    = swf;
    cfg.total_procs = total_procs;
    cfg.mode        = SimMode::Normal;
    cfg.max_submits = n;
    cfg.pool = { PoolEntry{ policy_type, window,
                            LegacyDispatchConfig{ backfill_mode > 0, backfill_mode } } };

    OnlineEnv env(cfg);
    env.reset();
    int guard = 0;
    while (!env.done() && guard++ < 10'000'000)
        env.step(0);  // constant action

    const Simulator& s = env.simulator();
    std::map<int, SimTime> out;
    for (int id : s.completed_jobs()) out[id] = s.job_start_time(id);
    return out;
}

void assert_identical_schedule(const std::string& label,
                               const std::vector<SimJob>& jobs, int total_procs,
                               const std::string& swf, int n,
                               const std::string& policy, int window, int backfill_mode) {
    std::map<int, SimTime> off = run_offline(jobs, total_procs, policy, window, backfill_mode);
    std::map<int, SimTime> on  = run_online(swf, n, total_procs, policy, window, backfill_mode);

    ASSERT_EQ(off.size(), on.size())
        << label << ": completed-job count differs (offline=" << off.size()
        << " online=" << on.size() << ")";

    std::map<int, SimTime> submit;
    for (const auto& j : jobs) submit[j.id] = j.submit_time;

    // Walk in job-id order and report the FIRST divergence, if any.
    for (const auto& [id, start_off] : off) {
        auto it = on.find(id);
        ASSERT_NE(it, on.end()) << label << ": job " << id
                                << " completed offline but not online";
        SimTime start_on = it->second;
        if (start_off != start_on) {
            SimTime wait_off = start_off - submit.at(id);
            SimTime wait_on  = start_on  - submit.at(id);
            FAIL() << label << ": FIRST DIVERGENCE at job " << id
                   << "  offline_start=" << start_off << " (wait " << wait_off << ")"
                   << "  online_start="  << start_on  << " (wait " << wait_on  << ")"
                   << "  delta=" << (start_on - start_off);
        }
    }
    SUCCEED() << label << ": " << off.size() << " jobs, per-job start times identical";
}

constexpr int kN = 3000;  // slice large enough to exercise backfill

}  // namespace

TEST(OnlineFidelity, FcfsEasyBackfillMatchesOffline) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);
    assert_identical_schedule("FCFS+EASY", jobs, tp, swf, kN, "fcfs", INT_MAX, 1);
}

TEST(OnlineFidelity, Wfp3EasyBackfillMatchesOffline) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);
    assert_identical_schedule("WFP3+EASY", jobs, tp, swf, kN, "wfp3", 64, 1);
}

TEST(OnlineFidelity, FcfsNoBackfillMatchesOffline) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);
    assert_identical_schedule("FCFS+noBF", jobs, tp, swf, kN, "fcfs", INT_MAX, 0);
}
