#include "scenario_preview.h"

#include "../adapters/simulation/legacy_dispatch.h"
#include "../adapters/simulation/simulator.h"
#include "../core/job.h"
#include "../io/maintenance_reader.h"
#include "../io/swf_reader.h"
#include "../policies/policy_factory.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <deque>
#include <fstream>
#include <iomanip>
#include <limits>
#include <numeric>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using json = nlohmann::json;

namespace {

struct ScenarioConfig {
    std::string swf_path;
    std::string output_json;
    std::string baseline_policy = "fcfs";
    std::string preview_policy = "fcfs";
    SimMode mode = SimMode::Normal;
    int total_procs = 0;
    int max_submits = std::numeric_limits<int>::max();
    int start_job_index = 0;
    SimTime legacy_start_time = 0;
    double legacy_cluster_fraction = 1.0;
    int baseline_window_size = std::numeric_limits<int>::max();
    int preview_window_size = std::numeric_limits<int>::max();
    int baseline_backfill_mode = 0;
    int preview_backfill_mode = 0;
    SimTime snapshot_time = 0;
    SimTime horizon_seconds = 86400;
    SimTime downtime_duration = 14400;
    SimTime advisor_span_seconds = 604800;
    SimTime advisor_step_seconds = 21600;
    int force_job_id = -1;
    int selected_job_id = -1;
    SimTime proposed_downtime_offset_seconds = -1;
    SimTime proposed_downtime_duration_seconds = 14400;
    double proposed_downtime_notice_hours = 48.0;
    std::string maintenance_csv;
    double maintenance_notice_hours = 48.0;
};

struct ForceResult {
    int requested_job_id = -1;
    bool attempted = false;
    bool started_now = false;
    bool pinned = false;
    SimTime scheduled_start = -1;
    SimTime scheduled_end = -1;
    SimTime wait_until_start = 0;
    std::string reason = "not_requested";
};

struct JobForecast {
    int job_id = -1;
    int req_proc = 0;
    SimTime submit = 0;
    SimTime run = 0;
    SimTime start = -1;
    SimTime end = -1;
    SimTime wait_total = 0;
};

struct ScenarioOutcome {
    std::unordered_map<int, JobForecast> forecast_by_id;
    ForceResult force;
};

struct SnapshotState {
    SimTime snapshot_time = 0;
    int total_procs = 0;
    int available_procs = 0;
    int queued_count = 0;
    int running_count = 0;
    int completed_count = 0;
    int future_submit_count = 0;
    std::optional<SimTime> next_submit_time;
    std::optional<SimTime> next_completion_time;
    std::vector<int> queue_ids;
    std::vector<int> running_ids;
};

struct AnalogStats {
    int count = 0;
    double avg_wait = 0.0;
    double wait_p50 = 0.0;
    double wait_p90 = 0.0;
    std::string confidence_label = "exploratory";
    std::string basis_label = "no similar completed jobs before snapshot";
};

static std::string fmt_time_label(SimTime seconds) {
    std::ostringstream oss;
    if (seconds < 60) {
        oss << static_cast<long long>(std::llround(seconds)) << "s";
    } else if (seconds < 3600) {
        oss << std::fixed << std::setprecision(1) << (seconds / 60.0) << "m";
    } else if (seconds < 86400) {
        oss << std::fixed << std::setprecision(1) << (seconds / 3600.0) << "h";
    } else {
        oss << std::fixed << std::setprecision(1) << (seconds / 86400.0) << "d";
    }
    return oss.str();
}

static double percentile(std::vector<double> values, double pct) {
    if (values.empty())
        return 0.0;
    std::sort(values.begin(), values.end());
    if (pct <= 0.0)
        return values.front();
    if (pct >= 100.0)
        return values.back();
    double pos = (static_cast<double>(values.size()) - 1.0) * (pct / 100.0);
    std::size_t lo = static_cast<std::size_t>(std::floor(pos));
    std::size_t hi = static_cast<std::size_t>(std::ceil(pos));
    if (lo == hi)
        return values[lo];
    double frac = pos - static_cast<double>(lo);
    return values[lo] * (1.0 - frac) + values[hi] * frac;
}

static int proc_bucket(int procs) {
    int bucket = 0;
    int value = std::max(1, procs);
    while (value > 1) {
        value = (value + 1) / 2;
        bucket++;
    }
    return bucket;
}

static int walltime_bucket(SimTime seconds) {
    if (seconds < 600) return 0;
    if (seconds < 1800) return 1;
    if (seconds < 3600) return 2;
    if (seconds < 14400) return 3;
    if (seconds < 43200) return 4;
    if (seconds < 86400) return 5;
    return 6;
}

static std::vector<NodeInfo> make_nodes_for_procs(int total_procs) {
    return { NodeInfo(0, "cluster", Resources{total_procs, 0, 0}) };
}

static int infer_total_procs_from_jobs(const std::vector<SimJob>& jobs) {
    int max_seen = 1;
    for (const auto& job : jobs)
        max_seen = std::max(max_seen, job.requested.procs);
    return max_seen;
}

static ScenarioConfig load_config(const std::string& json_path) {
    std::ifstream f(json_path);
    if (!f.is_open())
        throw std::runtime_error("Cannot open preview config: " + json_path);
    json cfg = json::parse(f);

    ScenarioConfig out;
    out.swf_path = cfg.at("swf_path").get<std::string>();
    out.output_json = cfg.at("output_json").get<std::string>();
    out.baseline_policy = cfg.value("baseline_policy", std::string("fcfs"));
    out.preview_policy = cfg.value("preview_policy", out.baseline_policy);
    out.mode = parse_sim_mode(cfg.value("mode", std::string("normal")));
    out.total_procs = cfg.value("total_procs", 0);
    out.max_submits = cfg.value("max_submits", std::numeric_limits<int>::max());
    out.start_job_index = cfg.value("start_job_index", 0);
    out.legacy_start_time = cfg.value("legacy_start_time", static_cast<SimTime>(0));
    out.legacy_cluster_fraction = cfg.value("legacy_cluster_fraction", 1.0);
    out.baseline_window_size = cfg.value("baseline_window_size", std::numeric_limits<int>::max());
    out.preview_window_size = cfg.value("preview_window_size", out.baseline_window_size);
    out.baseline_backfill_mode = cfg.value("baseline_backfill_mode", 0);
    out.preview_backfill_mode = cfg.value("preview_backfill_mode", out.baseline_backfill_mode);
    out.snapshot_time = cfg.value("snapshot_time", static_cast<SimTime>(0));
    out.horizon_seconds = cfg.value("horizon_seconds", static_cast<SimTime>(86400));
    out.downtime_duration = cfg.value("downtime_duration", static_cast<SimTime>(14400));
    out.advisor_span_seconds = cfg.value("advisor_span_seconds", static_cast<SimTime>(604800));
    out.advisor_step_seconds = cfg.value("advisor_step_seconds", static_cast<SimTime>(21600));
    out.force_job_id = cfg.value("force_job_id", -1);
    out.selected_job_id = cfg.value("selected_job_id", -1);
    out.proposed_downtime_offset_seconds = cfg.value("proposed_downtime_offset_seconds", static_cast<SimTime>(-1));
    out.proposed_downtime_duration_seconds = cfg.value("proposed_downtime_duration_seconds", out.downtime_duration);
    out.proposed_downtime_notice_hours = cfg.value("proposed_downtime_notice_hours", 48.0);
    out.maintenance_csv = cfg.value("maintenance_csv", std::string());
    out.maintenance_notice_hours = cfg.value("maintenance_notice_hours", 48.0);
    return out;
}

static std::vector<SimJob> prepare_jobs(std::vector<SimJob> jobs,
                                        int start_job_index,
                                        int max_submits,
                                        SimTime submit_shift,
                                        double submit_scale) {
    std::stable_sort(jobs.begin(), jobs.end(),
                     [](const SimJob& a, const SimJob& b) {
                         return a.submit_time < b.submit_time;
                     });

    int start = std::max(0, std::min(start_job_index, static_cast<int>(jobs.size())));
    int remain = static_cast<int>(jobs.size()) - start;

    if (start < static_cast<int>(jobs.size())) {
        SimTime submit_origin = jobs[start].submit_time;
        for (auto& job : jobs) {
            SimTime shifted = job.submit_time - submit_origin;
            job.submit_time = submit_shift + (shifted * submit_scale);
        }
    }

    int limit = start + std::min(max_submits, remain);
    if (start <= 0 && limit >= static_cast<int>(jobs.size()))
        return jobs;

    std::vector<SimJob> sliced;
    for (int i = start; i < limit; ++i)
        sliced.push_back(jobs[static_cast<std::size_t>(i)]);
    return sliced;
}

static void register_sorted_jobs(Simulator& sim, const std::vector<SimJob>& jobs) {
    for (const auto& job : jobs) {
        sim.register_job(job);
        sim.create_submit_event(job.submit_time, job.id);
    }
}

static void apply_maintenance(Simulator& sim,
                              const std::vector<MaintenanceWindow>& windows) {
    if (windows.empty())
        return;
    sim.add_maintenance_windows(windows);
}

static void run_until(Simulator& sim, SimTime snapshot_time) {
    while (true) {
        auto next = sim.peek();
        if (!next || next->time > snapshot_time)
            break;
        sim.step();
    }
}

static SnapshotState inspect_snapshot(const Simulator& sim,
                                      const std::vector<SimJob>& jobs,
                                      SimTime snapshot_time) {
    SnapshotState out;
    out.snapshot_time = snapshot_time;
    out.total_procs = sim.total_procs();
    out.available_procs = sim.available_procs();
    out.queued_count = static_cast<int>(sim.get_job_queue().size());
    out.running_count = static_cast<int>(sim.running_jobs().size());
    out.completed_count = static_cast<int>(sim.completed_jobs().size());
    out.queue_ids.assign(sim.get_job_queue().begin(), sim.get_job_queue().end());
    out.running_ids = sim.running_jobs();

    for (const auto& job : jobs) {
        if (job.submit_time > snapshot_time)
            out.future_submit_count++;
    }

    for (const auto& job : jobs) {
        if (job.submit_time > snapshot_time) {
            if (!out.next_submit_time || job.submit_time < *out.next_submit_time)
                out.next_submit_time = job.submit_time;
        }
    }
    for (int job_id : sim.running_jobs()) {
        SimTime end_time = sim.get_job_end_time(job_id);
        if (end_time >= snapshot_time) {
            if (!out.next_completion_time || end_time < *out.next_completion_time)
                out.next_completion_time = end_time;
        }
    }
    return out;
}

static std::unordered_map<int, JobForecast> collect_forecasts(const Simulator& sim,
                                                              const std::vector<SimJob>& jobs) {
    std::unordered_map<int, JobForecast> out;
    out.reserve(jobs.size());
    for (const auto& job : jobs) {
        JobForecast row;
        row.job_id = job.id;
        row.req_proc = job.requested.procs;
        row.submit = job.submit_time;
        row.run = (row.start >= 0 && row.end >= row.start)
            ? (row.end - row.start)
            : (job.run_time > 0 ? job.run_time : job.walltime);
        row.start = sim.job_start_time(job.id);
        row.end = sim.job_end_time(job.id);
        row.wait_total = row.start >= 0 ? row.start - job.submit_time : 0;
        out.emplace(job.id, row);
    }
    return out;
}

static std::vector<const Job*> ordered_pending_jobs(const Simulator& s,
                                                    SchedulerPolicy* policy,
                                                    SimTime current_time) {
    State state;
    state.current_time = current_time;
    state.nodes = s.nodes();
    state.sim = &s;

    for (int id : s.get_job_queue())
        state.pending.push_back(&s.get_job(id));
    for (int id : s.running_jobs())
        state.running.push_back(&s.get_job(id));
    for (const Job* job : state.pending)
        state.job_walltimes.emplace(job->id, s.job_walltime_for(job->id));
    for (const Job* job : state.running)
        state.job_walltimes.emplace(job->id, s.job_walltime_for(job->id));

    return policy ? policy->order(state) : state.pending;
}

static std::deque<int> dispatch_preview_jobs(Simulator& s,
                                             SchedulerPolicy* policy,
                                             SimTime current_time,
                                             int force_job_id,
                                             ForceResult* force_result,
                                             SimTime snapshot_time) {
    std::vector<const Job*> ordered = ordered_pending_jobs(s, policy, current_time);
    bool forcing = force_job_id >= 0 && s.job_start_time(force_job_id) < 0;

    if (forcing) {
        auto it = std::find_if(
            ordered.begin(),
            ordered.end(),
            [force_job_id](const Job* job) { return job && job->id == force_job_id; }
        );
        if (it != ordered.end()) {
            const Job* forced = *it;
            ordered.erase(it);
            ordered.insert(ordered.begin(), forced);
            if (force_result) {
                force_result->attempted = true;
                force_result->pinned = true;
                if (force_result->reason == "not_requested")
                    force_result->reason = "pinned_waiting_for_capacity";
            }
        } else if (force_result && force_result->reason == "not_requested") {
            force_result->attempted = true;
            force_result->reason = "not_in_queue";
        }
    }

    std::unordered_set<int> started;
    for (const Job* job : ordered) {
        if (!job)
            continue;
        if (!s.try_start_job(job->id, current_time, false))
            break;
        started.insert(job->id);
        if (force_job_id >= 0 && job->id == force_job_id && force_result) {
            force_result->scheduled_start = current_time;
            force_result->scheduled_end = s.get_job_end_time(job->id);
            force_result->wait_until_start = std::max<SimTime>(0, current_time - snapshot_time);
            force_result->started_now = std::abs(current_time - snapshot_time) < 1e-9;
            force_result->reason = force_result->started_now ? "started_now" : "started_after_wait";
        }
    }

    std::deque<int> remaining;
    for (const Job* job : ordered) {
        if (job && !started.count(job->id))
            remaining.push_back(job->id);
    }
    return remaining;
}

static std::vector<MaintenanceWindow> build_planned_downtime_windows(const ScenarioConfig& cfg) {
    if (cfg.proposed_downtime_offset_seconds < 0 || cfg.proposed_downtime_duration_seconds <= 0)
        return {};

    MaintenanceWindow window;
    window.start_time = cfg.snapshot_time + cfg.proposed_downtime_offset_seconds;
    window.end_time = window.start_time + cfg.proposed_downtime_duration_seconds;
    window.scheduled = true;
    window.notice_time = std::max<SimTime>(
        cfg.snapshot_time,
        window.start_time - (cfg.proposed_downtime_notice_hours * 3600.0)
    );
    return {window};
}

static AnalogStats build_analog_stats(const Simulator& snapshot_sim,
                                      const SimJob& target) {
    AnalogStats stats;

    auto collect = [&](bool match_proc_bucket, bool match_walltime_bucket) {
        std::vector<double> waits;
        waits.reserve(snapshot_sim.completed_jobs().size());
        for (int job_id : snapshot_sim.completed_jobs()) {
            const SimJob& job = snapshot_sim.get_job(job_id);
            if (match_proc_bucket && proc_bucket(job.requested.procs) != proc_bucket(target.requested.procs))
                continue;
            if (match_walltime_bucket && walltime_bucket(job.requested_time) != walltime_bucket(target.requested_time))
                continue;
            SimTime start = snapshot_sim.job_start_time(job_id);
            if (start < 0)
                continue;
            waits.push_back(std::max<SimTime>(0, start - job.submit_time));
        }
        return waits;
    };

    std::vector<double> waits = collect(true, true);
    if (static_cast<int>(waits.size()) >= 4) {
        stats.basis_label = "completed jobs before snapshot with similar size and walltime class";
    } else {
        waits = collect(true, false);
        if (static_cast<int>(waits.size()) >= 4) {
            stats.basis_label = "completed jobs before snapshot with similar processor class";
        } else {
            waits = collect(false, false);
            if (!waits.empty())
                stats.basis_label = "all completed jobs before snapshot";
        }
    }

    stats.count = static_cast<int>(waits.size());
    if (waits.empty())
        return stats;

    stats.avg_wait = std::accumulate(waits.begin(), waits.end(), 0.0) / static_cast<double>(waits.size());
    stats.wait_p50 = percentile(waits, 50.0);
    stats.wait_p90 = percentile(waits, 90.0);
    if (stats.count >= 24)
        stats.confidence_label = "high";
    else if (stats.count >= 8)
        stats.confidence_label = "medium";
    else if (stats.count >= 3)
        stats.confidence_label = "low";
    else
        stats.confidence_label = "exploratory";
    return stats;
}

static json build_validation_signals(const AnalogStats* analog = nullptr) {
    json out = {
        {"engine_status", "validated"},
        {"engine_label", "Validated replay engine"},
        {"engine_detail", "CQTwin native replay has exact parity validation against CQSim on tested traces and tested configurations."},
        {"projection_status", "simulated_estimate"},
        {"projection_label", "Simulated estimate"},
        {"projection_detail", "Projected waits are deterministic what-if outputs from snapshot replay, not scheduler guarantees."},
        {"scope_label", "Validation scope"},
        {"scope_detail", "Trust strongest on the validated traces, policies, and configuration ranges documented in CQTwin."},
    };

    if (analog) {
        out["analogs_count"] = analog->count;
        out["analogs_confidence"] = analog->confidence_label;
        out["analogs_basis"] = analog->basis_label;
        out["analogs_wait_p50"] = std::round(analog->wait_p50 * 100.0) / 100.0;
        out["analogs_wait_p90"] = std::round(analog->wait_p90 * 100.0) / 100.0;
    }
    return out;
}

static void install_preview_callback(Simulator& sim,
                                     SchedulerPolicy* policy,
                                     int backfill_mode,
                                     int force_job_id,
                                     ForceResult* force_result,
                                     SimTime snapshot_time) {
    if (force_result)
        force_result->requested_job_id = force_job_id;

    sim.set_scheduling_callback([policy, backfill_mode, force_job_id, force_result, snapshot_time](Simulator& s, SimTime t) mutable {
        std::deque<int> remaining = dispatch_preview_jobs(
            s,
            policy,
            t,
            force_job_id,
            force_result,
            snapshot_time
        );

        if (backfill_mode > 0 && !remaining.empty()) {
            std::unordered_set<int> backfilled;
            for (int job_id : legacy_backfill_candidates(
                    s,
                    remaining,
                    t,
                    s.mode(),
                    backfill_mode)) {
                if (s.try_start_job(job_id, t, true))
                    backfilled.insert(job_id);
            }

            if (!backfilled.empty()) {
                std::deque<int> filtered;
                for (int job_id : remaining) {
                    if (!backfilled.count(job_id))
                        filtered.push_back(job_id);
                }
                remaining = std::move(filtered);
            }
        }

        if (force_result && force_job_id >= 0 && force_result->scheduled_start < 0 && force_result->reason == "not_requested")
            force_result->reason = "pinned_waiting_for_capacity";

        s.sort_job_queue(remaining);
    });
}

static ScenarioOutcome run_scenario(const Simulator& snapshot,
                                    const std::vector<SimJob>& jobs,
                                    const std::string& policy_name,
                                    int window_size,
                                    int backfill_mode,
                                    int force_job_id,
                                    SimTime snapshot_time,
                                    const std::vector<MaintenanceWindow>& extra_maintenance = {}) {
    ScenarioOutcome out;

    auto policy = make_heuristic_policy(policy_name, window_size);
    if (!policy)
        throw std::runtime_error("Unknown preview policy: " + policy_name);

    Simulator sim = snapshot.get_copy(false);
    if (!extra_maintenance.empty())
        sim.append_maintenance_windows(extra_maintenance);
    if (force_job_id >= 0)
        install_preview_callback(sim, policy.get(), backfill_mode, force_job_id, &out.force, snapshot_time);
    else
        install_legacy_scheduling_callback(
            sim,
            policy.get(),
            LegacyDispatchConfig{backfill_mode > 0, backfill_mode},
            nullptr,
            nullptr
        );

    sim.create_scheduling_cycle_event(snapshot_time);
    while (sim.has_events())
        sim.step();

    out.forecast_by_id = collect_forecasts(sim, jobs);
    if (force_job_id >= 0 && out.force.scheduled_start < 0) {
        auto it = out.forecast_by_id.find(force_job_id);
        if (it != out.forecast_by_id.end() && it->second.start >= 0) {
            out.force.scheduled_start = it->second.start;
            out.force.scheduled_end = it->second.end;
            out.force.wait_until_start = std::max<SimTime>(0, it->second.start - snapshot_time);
            out.force.started_now = std::abs(it->second.start - snapshot_time) < 1e-9;
            out.force.reason = out.force.started_now ? "started_now" : "started_after_wait";
            out.force.pinned = true;
            out.force.attempted = true;
        }
    }
    return out;
}

static json build_queue_entries(const SnapshotState& snapshot,
                                const std::unordered_map<int, JobForecast>& baseline,
                                const std::unordered_map<int, JobForecast>& preview,
                                const std::unordered_map<int, JobForecast>* forced,
                                const std::unordered_map<int, JobForecast>* downtime,
                                const std::vector<SimJob>& jobs) {
    std::unordered_map<int, const SimJob*> jobs_by_id;
    jobs_by_id.reserve(jobs.size());
    for (const auto& job : jobs)
        jobs_by_id.emplace(job.id, &job);

    json rows = json::array();
    for (std::size_t idx = 0; idx < snapshot.queue_ids.size(); ++idx) {
        int job_id = snapshot.queue_ids[idx];
        auto it_job = jobs_by_id.find(job_id);
        auto it_baseline = baseline.find(job_id);
        auto it_preview = preview.find(job_id);
        if (it_job == jobs_by_id.end() || it_baseline == baseline.end() || it_preview == preview.end())
            continue;

        const SimJob& job = *it_job->second;
        const JobForecast& fb = it_baseline->second;
        const JobForecast& fc = it_preview->second;

        json row = {
            {"queue_pos", static_cast<int>(idx) + 1},
            {"job_id", job_id},
            {"user_id", job.user_id},
            {"group_id", job.group_id},
            {"queue_id", job.queue_id},
            {"req_proc", job.requested.procs},
            {"req_walltime", job.requested_time},
            {"submit", job.submit_time},
            {"run", fc.run},
            {"current_wait", std::max<SimTime>(0, snapshot.snapshot_time - job.submit_time)},
            {"baseline_start", fb.start},
            {"baseline_end", fb.end},
            {"baseline_wait_total", fb.wait_total},
            {"baseline_wait_remaining", std::max<SimTime>(0, fb.start - snapshot.snapshot_time)},
            {"preview_start", fc.start},
            {"preview_end", fc.end},
            {"preview_wait_total", fc.wait_total},
            {"preview_wait_remaining", std::max<SimTime>(0, fc.start - snapshot.snapshot_time)},
            {"preview_delta_start", fc.start - fb.start},
            {"preview_delta_wait", fc.wait_total - fb.wait_total},
        };

        if (forced) {
            auto it_forced = forced->find(job_id);
            if (it_forced != forced->end()) {
                const JobForecast& ff = it_forced->second;
                row["forced_start"] = ff.start;
                row["forced_end"] = ff.end;
                row["forced_wait_total"] = ff.wait_total;
                row["forced_wait_remaining"] = std::max<SimTime>(0, ff.start - snapshot.snapshot_time);
                row["forced_delta_start"] = ff.start - fc.start;
                row["forced_delta_wait"] = ff.wait_total - fc.wait_total;
            }
        }
        if (downtime) {
            auto it_downtime = downtime->find(job_id);
            if (it_downtime != downtime->end()) {
                const JobForecast& fd = it_downtime->second;
                row["downtime_start"] = fd.start;
                row["downtime_end"] = fd.end;
                row["downtime_wait_total"] = fd.wait_total;
                row["downtime_wait_remaining"] = std::max<SimTime>(0, fd.start - snapshot.snapshot_time);
                row["downtime_delta_start"] = fd.start - fc.start;
                row["downtime_delta_wait"] = fd.wait_total - fc.wait_total;
            }
        }
        rows.push_back(std::move(row));
    }
    return rows;
}

static json build_running_entries(const SnapshotState& snapshot,
                                  const std::vector<SimJob>& jobs,
                                  const std::unordered_map<int, JobForecast>& preview) {
    std::unordered_map<int, const SimJob*> jobs_by_id;
    jobs_by_id.reserve(jobs.size());
    for (const auto& job : jobs)
        jobs_by_id.emplace(job.id, &job);

    json rows = json::array();
    for (int job_id : snapshot.running_ids) {
        auto it_job = jobs_by_id.find(job_id);
        auto it_preview = preview.find(job_id);
        if (it_job == jobs_by_id.end() || it_preview == preview.end())
            continue;
        const SimJob& job = *it_job->second;
        const JobForecast& fc = it_preview->second;
        rows.push_back({
            {"job_id", job_id},
            {"user_id", job.user_id},
            {"group_id", job.group_id},
            {"queue_id", job.queue_id},
            {"req_proc", job.requested.procs},
            {"req_walltime", job.requested_time},
            {"submit", job.submit_time},
            {"start", fc.start},
            {"end", fc.end},
            {"remaining_runtime", std::max<SimTime>(0, fc.end - snapshot.snapshot_time)},
            {"run", fc.run},
        });
    }
    return rows;
}

static json build_horizon_state(const std::unordered_map<int, JobForecast>& forecast,
                                const std::vector<SimJob>& jobs,
                                SimTime horizon_time,
                                std::size_t max_rows = 200) {
    struct HorizonRow {
        int job_id = -1;
        long long user_id = -1;
        int req_proc = 0;
        SimTime req_walltime = 0;
        SimTime submit = 0;
        SimTime start = -1;
        SimTime end = -1;
        SimTime wait_total = 0;
        SimTime remaining_wait = 0;
    };

    std::vector<HorizonRow> queued;
    std::vector<HorizonRow> running;
    int completed = 0;
    int future = 0;
    std::unordered_map<int, const SimJob*> jobs_by_id;
    jobs_by_id.reserve(jobs.size());
    for (const auto& job : jobs)
        jobs_by_id.emplace(job.id, &job);

    for (const auto& [job_id, row] : forecast) {
        auto it_job = jobs_by_id.find(job_id);
        long long user_id = it_job != jobs_by_id.end() ? it_job->second->user_id : -1;
        SimTime req_walltime = it_job != jobs_by_id.end() ? it_job->second->requested_time : row.run;
        if (row.submit > horizon_time) {
            future++;
            continue;
        }
        if (row.start < 0 || row.start > horizon_time) {
            queued.push_back({
                job_id,
                user_id,
                row.req_proc,
                req_walltime,
                row.submit,
                row.start,
                row.end,
                row.wait_total,
                std::max<SimTime>(0, row.start - horizon_time),
            });
        } else if (row.end > horizon_time) {
            running.push_back({
                job_id,
                user_id,
                row.req_proc,
                req_walltime,
                row.submit,
                row.start,
                row.end,
                row.wait_total,
                0,
            });
        } else {
            completed++;
        }
    }

    auto sort_queued = [](const HorizonRow& a, const HorizonRow& b) {
        if (a.start != b.start)
            return a.start < b.start;
        return a.job_id < b.job_id;
    };
    auto sort_running = [](const HorizonRow& a, const HorizonRow& b) {
        if (a.end != b.end)
            return a.end < b.end;
        return a.job_id < b.job_id;
    };
    std::sort(queued.begin(), queued.end(), sort_queued);
    std::sort(running.begin(), running.end(), sort_running);

    json queued_rows = json::array();
    for (std::size_t i = 0; i < std::min(max_rows, queued.size()); ++i) {
        const auto& row = queued[i];
        queued_rows.push_back({
            {"queue_pos", static_cast<int>(i) + 1},
            {"job_id", row.job_id},
            {"user_id", row.user_id},
            {"req_proc", row.req_proc},
            {"req_walltime", row.req_walltime},
            {"submit", row.submit},
            {"start", row.start},
            {"end", row.end},
            {"wait_total", row.wait_total},
            {"remaining_wait", row.remaining_wait},
        });
    }

    json running_rows = json::array();
    for (std::size_t i = 0; i < std::min(max_rows, running.size()); ++i) {
        const auto& row = running[i];
        running_rows.push_back({
            {"job_id", row.job_id},
            {"user_id", row.user_id},
            {"req_proc", row.req_proc},
            {"req_walltime", row.req_walltime},
            {"submit", row.submit},
            {"start", row.start},
            {"end", row.end},
            {"remaining_runtime", std::max<SimTime>(0, row.end - horizon_time)},
        });
    }

    return {
        {"time", horizon_time},
        {"queued_count", static_cast<int>(queued.size())},
        {"running_count", static_cast<int>(running.size())},
        {"completed_count", completed},
        {"future_submit_count", future},
        {"queued_jobs", queued_rows},
        {"running_jobs", running_rows},
    };
}

static json build_downtime_advisor(const std::unordered_map<int, JobForecast>& forecast,
                                   SimTime snapshot_time,
                                   SimTime duration,
                                   SimTime span,
                                   SimTime step,
                                   int total_procs) {
    struct Candidate {
        SimTime start = 0;
        int queued_jobs = 0;
        int running_jobs = 0;
        int running_procs = 0;
        int overlapping_jobs = 0;
        double score = 0.0;
    };

    std::vector<Candidate> rows;
    if (step <= 0)
        step = 21600;
    if (span <= 0)
        span = step;

    std::vector<double> queue_scale;
    std::vector<double> proc_scale;
    std::vector<double> overlap_scale;

    for (SimTime t = snapshot_time; t <= snapshot_time + span; t += step) {
        Candidate c;
        c.start = t;
        for (const auto& [job_id, row] : forecast) {
            if (row.submit <= t && row.start > t)
                c.queued_jobs++;
            if (row.start <= t && row.end > t) {
                c.running_jobs++;
                c.running_procs += row.req_proc;
            }
            if (row.submit <= t + duration && row.start < t + duration && row.end > t)
                c.overlapping_jobs++;
        }
        rows.push_back(c);
        queue_scale.push_back(static_cast<double>(c.queued_jobs));
        proc_scale.push_back(static_cast<double>(c.running_procs));
        overlap_scale.push_back(static_cast<double>(c.overlapping_jobs));
    }

    double queue_p95 = std::max(1.0, percentile(queue_scale, 95.0));
    double proc_p95 = std::max(1.0, percentile(proc_scale, 95.0));
    double overlap_p95 = std::max(1.0, percentile(overlap_scale, 95.0));

    for (auto& row : rows) {
        double queue_term = std::min(1.0, static_cast<double>(row.queued_jobs) / queue_p95);
        double proc_term = total_procs > 0
            ? std::min(1.0, static_cast<double>(row.running_procs) / static_cast<double>(total_procs))
            : std::min(1.0, static_cast<double>(row.running_procs) / proc_p95);
        double overlap_term = std::min(1.0, static_cast<double>(row.overlapping_jobs) / overlap_p95);
        row.score = (0.45 * proc_term) + (0.35 * queue_term) + (0.20 * overlap_term);
    }

    std::sort(rows.begin(), rows.end(), [](const Candidate& a, const Candidate& b) {
        if (a.score != b.score)
            return a.score < b.score;
        return a.start < b.start;
    });

    json out = json::array();
    for (std::size_t i = 0; i < std::min<std::size_t>(6, rows.size()); ++i) {
        const auto& row = rows[i];
        out.push_back({
            {"rank", static_cast<int>(i) + 1},
            {"start_time", row.start},
            {"offset_seconds", row.start - snapshot_time},
            {"offset_label", fmt_time_label(row.start - snapshot_time)},
            {"queued_jobs", row.queued_jobs},
            {"running_jobs", row.running_jobs},
            {"running_procs", row.running_procs},
            {"overlapping_jobs", row.overlapping_jobs},
            {"impact_score", std::round(row.score * 1000.0) / 1000.0},
        });
    }
    return out;
}

static json build_impact_summary(const json& queue_rows, bool has_forced) {
    std::vector<double> baseline_remaining;
    std::vector<double> preview_remaining;
    std::vector<double> forced_remaining;
    int preview_jobs_moved_earlier = 0;
    int preview_jobs_moved_later = 0;
    double preview_total_delta = 0.0;
    double preview_max_increase = 0.0;
    double preview_max_decrease = 0.0;
    int jobs_moved_earlier = 0;
    int jobs_moved_later = 0;
    double total_delta = 0.0;
    double max_increase = 0.0;
    double max_decrease = 0.0;

    for (const auto& row : queue_rows) {
        baseline_remaining.push_back(row.value("baseline_wait_remaining", 0.0));
        preview_remaining.push_back(row.value("preview_wait_remaining", 0.0));
        double preview_delta = row.value("preview_delta_wait", 0.0);
        preview_total_delta += preview_delta;
        if (preview_delta < 0)
            preview_jobs_moved_earlier++;
        else if (preview_delta > 0)
            preview_jobs_moved_later++;
        preview_max_increase = std::max(preview_max_increase, preview_delta);
        preview_max_decrease = std::min(preview_max_decrease, preview_delta);
        if (!has_forced || !row.contains("forced_wait_remaining"))
            continue;
        double forced_val = row.value("forced_wait_remaining", 0.0);
        double delta = row.value("forced_delta_wait", 0.0);
        forced_remaining.push_back(forced_val);
        total_delta += delta;
        if (delta < 0)
            jobs_moved_earlier++;
        else if (delta > 0)
            jobs_moved_later++;
        max_increase = std::max(max_increase, delta);
        max_decrease = std::min(max_decrease, delta);
    }

    json out = {
        {"queued_jobs", static_cast<int>(queue_rows.size())},
        {"baseline_avg_remaining_wait", baseline_remaining.empty() ? 0.0 : std::round((std::accumulate(baseline_remaining.begin(), baseline_remaining.end(), 0.0) / baseline_remaining.size()) * 100.0) / 100.0},
        {"baseline_p90_remaining_wait", std::round(percentile(baseline_remaining, 90.0) * 100.0) / 100.0},
        {"preview_avg_remaining_wait", preview_remaining.empty() ? 0.0 : std::round((std::accumulate(preview_remaining.begin(), preview_remaining.end(), 0.0) / preview_remaining.size()) * 100.0) / 100.0},
        {"preview_p90_remaining_wait", std::round(percentile(preview_remaining, 90.0) * 100.0) / 100.0},
        {"preview_jobs_moved_earlier", preview_jobs_moved_earlier},
        {"preview_jobs_moved_later", preview_jobs_moved_later},
        {"avg_preview_delta_wait", queue_rows.empty() ? 0.0 : std::round((preview_total_delta / static_cast<double>(queue_rows.size())) * 100.0) / 100.0},
        {"max_preview_wait_increase", std::round(preview_max_increase * 100.0) / 100.0},
        {"max_preview_wait_decrease", std::round(preview_max_decrease * 100.0) / 100.0},
    };

    if (has_forced) {
        out["forced_avg_remaining_wait"] = forced_remaining.empty() ? 0.0 : std::round((std::accumulate(forced_remaining.begin(), forced_remaining.end(), 0.0) / forced_remaining.size()) * 100.0) / 100.0;
        out["jobs_moved_earlier"] = jobs_moved_earlier;
        out["jobs_moved_later"] = jobs_moved_later;
        out["avg_forced_delta_wait"] = queue_rows.empty() ? 0.0 : std::round((total_delta / static_cast<double>(queue_rows.size())) * 100.0) / 100.0;
        out["max_forced_wait_increase"] = std::round(max_increase * 100.0) / 100.0;
        out["max_forced_wait_decrease"] = std::round(max_decrease * 100.0) / 100.0;
    }
    return out;
}

static json build_downtime_summary(const json& queue_rows) {
    std::vector<double> preview_remaining;
    std::vector<double> downtime_remaining;
    int jobs_delayed = 0;
    int jobs_earlier = 0;
    double total_delta = 0.0;
    double max_increase = 0.0;
    double max_decrease = 0.0;

    for (const auto& row : queue_rows) {
        if (!row.contains("downtime_wait_remaining"))
            continue;
        preview_remaining.push_back(row.value("preview_wait_remaining", 0.0));
        downtime_remaining.push_back(row.value("downtime_wait_remaining", 0.0));
        double delta = row.value("downtime_delta_wait", 0.0);
        total_delta += delta;
        if (delta > 0)
            jobs_delayed++;
        else if (delta < 0)
            jobs_earlier++;
        max_increase = std::max(max_increase, delta);
        max_decrease = std::min(max_decrease, delta);
    }

    return {
        {"jobs_compared", static_cast<int>(downtime_remaining.size())},
        {"preview_avg_remaining_wait", preview_remaining.empty() ? 0.0 : std::round((std::accumulate(preview_remaining.begin(), preview_remaining.end(), 0.0) / preview_remaining.size()) * 100.0) / 100.0},
        {"downtime_avg_remaining_wait", downtime_remaining.empty() ? 0.0 : std::round((std::accumulate(downtime_remaining.begin(), downtime_remaining.end(), 0.0) / downtime_remaining.size()) * 100.0) / 100.0},
        {"downtime_p90_remaining_wait", std::round(percentile(downtime_remaining, 90.0) * 100.0) / 100.0},
        {"jobs_delayed", jobs_delayed},
        {"jobs_moved_earlier", jobs_earlier},
        {"avg_delta_wait", downtime_remaining.empty() ? 0.0 : std::round((total_delta / static_cast<double>(downtime_remaining.size())) * 100.0) / 100.0},
        {"max_wait_increase", std::round(max_increase * 100.0) / 100.0},
        {"max_wait_decrease", std::round(max_decrease * 100.0) / 100.0},
    };
}

static json build_selected_job_explanation(const ScenarioConfig& cfg,
                                           const SnapshotState& snapshot,
                                           const Simulator& snapshot_sim,
                                           const std::vector<SimJob>& jobs,
                                           const std::vector<MaintenanceWindow>& maintenance_windows,
                                           SchedulerPolicy* baseline_policy,
                                           const std::unordered_map<int, JobForecast>& baseline,
                                           const std::unordered_map<int, JobForecast>& preview,
                                           const std::unordered_map<int, JobForecast>* forced,
                                           int selected_job_id) {
    if (selected_job_id < 0)
        return json();

    std::unordered_map<int, const SimJob*> jobs_by_id;
    jobs_by_id.reserve(jobs.size());
    for (const auto& job : jobs)
        jobs_by_id.emplace(job.id, &job);

    auto it_job = jobs_by_id.find(selected_job_id);
    auto it_baseline = baseline.find(selected_job_id);
    auto it_preview = preview.find(selected_job_id);
    if (it_job == jobs_by_id.end() || it_baseline == baseline.end() || it_preview == preview.end())
        return json();

    const SimJob& target = *it_job->second;
    const JobForecast& fb = it_baseline->second;
    const JobForecast& fp = it_preview->second;

    int queue_position = -1;
    for (std::size_t i = 0; i < snapshot.queue_ids.size(); ++i) {
        if (snapshot.queue_ids[i] == selected_job_id) {
            queue_position = static_cast<int>(i) + 1;
            break;
        }
    }

    std::vector<const Job*> ordered = ordered_pending_jobs(snapshot_sim, baseline_policy, snapshot.snapshot_time);
    int policy_rank = -1;
    for (std::size_t i = 0; i < ordered.size(); ++i) {
        if (ordered[i] && ordered[i]->id == selected_job_id) {
            policy_rank = static_cast<int>(i) + 1;
            break;
        }
    }

    std::vector<std::pair<SimTime, int>> running_capacity_timeline;
    running_capacity_timeline.reserve(snapshot.running_ids.size());
    for (int job_id : snapshot.running_ids) {
        auto it_running = baseline.find(job_id);
        auto it_running_job = jobs_by_id.find(job_id);
        if (it_running == baseline.end() || it_running_job == jobs_by_id.end())
            continue;
        running_capacity_timeline.push_back({
            it_running->second.end,
            it_running_job->second->requested.procs,
        });
    }
    std::sort(running_capacity_timeline.begin(), running_capacity_timeline.end(),
              [](const auto& a, const auto& b) {
                  if (a.first != b.first)
                      return a.first < b.first;
                  return a.second < b.second;
              });

    SimTime earliest_capacity_start = snapshot.snapshot_time;
    int free_capacity = snapshot.available_procs;
    if (target.requested.procs > free_capacity) {
        earliest_capacity_start = std::numeric_limits<SimTime>::max();
        for (const auto& [time, procs] : running_capacity_timeline) {
            free_capacity += procs;
            if (free_capacity >= target.requested.procs) {
                earliest_capacity_start = time;
                break;
            }
        }
    }
    SimTime capacity_wait_remaining = std::max<SimTime>(0, earliest_capacity_start - snapshot.snapshot_time);
    SimTime baseline_wait_remaining = std::max<SimTime>(0, fb.start - snapshot.snapshot_time);
    SimTime policy_delay = std::max<SimTime>(0, baseline_wait_remaining - capacity_wait_remaining);
    int effective_start_rank = 1;

    struct AheadRow {
        int job_id = -1;
        long long user_id = -1;
        int req_proc = 0;
        SimTime start = 0;
        bool before_policy_rank = false;
    };

    std::vector<AheadRow> ahead_jobs;
    for (int job_id : snapshot.queue_ids) {
        if (job_id == selected_job_id)
            continue;
        auto it_other = baseline.find(job_id);
        auto it_other_job = jobs_by_id.find(job_id);
        if (it_other == baseline.end() || it_other_job == jobs_by_id.end())
            continue;
        if (it_other->second.start >= 0 && it_other->second.start < fb.start) {
            bool before_rank = false;
            if (policy_rank > 0) {
                for (int i = 0; i < policy_rank - 1 && i < static_cast<int>(ordered.size()); ++i) {
                    if (ordered[static_cast<std::size_t>(i)] && ordered[static_cast<std::size_t>(i)]->id == job_id) {
                        before_rank = true;
                        break;
                    }
                }
            }
            ahead_jobs.push_back({
                job_id,
                it_other_job->second->user_id,
                it_other_job->second->requested.procs,
                it_other->second.start,
                before_rank,
            });
        }
    }
    std::sort(ahead_jobs.begin(), ahead_jobs.end(), [](const AheadRow& a, const AheadRow& b) {
        if (a.start != b.start)
            return a.start < b.start;
        return a.job_id < b.job_id;
    });
    effective_start_rank += static_cast<int>(ahead_jobs.size());

    json ahead_json = json::array();
    for (std::size_t i = 0; i < std::min<std::size_t>(6, ahead_jobs.size()); ++i) {
        const auto& row = ahead_jobs[i];
        ahead_json.push_back({
            {"job_id", row.job_id},
            {"user_id", row.user_id},
            {"req_proc", row.req_proc},
            {"start", row.start},
            {"starts_in", std::max<SimTime>(0, row.start - snapshot.snapshot_time)},
            {"reason", row.before_policy_rank ? "ahead in policy order" : "fits earlier under current availability/backfill"},
        });
    }

    json running_json = json::array();
    for (int job_id : snapshot.running_ids) {
        const SimJob& running = snapshot_sim.get_job(job_id);
        auto it_running = baseline.find(job_id);
        if (it_running == baseline.end())
            continue;
        SimTime end = it_running->second.end;
        if (end < snapshot.snapshot_time)
            continue;
        running_json.push_back({
            {"job_id", job_id},
            {"user_id", running.user_id},
            {"req_proc", running.requested.procs},
            {"end", end},
            {"remaining_runtime", std::max<SimTime>(0, end - snapshot.snapshot_time)},
        });
    }
    std::sort(running_json.begin(), running_json.end(), [](const json& a, const json& b) {
        if (a.value("end", 0.0) != b.value("end", 0.0))
            return a.value("end", 0.0) < b.value("end", 0.0);
        return a.value("job_id", 0) < b.value("job_id", 0);
    });
    if (running_json.size() > 6)
        running_json.erase(running_json.begin() + 6, running_json.end());

    json maintenance_json;
    for (const auto& window : maintenance_windows) {
        if (window.end_time <= snapshot.snapshot_time)
            continue;
        maintenance_json = {
            {"scheduled", window.scheduled},
            {"notice_time", window.notice_time},
            {"start_time", window.start_time},
            {"end_time", window.end_time},
            {"starts_in", std::max<SimTime>(0, window.start_time - snapshot.snapshot_time)},
            {"duration", std::max<SimTime>(0, window.end_time - window.start_time)},
        };
        break;
    }

    AnalogStats analog = build_analog_stats(snapshot_sim, target);
    std::vector<std::string> explanation_lines;
    explanation_lines.push_back(
        "Current policy projects this job to start in " + fmt_time_label(baseline_wait_remaining) + "."
    );
    explanation_lines.push_back(
        "Capacity alone could fit the job in " + fmt_time_label(capacity_wait_remaining) +
        "; the extra " + fmt_time_label(policy_delay) + " comes from ordering, reservations, or maintenance constraints."
    );
    if (queue_position > 0 && policy_rank > 0) {
        explanation_lines.push_back(
            "Raw queue position is #" + std::to_string(queue_position) +
            ", but the current policy ranks it #" + std::to_string(policy_rank) + " for dispatch."
        );
    }
    if (!ahead_jobs.empty()) {
        explanation_lines.push_back(
            std::to_string(static_cast<int>(ahead_jobs.size())) +
            " queued job(s) are projected to start earlier under the current policy."
        );
    }
    if (!maintenance_json.is_null()) {
        explanation_lines.push_back(
            "The next maintenance window begins in " +
            fmt_time_label(maintenance_json.value("starts_in", 0.0)) + "."
        );
    }
    explanation_lines.push_back(
        "Confidence is " + analog.confidence_label + " based on " +
        std::to_string(analog.count) + " similar completed jobs before this snapshot."
    );

    json out = {
        {"job_id", selected_job_id},
        {"user_id", target.user_id},
        {"queue_position", queue_position},
        {"policy_rank", policy_rank},
        {"effective_start_rank", effective_start_rank},
        {"req_proc", target.requested.procs},
        {"req_walltime", target.requested_time},
        {"submit", target.submit_time},
        {"baseline_start", fb.start},
        {"baseline_wait_remaining", baseline_wait_remaining},
        {"preview_start", fp.start},
        {"preview_wait_remaining", std::max<SimTime>(0, fp.start - snapshot.snapshot_time)},
        {"earliest_capacity_start", earliest_capacity_start},
        {"capacity_wait_remaining", capacity_wait_remaining},
        {"policy_delay_remaining", policy_delay},
        {"ahead_jobs", ahead_json},
        {"running_blockers", running_json},
        {"next_maintenance", maintenance_json},
        {"explanation_lines", explanation_lines},
        {"confidence", {
            {"label", analog.confidence_label},
            {"analog_jobs", analog.count},
            {"basis", analog.basis_label},
            {"wait_p50", std::round(analog.wait_p50 * 100.0) / 100.0},
            {"wait_p90", std::round(analog.wait_p90 * 100.0) / 100.0},
            {"avg_wait", std::round(analog.avg_wait * 100.0) / 100.0},
            {"engine_validation", "validated_on_tested_scope"},
            {"projection_type", "deterministic_native_replay"},
        }},
        {"validation", build_validation_signals(&analog)},
    };

    if (forced) {
        auto it_forced = forced->find(selected_job_id);
        if (it_forced != forced->end()) {
            out["forced_start"] = it_forced->second.start;
            out["forced_wait_remaining"] = std::max<SimTime>(0, it_forced->second.start - snapshot.snapshot_time);
            out["forced_delta_wait"] = it_forced->second.wait_total - fp.wait_total;
        }
    }

    return out;
}

}  // namespace

