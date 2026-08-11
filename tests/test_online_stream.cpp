// Stream-mode equivalence: an OnlineEnv fed jobs one event at a time (stream
// mode) must reproduce the offline Driver's schedule EXACTLY — per-job start
// times identical, not close — for both bulk and event pacing. This extends the
// fidelity chain by one link:
//
//   stream-fed online == trace-fed online == offline engine == Python CQSim.
//
// (trace-fed online == offline is proven in test_online_fidelity.cpp; the
// offline engine == Python CQSim on 10 traces.)
//
// Comparison invariant: per-job WAIT (start - submit), not absolute start time.
// The offline Driver and the trace-fed env both shift the timeline to origin 0
// (driver.cpp submit_origin; online build_sim origin shift); stream mode
// deliberately keeps ABSOLUTE submit times so the client-asserted horizon is on
// a real clock. Wait is invariant to that shift, so it is the correct
// byte-identical quantity to assert across the two.
//
// Also covered here: frontier honesty (the twin never simulates past the
// client-asserted horizon, and late-but-in-order delivery does not change the
// outcome) and projections non-interference in stream mode.

#include <gtest/gtest.h>

#include <algorithm>
#include <filesystem>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "adapters/env/online_env.h"
#include "adapters/simulation/driver.h"
#include "io/swf_reader.h"
#include "policies/policy_factory.h"

using json = nlohmann::json;

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

// A submit_job payload carrying the RAW SWF-semantic fields, so the engine's
// shared record builder reconstructs a byte-identical SimJob. run_time is
// already clamped in the loaded SimJob; re-clamping against the request is a
// no-op, so the round-trip is faithful.
json job_to_json(const SimJob& j) {
    return {
        { "id",                 j.id },
        { "submit_time",        static_cast<double>(j.submit_time) },
        { "requested_walltime", j.requested_time },
        { "runtime",            static_cast<double>(j.run_time) },
        { "requested_procs",    j.requested.procs },
        { "requested_memory",   static_cast<long long>(j.requested.memory_mb) },
        { "user_id",            j.user_id },
        { "group_id",           j.group_id },
        { "queue_id",           j.queue_id },
    };
}

// Two comparable quantities per job:
//   wait       = start - submit                    (invariant to any time origin)
//   norm_start = start - (min submit in this run)  (origin-normalized start)
// Waits are the semantic invariant. norm_start additionally guards submit
// handling itself: if a future change shifted/corrupted a SUBSET of submits on
// one path, waits (computed against each job's own recorded submit) could still
// match while the actual schedule diverged — normalized starts catch that, and
// satisfy the work order's literal "per-job start times" wording (up to the
// documented origin: trace/offline shift to 0, stream runs on absolute time).
struct JobResult { SimTime wait; SimTime norm_start; };

std::map<int, JobResult> collect(const Simulator& s) {
    SimTime origin = std::numeric_limits<SimTime>::infinity();
    for (int id : s.completed_jobs())
        origin = std::min(origin, s.get_job(id).submit_time);
    std::map<int, JobResult> out;
    for (int id : s.completed_jobs()) {
        const SimTime submit = s.get_job(id).submit_time;
        const SimTime start  = s.job_start_time(id);
        out[id] = JobResult{ start - submit, start - origin };
    }
    return out;
}

// Offline reference: run the Driver, return per-job {wait, norm_start}.
std::map<int, JobResult> run_offline(const std::vector<SimJob>& jobs, int total_procs,
                                     const std::string& policy_type, int window,
                                     int backfill_mode) {
    auto policy = make_heuristic_policy(policy_type, window);
    std::vector<NodeInfo> nodes{ NodeInfo(0, "cluster", Resources{ total_procs, 0, 0 }) };

    DriverConfig dc;
    dc.tag           = "stream_offline_" + policy_type;
    dc.output_dir    = (std::filesystem::temp_directory_path() / "cqsim_stream").string();
    dc.mode          = SimMode::Normal;
    dc.backfill      = backfill_mode > 0;
    dc.backfill_mode = backfill_mode;

    Driver driver(jobs, nodes, policy.get(), dc);
    driver.run();

    return collect(driver.simulator());
}

enum class Pace { Bulk, Event };

OnlineEnvConfig stream_cfg(int total_procs, const std::string& policy, int window,
                           int backfill_mode, bool advisory) {
    OnlineEnvConfig cfg;
    cfg.workload_mode = WorkloadMode::Stream;
    cfg.total_procs   = total_procs;
    cfg.mode          = SimMode::Normal;
    cfg.pool = { PoolEntry{ policy, window,
                            LegacyDispatchConfig{ backfill_mode > 0, backfill_mode } } };
    cfg.include_advisory = advisory;
    if (advisory) { cfg.advisory_horizon_seconds = 86400; cfg.advisory_interval = 1; }
    return cfg;
}

// Step through every pending decision with a constant action (fixed policy).
json drive(OnlineEnv& env, json resp) {
    while (resp.value("status", std::string()) == "decision")
        resp = env.step(0);
    return resp;
}

