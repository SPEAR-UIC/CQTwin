// measure_stream — engine-side full-trace measurements for CQTwin stream mode.
//
// Runs, in-process (no socket), on one SWF under WFP3+EASY:
//   * offline Driver              (reference schedule + wall)
//   * stream bulk                 (wall + per-job equality vs offline)
//   * stream event                (wall + per-job equality vs offline)
//   * stream bulk + advisory@1    (advisory-row count + committed-schedule identity)
// Reports median-of-N walls and divergence counts as JSON on stdout.
//
// Per-job equality is checked on BOTH wait (start-submit) and origin-normalized
// start (start - min submit), matching tests/test_online_stream.cpp. Stream mode
// runs on absolute time; offline shifts to origin 0 — see docs/live-adapter.md §3.
//
// Usage: measure_stream <swf_path> <total_procs> [reps=3]

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <limits>
#include <map>
#include <numeric>
#include <string>
#include <vector>

#include <unistd.h>

#include <nlohmann/json.hpp>

#include "adapters/env/online_env.h"
#include "adapters/simulation/driver.h"
#include "io/swf_reader.h"
#include "policies/policy_factory.h"

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

namespace {

// Redirect stdout to /dev/null for the duration (silences the Driver progress bar
// so it can't corrupt the JSON we print at the end).
struct SuppressStdout {
    int saved = -1;
    SuppressStdout() { std::fflush(stdout); saved = dup(fileno(stdout));
                       (void)!freopen("/dev/null", "w", stdout); }
    ~SuppressStdout() { std::fflush(stdout); if (saved >= 0) { dup2(saved, fileno(stdout)); close(saved); } }
};

struct JobResult { SimTime wait; SimTime norm_start; };

std::map<int, JobResult> collect(const Simulator& s) {
    SimTime origin = std::numeric_limits<SimTime>::infinity();
    for (int id : s.completed_jobs()) origin = std::min(origin, s.get_job(id).submit_time);
    std::map<int, JobResult> out;
    for (int id : s.completed_jobs()) {
        const SimTime submit = s.get_job(id).submit_time;
        const SimTime start  = s.job_start_time(id);
        out[id] = JobResult{ start - submit, start - origin };
    }
    return out;
}

// Optional per-job dump (id,submit,start,wait) for figure generation. Full
// double precision so the downstream exact-equality assert is meaningful. Enabled
// only when CQTWIN_DUMP_DIR is set; does not affect the measurement/return path.
void dump_jobs(const Simulator& s, const std::string& path) {
    std::ofstream f(path);
    f << "id,submit,start,wait\n" << std::setprecision(17);
    for (int id : s.completed_jobs()) {
        const SimTime submit = s.get_job(id).submit_time;
        const SimTime start  = s.job_start_time(id);
        f << id << ',' << submit << ',' << start << ',' << (start - submit) << '\n';
    }
}

json job_to_json(const SimJob& j) {
    return { { "id", j.id }, { "submit_time", static_cast<double>(j.submit_time) },
             { "requested_walltime", j.requested_time }, { "runtime", static_cast<double>(j.run_time) },
             { "requested_procs", j.requested.procs },
             { "requested_memory", static_cast<long long>(j.requested.memory_mb) },
             { "user_id", j.user_id }, { "group_id", j.group_id }, { "queue_id", j.queue_id } };
}

std::vector<SimJob> load(const std::string& path) {
    SwfReader r(path);
    auto jobs = r.read();
    std::stable_sort(jobs.begin(), jobs.end(),
                     [](const SimJob& a, const SimJob& b) { return a.submit_time < b.submit_time; });
    return jobs;
}

OnlineEnvConfig stream_cfg(int total_procs, bool advisory, const std::string& adv_csv) {
    OnlineEnvConfig c;
    c.workload_mode = WorkloadMode::Stream;
    c.total_procs   = total_procs;
    c.mode          = SimMode::Normal;
    c.pool = { PoolEntry{ "wfp3", 64, LegacyDispatchConfig{ true, 1 } } };
    c.include_advisory = advisory;
    if (advisory) { c.advisory_horizon_seconds = 86400; c.advisory_interval = 1; c.advisory_csv = adv_csv; }
    return c;
}

json drive(OnlineEnv& env, json r) {
    while (r.value("status", std::string()) == "decision") r = env.step(0);
    return r;
}

// One stream run; returns the per-job result. pace: 0=bulk, 1=event.
std::map<int, JobResult> stream_run(const std::vector<SimJob>& jobs, int total_procs,
                                    int pace, bool advisory, const std::string& adv_csv,
                                    const std::string& dump = "") {
    OnlineEnv env(stream_cfg(total_procs, advisory, adv_csv));
    env.reset();
    if (pace == 0) {
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
            drive(env, env.stream_advance(static_cast<double>(t)));
        }
        drive(env, env.stream_end());
    }
    if (!dump.empty()) dump_jobs(env.simulator(), dump);
    return collect(env.simulator());
}

