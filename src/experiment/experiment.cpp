#include "experiment.h"
#include <iostream>
#include <iomanip>
#include <chrono>
#include <thread>
#include <unordered_map>
#include <numeric>
#include <limits>

Experiment::Experiment(const std::string& description)
    : output_dir_("results"),
      description_(description)
{}

void Experiment::run() {
    logging_phase_ = "input";
    input_initialization();

    std::filesystem::create_directories(output_dir_);
    log_file_path_ = output_dir_ + "/experiment.log";
    { std::ofstream f(log_file_path_, std::ios::trunc); }

    log("input_initialization complete");

    logging_phase_ = "drivers";
    log("driver_initialization started");
    driver_initialization();
    log("registered " + std::to_string(drivers_.size()) + " drivers");

    logging_phase_ = "run";
    if (parallel_)
        run_parallel();
    else
        run_serial();

    logging_phase_ = "output";
    log("output_analytics started");
    output_analytics();
    log("experiment complete");
}

void Experiment::register_driver(std::unique_ptr<Driver> driver) {
    log("registered driver: " + driver->tag());
    drivers_.push_back(std::move(driver));
}

void Experiment::log(const std::string& msg) {
    if (log_file_path_.empty()) return;
    std::ofstream f(log_file_path_, std::ios::app);
    f << "[" << logging_phase_ << "]\t" << msg << "\n";
}

void Experiment::run_serial() {
    for (auto& d : drivers_) {
        auto t0 = std::chrono::steady_clock::now();
        log("running driver: " + d->tag());
        std::cout << "\nRunning " << d->tag() << " ...\n";
        d->run();
        double secs = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - t0).count();
        log("driver " + d->tag() + " finished in " + std::to_string(secs) + "s");
    }
}

void Experiment::run_parallel() {
    std::vector<std::thread> threads;
    threads.reserve(drivers_.size());
    for (auto& d : drivers_) {
        log("launching driver thread: " + d->tag());
        threads.emplace_back([&d]() { d->run(); });
    }
    for (auto& t : threads) t.join();
    log("all driver threads finished");
}

void Experiment::write_metrics(int total_procs, const std::vector<SimJob>& jobs) {
    // Build a lookup for walltime by job id
    std::unordered_map<int,SimTime> walltime_by_id;
    for (const auto& j : jobs) walltime_by_id[j.id] = j.walltime;

    std::ofstream csv(output_dir_ + "/summary.csv", std::ios::trunc);
    csv << "tag,jobs_completed,makespan_s,"
        << "wait_avg,wait_min,wait_p25,wait_p50,wait_p75,wait_p80,wait_p90,wait_p95,wait_p99,wait_max,"
        << "bsld_avg,bsld_min,bsld_p25,bsld_p50,bsld_p75,bsld_p80,bsld_p90,bsld_p95,bsld_p99,bsld_max,"
        << "total_util\n";

    for (const auto& dp : drivers_) {
        const auto& sim       = dp->simulator();
        const auto& completed = sim.completed_jobs();

        std::vector<double> waits, bslds;
        SimTime earliest_sub = std::numeric_limits<SimTime>::max();
        double used_core_hours = 0.0;

        for (int id : completed) {
            const SimJob& j = sim.get_job(id);
            SimTime start = sim.job_start_time(id);
            SimTime wait = start >= 0 ? start - j.submit_time : 0;
            waits.push_back(wait);

            SimTime wt = j.walltime > 0 ? j.walltime : 1;
            double bsld = static_cast<double>(wait + wt) / static_cast<double>(wt);
            bslds.push_back(bsld);

            earliest_sub = std::min(earliest_sub, j.submit_time);
            used_core_hours += static_cast<double>(j.run_time) * j.requested.procs / 3600.0;
        }

        SimTime makespan_s = completed.empty() ? 0 :
            sim.current_time() - earliest_sub;

        double total_util = 0.0;
        if (makespan_s > 0 && total_procs > 0) {
            double capacity = static_cast<double>(makespan_s) * total_procs / 3600.0;
            total_util = used_core_hours / capacity;
        }

        auto ws = compute_percentile_stats(waits);
        auto bs = compute_percentile_stats(bslds);

        auto w = [&](double v){ csv << std::fixed << std::setprecision(2) << v << ","; };
        csv << dp->tag() << ","
            << completed.size() << ","
            << makespan_s << ",";
        w(ws.avg); w(ws.min); w(ws.p25); w(ws.p50); w(ws.p75); w(ws.p80);
        w(ws.p90); w(ws.p95); w(ws.p99); w(ws.max);
        w(bs.avg); w(bs.min); w(bs.p25); w(bs.p50); w(bs.p75); w(bs.p80);
        w(bs.p90); w(bs.p95); w(bs.p99); w(bs.max);
        csv << std::fixed << std::setprecision(4) << total_util << "\n";
    }
    log("wrote " + output_dir_ + "/summary.csv");
}
