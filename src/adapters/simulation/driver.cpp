#include "driver.h"
#include "legacy_dispatch.h"
#include <algorithm>
#include <cctype>
#include <iostream>
#include <iomanip>
#include <filesystem>
#include <chrono>
#include <limits>
#include <cmath>

// ── Constructor ───────────────────────────────────────────────────────────────

Driver::Driver(std::vector<SimJob>   jobs,
               std::vector<NodeInfo> nodes,
               SchedulerPolicy*      policy,
               DriverConfig          config)
    : config_(std::move(config)),
      run_dir_(config_.output_dir + "/" + config_.tag),
      sim_(std::vector<SimJob>{}, std::move(nodes), config_.mode, run_dir_),
      policy_(policy)
{
    // Sort jobs by submit_time for deterministic JIT insertion
    jobs_sorted_ = std::move(jobs);
    std::stable_sort(jobs_sorted_.begin(), jobs_sorted_.end(),
                     [](const SimJob& a, const SimJob& b) {
                         return a.submit_time < b.submit_time;
                     });

    int start  = std::max(0, std::min(config_.start_job,
                                      static_cast<int>(jobs_sorted_.size())));
    int remain = static_cast<int>(jobs_sorted_.size()) - start;

    if (start < static_cast<int>(jobs_sorted_.size())) {
        SimTime submit_origin = jobs_sorted_[start].submit_time;
        for (auto& job : jobs_sorted_) {
            SimTime shifted = job.submit_time - submit_origin;
            job.submit_time = config_.submit_shift + (shifted * config_.submit_scale);
        }
    }

    submit_cursor_ = start;
    submit_limit_  = start + std::min(config_.max_jobs, remain);
    total_jobs_    = submit_limit_ - start;

    sim_.set_mode(config_.mode);
    sim_.set_backfilling(config_.backfill);

    if (!config_.maintenance.empty())
        sim_.add_maintenance_windows(config_.maintenance);

    if (policy_) {
        install_legacy_scheduling_callback(
            sim_,
            policy_,
            LegacyDispatchConfig{config_.backfill, config_.backfill_mode},
            &cycle_primary_started_,
            &cycle_backfill_started_
        );
    }
}

// ── run ───────────────────────────────────────────────────────────────────────

void Driver::run() {
    std::filesystem::create_directories(run_dir_);
    open_output_files();

    auto run_start = std::chrono::steady_clock::now();

    auto pending = next_submit_event();
    insert_pending_submits(std::nullopt, pending);

    while (true) {
        auto next_ev = sim_.peek();

        insert_pending_submits(next_ev, pending);

        if (!has_pending_ && !sim_.has_events()) break;

        next_ev = sim_.peek();
        if (!next_ev) break;

        if (next_ev->type == EventType::SchedulingCycle) {
            process_scheduling_cycle_event();

        } else {
            Event e = sim_.step();
            log_event(e);
            if (e.type == EventType::Submit ||
                e.type == EventType::End ||
                e.type == EventType::Resubmit) {
                char event_code = (e.type == EventType::End) ? 'E' : 'S';

                while (true) {
                    auto internal = sim_.peek();
                    if (!internal || internal->time != e.time || internal->type != EventType::SchedulingCycle)
                        break;
                    process_scheduling_cycle_event();
                }

                log_legacy_snapshot(event_code, e.time);

                while (true) {
                    auto info = sim_.peek();
                    if (!info || info->time != e.time ||
                        (info->type != EventType::Run && info->type != EventType::Backfill))
                        break;
                    log_event(sim_.step());
                }

                auto next_visible = sim_.peek();
                std::optional<SimTime> next_time;
                if (next_visible)
                    next_time = next_visible->time;
                if (pending) {
                    if (!next_time || pending->first < *next_time)
                        next_time = pending->first;
                }
                log_legacy_monitors(
                    e.time,
                    next_time
                );
            }
            if (e.type == EventType::End)
                print_progress();
        }
    }

    // Final progress line
    {
        double secs = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - run_start).count();
        print_progress();
        std::cout << " done (" << std::fixed << std::setprecision(2) << secs << "s)\n";
    }

    compute_stats();
    write_job_results();

    perf_file_.flush();
    event_file_.flush();
    legacy_sys_file_.flush();
}