std::map<int, JobResult> offline_run(const std::vector<SimJob>& jobs, int total_procs,
                                     const std::string& dump = "") {
    auto policy = make_heuristic_policy("wfp3", 64);
    std::vector<NodeInfo> nodes{ NodeInfo(0, "cluster", Resources{ total_procs, 0, 0 }) };
    DriverConfig dc;
    dc.tag = "measure_stream_offline";
    dc.output_dir = (std::filesystem::temp_directory_path() / "cqsim_measure").string();
    dc.mode = SimMode::Normal; dc.backfill = true; dc.backfill_mode = 1;
    Driver driver(jobs, nodes, policy.get(), dc);
    driver.run();
    if (!dump.empty()) dump_jobs(driver.simulator(), dump);
    return collect(driver.simulator());
}

int divergent(const std::map<int, JobResult>& ref, const std::map<int, JobResult>& got) {
    int d = 0;
    for (const auto& [id, r] : ref) {
        auto it = got.find(id);
        if (it == got.end() || r.wait != it->second.wait || r.norm_start != it->second.norm_start) ++d;
    }
    return d;
}

double median(std::vector<double> v) {
    std::sort(v.begin(), v.end());
    return v.empty() ? 0.0 : v[v.size() / 2];
}

double spread_pct(const std::vector<double>& v) {
    if (v.size() < 2) return 0.0;
    auto mm = std::minmax_element(v.begin(), v.end());
    return *mm.first > 0 ? (*mm.second - *mm.first) / *mm.first * 100.0 : 0.0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: measure_stream <swf> <total_procs> [reps=3]\n"); return 2; }
    const std::string swf = argv[1];
    const int total_procs = std::stoi(argv[2]);
    const int reps = argc > 3 ? std::stoi(argv[3]) : 3;
    const char* dump_env = std::getenv("CQTWIN_DUMP_DIR");
    const std::string dump_dir = dump_env ? std::string(dump_env) : std::string();

    std::vector<SimJob> jobs = load(swf);
    const std::string adv_csv = (std::filesystem::temp_directory_path() / "cqsim_measure_adv.csv").string();

    // Reference schedule (once) + timed reps.
    std::map<int, JobResult> off_ref;
    std::vector<double> off_walls, bulk_walls, event_walls, adv_walls;
    for (int i = 0; i < reps; ++i) {
        SuppressStdout q;
        auto t0 = Clock::now();
        auto r = offline_run(jobs, total_procs,
            (i == 0 && !dump_dir.empty()) ? dump_dir + "/offline_jobs.csv" : std::string());
        off_walls.push_back(std::chrono::duration<double>(Clock::now() - t0).count());
        if (i == 0) off_ref = std::move(r);
    }

    int bulk_div = -1, event_div = -1, adv_div = -1;
    std::map<int, JobResult> bulk_res, event_res, adv_res;
    for (int i = 0; i < reps; ++i) {
        SuppressStdout q;
        auto t0 = Clock::now();
        auto r = stream_run(jobs, total_procs, /*bulk*/0, false, "",
            (i == 0 && !dump_dir.empty()) ? dump_dir + "/stream_bulk_jobs.csv" : std::string());
        bulk_walls.push_back(std::chrono::duration<double>(Clock::now() - t0).count());
        if (i == 0) bulk_res = std::move(r);
    }
    for (int i = 0; i < reps; ++i) {
        SuppressStdout q;
        auto t0 = Clock::now();
        auto r = stream_run(jobs, total_procs, /*event*/1, false, "");
        event_walls.push_back(std::chrono::duration<double>(Clock::now() - t0).count());
        if (i == 0) event_res = std::move(r);
    }
    // Advisory@1 (bulk): time + row count + committed identity.
    long adv_rows = 0;
    for (int i = 0; i < reps; ++i) {
        SuppressStdout q;
        auto t0 = Clock::now();
        auto r = stream_run(jobs, total_procs, /*bulk*/0, true, adv_csv);
        adv_walls.push_back(std::chrono::duration<double>(Clock::now() - t0).count());
        if (i == 0) adv_res = std::move(r);
    }
    { // count advisory rows (minus header) from the last written csv
        std::ifstream f(adv_csv);
        std::string line; long n = 0;
        while (std::getline(f, line)) if (!line.empty()) ++n;
        adv_rows = n > 0 ? n - 1 : 0;
    }

    bulk_div  = divergent(off_ref, bulk_res);
    event_div = divergent(off_ref, event_res);
    adv_div   = divergent(off_ref, adv_res);

    json out = {
        { "trace", std::filesystem::path(swf).filename().string() },
        { "jobs_completed", static_cast<int>(off_ref.size()) },
        { "total_procs", total_procs },
        { "reps", reps },
        { "offline",      { { "wall_med", median(off_walls) },   { "walls", off_walls },   { "spread_pct", spread_pct(off_walls) } } },
        { "stream_bulk",  { { "wall_med", median(bulk_walls) },  { "walls", bulk_walls },  { "spread_pct", spread_pct(bulk_walls) },  { "divergent", bulk_div },  { "compared", static_cast<int>(off_ref.size()) } } },
        { "stream_event", { { "wall_med", median(event_walls) }, { "walls", event_walls }, { "spread_pct", spread_pct(event_walls) }, { "divergent", event_div }, { "compared", static_cast<int>(off_ref.size()) } } },
        { "stream_bulk_advisory1", { { "wall_med", median(adv_walls) }, { "walls", adv_walls }, { "advisory_rows", adv_rows }, { "divergent", adv_div } } },
    };
    std::printf("%s\n", out.dump(2).c_str());
    return (bulk_div == 0 && event_div == 0 && adv_div == 0) ? 0 : 1;
}