// Stream-fed run: feed `jobs` to a stream-mode env with the given pacing, fixed
// action 0. Returns per-job {wait, norm_start}.
std::map<int, JobResult> run_online_stream(const std::vector<SimJob>& jobs, int total_procs,
                                           const std::string& policy, int window,
                                           int backfill_mode, Pace pace, bool advisory = false) {
    OnlineEnv env(stream_cfg(total_procs, policy, window, backfill_mode, advisory));
    env.reset();

    if (pace == Pace::Bulk) {
        json batch = json::array();
        for (const auto& j : jobs) batch.push_back(job_to_json(j));
        env.submit_jobs(json{ { "jobs", batch } });
        drive(env, env.stream_end());
    } else {
        std::size_t i = 0;
        while (i < jobs.size()) {
            const SimTime t = jobs[i].submit_time;
            json batch = json::array();
            std::size_t k = i;
            while (k < jobs.size() && jobs[k].submit_time == t) batch.push_back(job_to_json(jobs[k++]));
            env.submit_jobs(json{ { "jobs", batch } });
            i = k;
            drive(env, env.stream_advance(static_cast<double>(t)));  // assert complete through t
        }
        drive(env, env.stream_end());
    }

    return collect(env.simulator());
}

void assert_matches_offline(const std::string& label, const std::vector<SimJob>& jobs,
                            int total_procs, const std::string& policy, int window,
                            int backfill_mode, Pace pace) {
    std::map<int, JobResult> off = run_offline(jobs, total_procs, policy, window, backfill_mode);
    std::map<int, JobResult> on  = run_online_stream(jobs, total_procs, policy, window, backfill_mode, pace);

    ASSERT_EQ(off.size(), on.size())
        << label << ": completed-job count differs (offline=" << off.size()
        << " stream=" << on.size() << ")";

    for (const auto& [id, r_off] : off) {
        auto it = on.find(id);
        ASSERT_NE(it, on.end()) << label << ": job " << id
                                << " completed offline but not in stream run";
        // Semantic invariant (shift-free) AND origin-normalized start (submit-
        // handling guard). Both must be byte-identical.
        if (r_off.wait != it->second.wait || r_off.norm_start != it->second.norm_start) {
            FAIL() << label << ": FIRST DIVERGENCE at job " << id
                   << "  offline{wait=" << r_off.wait << ",norm_start=" << r_off.norm_start << "}"
                   << "  stream{wait="  << it->second.wait << ",norm_start=" << it->second.norm_start << "}";
        }
    }
    SUCCEED() << label << ": " << off.size()
              << " jobs, per-job wait AND origin-normalized start identical";
}

constexpr int kN = 3000;  // matches the trace-fed fidelity slice

}  // namespace

// ── Task 3.1: stream == offline, per job, exactly, both pacings ──────────────

TEST(OnlineStream, BulkFcfsEasyMatchesOffline) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);
    assert_matches_offline("stream/bulk FCFS+EASY", jobs, tp, "fcfs", INT_MAX, 1, Pace::Bulk);
}

TEST(OnlineStream, BulkWfp3EasyMatchesOffline) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);
    assert_matches_offline("stream/bulk WFP3+EASY", jobs, tp, "wfp3", 64, 1, Pace::Bulk);
}

TEST(OnlineStream, EventFcfsEasyMatchesOffline) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);
    assert_matches_offline("stream/event FCFS+EASY", jobs, tp, "fcfs", INT_MAX, 1, Pace::Event);
}

TEST(OnlineStream, EventWfp3EasyMatchesOffline) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);
    assert_matches_offline("stream/event WFP3+EASY", jobs, tp, "wfp3", 64, 1, Pace::Event);
}