// ── Stats ─────────────────────────────────────────────────────────────────────

int Driver::jobs_completed() const {
    return static_cast<int>(sim_.completed_jobs().size());
}

void Driver::compute_stats() {
    const auto& completed = sim_.completed_jobs();
    if (completed.empty()) return;

    double total_wait   = 0;
    SimTime earliest_sub = std::numeric_limits<SimTime>::max();

    for (int id : completed) {
        const SimJob& j = sim_.get_job(id);
        SimTime start = sim_.job_start_time(id);
        SimTime wait = (start >= 0) ? start - j.submit_time : 0;
        total_wait   += wait;
        earliest_sub  = std::min(earliest_sub, j.submit_time);
    }

    makespan_       = sim_.current_time() - earliest_sub;
    avg_wait_time_  = total_wait / completed.size();
}

// ── JIT submit insertion ──────────────────────────────────────────────────────

std::optional<std::pair<SimTime,int>> Driver::next_submit_event() {
    if (submit_cursor_ >= submit_limit_) {
        has_pending_ = false;
        return std::nullopt;
    }
    const SimJob& j = jobs_sorted_[submit_cursor_++];
    // Register job data in the Simulator before we create the Submit event;
    // the scheduling callback calls get_job() which needs it in jobs_ map.
    sim_.register_job(j);
    return std::make_pair(j.submit_time, j.id);
}

void Driver::insert_pending_submits(std::optional<Event>                  next_ev,
                                    std::optional<std::pair<SimTime,int>>& pending)
{
    if (!has_pending_ || !pending) return;

    if (!next_ev) {
        SimTime first_time = pending->first;
        while (pending && pending->first <= first_time) {
            sim_.create_submit_event(pending->first, pending->second);
            pending = next_submit_event();
        }
        return;
    }

    while (pending && pending->first <= next_ev->time) {
        sim_.create_submit_event(pending->first, pending->second);
        pending = next_submit_event();
    }
}

// ── Output ────────────────────────────────────────────────────────────────────

void Driver::open_output_files() {
    perf_file_.open(run_dir_ + "/performance.csv", std::ios::trunc);
    perf_file_ << "cycle,sim_time,jobs_finished,queue_len,queue_size,utilization,"
                  "jobs_running,cycle_ms,selected_policy,jobs_run\n";

    event_file_.open(run_dir_ + "/events.csv", std::ios::trunc);
    event_file_ << "sim_time,event,id\n";

    legacy_sys_file_.open(run_dir_ + "/legacy_sys.csv", std::ios::trunc);
    legacy_sys_file_ << "time,event_code,utilization,wait_num,wait_size\n";
}

void Driver::log_event(const Event& e) {
    if (!event_file_.is_open()) return;
    event_file_ << std::setprecision(17) << e.time << "," << e.type_str() << ",";
    if (e.type == EventType::SchedulingCycle)
        event_file_ << cycle_number_;
    else
        event_file_ << e.job_id;
    event_file_ << "\n";
}

void Driver::log_legacy_snapshot(char event_code, SimTime sim_time) {
    if (!legacy_sys_file_.is_open()) return;

    int running_procs = 0;
    for (int id : sim_.running_jobs())
        running_procs += sim_.get_job(id).requested.procs;

    int wait_num = static_cast<int>(sim_.get_job_queue().size());
    int wait_size = 0;
    for (int id : sim_.get_job_queue())
        wait_size += sim_.get_job(id).requested.procs;

    double util = sim_.total_procs() > 0
        ? static_cast<double>(running_procs) / sim_.total_procs()
        : 0.0;

    legacy_sys_file_ << std::setprecision(17) << sim_time << ","
                     << event_code << ","
                     << std::setprecision(17) << util << ","
                     << wait_num << ","
                     << wait_size << "\n";
}