ScenarioPreview::ScenarioPreview(const std::string& json_path)
    : json_path_(json_path) {}

void ScenarioPreview::run() {
    ScenarioConfig cfg = load_config(json_path_);

    SwfReader reader(cfg.swf_path);
    std::vector<SimJob> jobs = prepare_jobs(
        reader.read(),
        cfg.start_job_index,
        cfg.max_submits,
        cfg.legacy_start_time,
        cfg.legacy_cluster_fraction
    );

    int total_procs = cfg.total_procs;
    if (total_procs <= 0)
        total_procs = reader.max_procs();
    if (total_procs <= 0)
        total_procs = infer_total_procs_from_jobs(jobs);

    auto baseline_policy = make_heuristic_policy(cfg.baseline_policy, cfg.baseline_window_size);
    if (!baseline_policy)
        throw std::runtime_error("Unknown baseline policy: " + cfg.baseline_policy);

    std::vector<MaintenanceWindow> maintenance_windows;
    if (!cfg.maintenance_csv.empty()) {
        MaintenanceReader reader(cfg.maintenance_csv, cfg.maintenance_notice_hours);
        maintenance_windows = reader.read();
    }

    Simulator baseline_sim(std::vector<SimJob>{}, make_nodes_for_procs(total_procs), cfg.mode, "");
    register_sorted_jobs(baseline_sim, jobs);
    apply_maintenance(baseline_sim, maintenance_windows);
    install_legacy_scheduling_callback(
        baseline_sim,
        baseline_policy.get(),
        LegacyDispatchConfig{cfg.baseline_backfill_mode > 0, cfg.baseline_backfill_mode},
        nullptr,
        nullptr
    );

    run_until(baseline_sim, cfg.snapshot_time);
    SnapshotState snapshot = inspect_snapshot(baseline_sim, jobs, cfg.snapshot_time);
    std::vector<MaintenanceWindow> proposed_downtime = build_planned_downtime_windows(cfg);
    int selected_job_id = cfg.selected_job_id >= 0 ? cfg.selected_job_id : cfg.force_job_id;
    if (selected_job_id < 0 && !snapshot.queue_ids.empty())
        selected_job_id = snapshot.queue_ids.front();

    ScenarioOutcome baseline_future = run_scenario(
        baseline_sim,
        jobs,
        cfg.baseline_policy,
        cfg.baseline_window_size,
        cfg.baseline_backfill_mode,
        -1,
        cfg.snapshot_time
    );

    ScenarioOutcome preview = run_scenario(
        baseline_sim,
        jobs,
        cfg.preview_policy,
        cfg.preview_window_size,
        cfg.preview_backfill_mode,
        -1,
        cfg.snapshot_time
    );

    std::optional<ScenarioOutcome> forced;
    if (cfg.force_job_id >= 0) {
        forced = run_scenario(
            baseline_sim,
            jobs,
            cfg.preview_policy,
            cfg.preview_window_size,
            cfg.preview_backfill_mode,
            cfg.force_job_id,
            cfg.snapshot_time
        );
    }

    std::optional<ScenarioOutcome> preview_with_downtime;
    if (!proposed_downtime.empty()) {
        preview_with_downtime = run_scenario(
            baseline_sim,
            jobs,
            cfg.preview_policy,
            cfg.preview_window_size,
            cfg.preview_backfill_mode,
            -1,
            cfg.snapshot_time,
            proposed_downtime
        );
    }

    json queue_rows = build_queue_entries(
        snapshot,
        baseline_future.forecast_by_id,
        preview.forecast_by_id,
        forced ? &forced->forecast_by_id : nullptr,
        preview_with_downtime ? &preview_with_downtime->forecast_by_id : nullptr,
        jobs
    );

    std::optional<SimTime> actual_next_completion_time;
    for (int job_id : snapshot.running_ids) {
        auto it = baseline_future.forecast_by_id.find(job_id);
        if (it == baseline_future.forecast_by_id.end())
            continue;
        SimTime end = it->second.end;
        if (end < snapshot.snapshot_time)
            continue;
        if (!actual_next_completion_time || end < *actual_next_completion_time)
            actual_next_completion_time = end;
    }

    json output = {
        {"meta", {
            {"swf_path", cfg.swf_path},
            {"baseline_policy", cfg.baseline_policy},
            {"preview_policy", cfg.preview_policy},
            {"baseline_backfill_mode", cfg.baseline_backfill_mode},
            {"preview_backfill_mode", cfg.preview_backfill_mode},
            {"baseline_window_size", cfg.baseline_window_size},
            {"preview_window_size", cfg.preview_window_size},
            {"snapshot_time", cfg.snapshot_time},
            {"horizon_seconds", cfg.horizon_seconds},
            {"force_job_id", cfg.force_job_id},
            {"proposed_downtime_offset_seconds", cfg.proposed_downtime_offset_seconds},
            {"proposed_downtime_duration_seconds", cfg.proposed_downtime_duration_seconds},
            {"proposed_downtime_notice_hours", cfg.proposed_downtime_notice_hours},
        }},
        {"snapshot", {
            {"snapshot_time", snapshot.snapshot_time},
            {"total_procs", snapshot.total_procs},
            {"available_procs", snapshot.available_procs},
            {"queued_count", snapshot.queued_count},
            {"running_count", snapshot.running_count},
            {"completed_count", snapshot.completed_count},
            {"future_submit_count", snapshot.future_submit_count},
            {"next_submit_time", snapshot.next_submit_time ? json(*snapshot.next_submit_time) : json()},
            {"next_completion_time", actual_next_completion_time ? json(*actual_next_completion_time) : json()},
        }},
        {"queued_jobs", queue_rows},
        {"running_jobs", build_running_entries(snapshot, jobs, preview.forecast_by_id)},
        {"baseline_horizon_state", build_horizon_state(baseline_future.forecast_by_id, jobs, cfg.snapshot_time + cfg.horizon_seconds)},
        {"preview_horizon_state", build_horizon_state(preview.forecast_by_id, jobs, cfg.snapshot_time + cfg.horizon_seconds)},
        {"baseline_downtime_advisor", build_downtime_advisor(
            baseline_future.forecast_by_id,
            cfg.snapshot_time,
            cfg.downtime_duration,
            std::max(cfg.horizon_seconds, cfg.advisor_span_seconds),
            cfg.advisor_step_seconds,
            total_procs
        )},
        {"preview_downtime_advisor", build_downtime_advisor(
            preview.forecast_by_id,
            cfg.snapshot_time,
            cfg.downtime_duration,
            std::max(cfg.horizon_seconds, cfg.advisor_span_seconds),
            cfg.advisor_step_seconds,
            total_procs
        )},
        {"impact_summary", build_impact_summary(queue_rows, forced.has_value())},
        {"validation_signals", build_validation_signals()},
    };

    if (!proposed_downtime.empty() && preview_with_downtime) {
        const MaintenanceWindow& window = proposed_downtime.front();
        output["planned_downtime"] = {
            {"enabled", true},
            {"start_time", window.start_time},
            {"end_time", window.end_time},
            {"notice_time", window.notice_time},
            {"duration_seconds", cfg.proposed_downtime_duration_seconds},
            {"offset_seconds", cfg.proposed_downtime_offset_seconds},
            {"offset_label", fmt_time_label(cfg.proposed_downtime_offset_seconds)},
        };
        output["downtime_horizon_state"] = build_horizon_state(
            preview_with_downtime->forecast_by_id,
            jobs,
            cfg.snapshot_time + cfg.horizon_seconds
        );
        output["downtime_window_state"] = build_horizon_state(
            preview_with_downtime->forecast_by_id,
            jobs,
            window.start_time
        );
        output["downtime_impact_summary"] = build_downtime_summary(queue_rows);
    }

    if (forced) {
        output["force_result"] = {
            {"requested_job_id", forced->force.requested_job_id},
            {"attempted", forced->force.attempted},
            {"started_now", forced->force.started_now},
            {"pinned", forced->force.pinned},
            {"scheduled_start", forced->force.scheduled_start},
            {"scheduled_end", forced->force.scheduled_end},
            {"wait_until_start", forced->force.wait_until_start},
            {"reason", forced->force.reason},
        };
        output["forced_horizon_state"] = build_horizon_state(
            forced->forecast_by_id,
            jobs,
            cfg.snapshot_time + cfg.horizon_seconds
        );
    }

    output["selected_job"] = build_selected_job_explanation(
        cfg,
        snapshot,
        baseline_sim,
        jobs,
        maintenance_windows,
        baseline_policy.get(),
        baseline_future.forecast_by_id,
        preview.forecast_by_id,
        forced ? &forced->forecast_by_id : nullptr,
        selected_job_id
    );

    std::ofstream out(cfg.output_json);
    if (!out.is_open())
        throw std::runtime_error("Cannot write preview output: " + cfg.output_json);
    out << std::setw(2) << output << "\n";
}