// ── Task 3.2: frontier honesty ───────────────────────────────────────────────
// Deliver only the jobs up to a horizon T and assert the twin (a) parks at
// waiting_for_events without simulating past T and (b) never pulled a future
// (undelivered) job into the running/completed set. Then deliver the withheld
// jobs in order and finish; the final schedule must still match offline exactly
// — late-but-in-order delivery changes nothing.
TEST(OnlineStream, FrontierHonestyThenExactFinish) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);

    std::map<int, SimTime> submit;
    for (const auto& j : jobs) submit[j.id] = j.submit_time;

    // Horizon = submit time of the middle job (guaranteed to split the slice).
    const SimTime T = jobs[jobs.size() / 2].submit_time;

    OnlineEnv env(stream_cfg(tp, "wfp3", 64, 1, /*advisory=*/false));
    env.reset();

    // Deliver every job with submit_time <= T, then assert completeness to T.
    json early = json::array();
    std::size_t i = 0;
    for (; i < jobs.size() && jobs[i].submit_time <= T; ++i) early.push_back(job_to_json(jobs[i]));
    env.submit_jobs(json{ { "jobs", early } });
    json resp = drive(env, env.stream_advance(static_cast<double>(T)));

    // (a) Parked at the frontier, not terminal, and the clock did not pass T.
    EXPECT_EQ(resp.value("status", std::string()), "waiting_for_events");
    EXPECT_FALSE(env.done());
    const double now = resp["obs"]["time"].get<double>();
    EXPECT_LE(now, static_cast<double>(T))
        << "twin simulated past the asserted horizon T=" << T << " (now=" << now << ")";

    // (b) No undelivered (future) job started or completed.
    const Simulator& s = env.simulator();
    for (int id : s.completed_jobs())
        EXPECT_LE(submit.at(id), T) << "future job " << id << " completed before it was delivered";
    for (int id : s.running_jobs())
        EXPECT_LE(submit.at(id), T) << "future job " << id << " is running before it was delivered";

    // Now deliver the withheld tail in submit-time order and finish.
    while (i < jobs.size()) {
        const SimTime t = jobs[i].submit_time;
        json batch = json::array();
        while (i < jobs.size() && jobs[i].submit_time == t) batch.push_back(job_to_json(jobs[i++]));
        env.submit_jobs(json{ { "jobs", batch } });
        drive(env, env.stream_advance(static_cast<double>(t)));
    }
    drive(env, env.stream_end());

    std::map<int, JobResult> on  = collect(s);
    std::map<int, JobResult> off = run_offline(jobs, tp, "wfp3", 64, 1);

    ASSERT_EQ(off.size(), on.size());
    for (const auto& [id, r_off] : off) {
        auto it = on.find(id);
        ASSERT_NE(it, on.end()) << "job " << id << " missing after withheld delivery";
        ASSERT_EQ(r_off.wait, it->second.wait)
            << "withheld-then-delivered job " << id << " wait diverged";
        ASSERT_EQ(r_off.norm_start, it->second.norm_start)
            << "withheld-then-delivered job " << id << " norm_start diverged";
    }
}

// ── Task 3.2b: a job at or behind the settled frontier is rejected ───────────
// (accepting it would rewrite already-simulated history). Duplicate and
// malformed jobs are rejected too, with machine-readable reasons.
TEST(OnlineStream, RejectsBehindFrontierDuplicateAndMalformed) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, 200);
    int tp = trace_total_procs(swf, jobs);

    OnlineEnv env(stream_cfg(tp, "fcfs", INT_MAX, 1, false));
    env.reset();

    // Deliver the first job and advance to its time -> the frontier is now there.
    env.submit_jobs(json{ { "job", job_to_json(jobs[0]) } });
    env.stream_advance(static_cast<double>(jobs[0].submit_time));

    // Behind-frontier: same submit_time as the settled frontier.
    SimJob behind = jobs[50];
    behind.submit_time = jobs[0].submit_time;  // <= frontier
    json r1 = env.submit_jobs(json{ { "job", job_to_json(behind) } });
    ASSERT_EQ(r1["rejected"].size(), 1u);
    EXPECT_EQ(r1["rejected"][0]["reason"], "behind_frontier");
    EXPECT_TRUE(r1["accepted"].empty());

    // Duplicate id (jobs[0] already accepted), placed safely ahead of the frontier.
    SimJob dup = jobs[0];
    dup.submit_time = jobs[0].submit_time + 1e9;
    json r2 = env.submit_jobs(json{ { "job", job_to_json(dup) } });
    ASSERT_EQ(r2["rejected"].size(), 1u);
    EXPECT_EQ(r2["rejected"][0]["reason"], "duplicate_id");

    // Malformed: missing required fields.
    json r3 = env.submit_jobs(json{ { "job", { { "id", 999999 } } } });
    ASSERT_EQ(r3["rejected"].size(), 1u);
    EXPECT_EQ(r3["rejected"][0]["reason"], "malformed");
    EXPECT_EQ(r3["rejected"][0]["job_id"], 999999);
}

// ── Task 3.3: projections in stream mode do not perturb the committed run ─────
// The committed schedule must be byte-identical whether per-policy advisory
// projections are computed each cycle or not (and both must match offline).
TEST(OnlineStream, ProjectionsDoNotChangeCommittedSchedule) {
    std::string swf = find_trace();
    if (swf.empty()) GTEST_SKIP() << "no input trace found";
    auto jobs = load_slice(swf, kN);
    int tp = trace_total_procs(swf, jobs);

    auto off = run_offline(jobs, tp, "wfp3", 64, 1);
    auto adv_off = run_online_stream(jobs, tp, "wfp3", 64, 1, Pace::Event, /*advisory=*/false);
    auto adv_on  = run_online_stream(jobs, tp, "wfp3", 64, 1, Pace::Event, /*advisory=*/true);

    ASSERT_EQ(off.size(), adv_off.size());
    ASSERT_EQ(off.size(), adv_on.size());
    for (const auto& [id, r] : off) {
        ASSERT_EQ(r.wait, adv_off.at(id).wait) << "advisory-off wait diverged at job " << id;
        ASSERT_EQ(r.wait, adv_on.at(id).wait)  << "advisory-on wait diverged at job "  << id;
        ASSERT_EQ(r.norm_start, adv_off.at(id).norm_start) << "advisory-off norm_start diverged at job " << id;
        ASSERT_EQ(r.norm_start, adv_on.at(id).norm_start)  << "advisory-on norm_start diverged at job "  << id;
    }
}