void Driver::log_legacy_monitors(SimTime start_time, std::optional<SimTime> next_time) {
    if (config_.monitor_interval <= 0 || !next_time || *next_time <= start_time)
        return;

    SimTime mark = std::floor(start_time / config_.monitor_interval) * config_.monitor_interval;
    while (mark < *next_time) {
        if (mark >= start_time)
            log_legacy_snapshot('Q', mark);
        mark += config_.monitor_interval;
    }
}

void Driver::process_scheduling_cycle_event() {
    int free_before    = sim_.available_procs();
    int q_len          = static_cast<int>(sim_.get_job_queue().size());
    int q_size         = 0;
    for (int id : sim_.get_job_queue())
        q_size += sim_.get_job(id).requested.procs;
    int running_before = static_cast<int>(sim_.running_jobs().size());
    int finished_before = static_cast<int>(sim_.completed_jobs().size());
    int total_p        = sim_.total_procs();
    double util        = total_p > 0
        ? static_cast<double>(total_p - free_before) / total_p
        : 0.0;
    SimTime sim_time   = sim_.current_time();
    auto t0            = std::chrono::steady_clock::now();

    Event e = sim_.step();
    log_event(e);

    double ms = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - t0).count();

    int q_after = static_cast<int>(sim_.get_job_queue().size());
    int jobs_scheduled = q_len - q_after;
    std::string selected_policy;
    std::string pname = policy_ ? policy_->name() : "unknown";
    std::transform(pname.begin(), pname.end(), pname.begin(), ::toupper);
    if (q_len == 0) {
        selected_policy = "NONE";
    } else if (jobs_scheduled == 0) {
        selected_policy = "DRAIN";
    } else if (cycle_primary_started_ > 0 && cycle_backfill_started_ > 0) {
        selected_policy = pname + "+BACKFILL";
    } else if (cycle_primary_started_ == 0) {
        selected_policy = "BACKFILL";
    } else {
        selected_policy = pname;
    }
    log_cycle(++cycle_number_, sim_time,
              finished_before, q_len, q_size, util,
              running_before, ms,
              selected_policy, jobs_scheduled);
}

void Driver::log_cycle(int cycle, SimTime sim_time,
                        int jobs_finished, int q_len, int q_size, double util,
                        int jobs_running, double ms,
                        const std::string& selected_policy,
                        int jobs_run) {
    if (!perf_file_.is_open()) return;
    perf_file_ << cycle << ","
               << std::setprecision(17) << sim_time << ","
               << jobs_finished << ","
               << q_len << ","
               << q_size << ","
               << std::fixed << std::setprecision(4) << util << ","
               << jobs_running << ","
               << ms << ","
               << selected_policy << ","
               << jobs_run << "\n";
}

void write_job_results_csv(const Simulator& sim, const std::string& path) {
    std::ofstream jobs_file(path, std::ios::trunc);
    jobs_file << "job_id,req_proc,req_time,run,wait,submit,start,end\n";

    for (int id : sim.completed_jobs()) {
        const SimJob& job = sim.get_job(id);
        SimTime start = sim.job_start_time(id);
        SimTime end = sim.job_end_time(id);
        SimTime run = (start >= 0 && end >= start)
            ? (end - start)
            : (job.run_time > 0 ? job.run_time : job.walltime);
        SimTime wait = start >= 0 ? start - job.submit_time : 0;

        jobs_file << id << ","
                  << job.requested.procs << ","
                  << std::setprecision(17) << job.walltime << ","
                  << run << ","
                  << wait << ","
                  << job.submit_time << ","
                  << start << ","
                  << end << "\n";
    }
}

void Driver::write_job_results() {
    write_job_results_csv(sim_, run_dir_ + "/jobs.csv");
}

void Driver::print_progress() {
    int done  = jobs_completed();
    int pct   = total_jobs_ > 0 ? (done * 100 / total_jobs_) : 0;
    int filled = 30 * done / std::max(total_jobs_, 1);

    std::cout << "\r" << std::left << std::setw(14) << config_.tag << " [";
    for (int i = 0; i < 30; ++i)
        std::cout << (i < filled ? '#' : '.');
    std::cout << "] " << std::right << std::setw(3) << pct
              << "% (" << done << "/" << total_jobs_ << ")" << std::flush;
}
