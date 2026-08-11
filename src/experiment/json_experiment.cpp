#include "json_experiment.h"
#include "../io/swf_reader.h"
#include "../io/maintenance_reader.h"
#include "../policies/policy_factory.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <iostream>
#include <iomanip>
#include <fstream>
#include <limits>

using json = nlohmann::json;

// ── Helpers ───────────────────────────────────────────────────────────────────
static std::vector<NodeInfo> make_nodes_for_procs(int total_procs) {
    return { NodeInfo(0, "cluster", Resources{total_procs, 0, 0}) };
}

static int infer_total_procs_from_jobs(const std::vector<SimJob>& jobs) {
    int max_seen = 1;
    for (const auto& job : jobs)
        max_seen = std::max(max_seen, job.requested.procs);
    return max_seen;
}

// ── JsonExperiment ────────────────────────────────────────────────────────────

JsonExperiment::JsonExperiment(const std::string& json_path)
    : Experiment("JSON experiment: " + json_path),
      json_path_(json_path)
{
    // Read output_dir eagerly so it's available before run()
    std::ifstream f(json_path_);
    if (f.is_open()) {
        auto cfg = json::parse(f);
        if (cfg.contains("output_dir"))
            output_dir_ = cfg["output_dir"].get<std::string>();
    }
}

void JsonExperiment::input_initialization() {
    std::ifstream f(json_path_);
    if (!f.is_open())
        throw std::runtime_error("Cannot open config: " + json_path_);
    auto cfg = json::parse(f);

    std::string swf_path = cfg.at("swf_path").get<std::string>();

    if (cfg.contains("output_dir"))
        output_dir_ = cfg["output_dir"].get<std::string>();
    if (cfg.contains("max_submits"))
        max_submits_ = cfg["max_submits"].get<int>();
    if (cfg.contains("start_job_index"))
        start_job_index_ = cfg["start_job_index"].get<int>();
    if (cfg.contains("legacy_start_time"))
        legacy_start_time_ = cfg["legacy_start_time"].get<SimTime>();
    if (cfg.contains("legacy_cluster_fraction"))
        legacy_cluster_fraction_ = cfg["legacy_cluster_fraction"].get<double>();
    if (cfg.contains("legacy_monitor_interval"))
        legacy_monitor_interval_ = cfg["legacy_monitor_interval"].get<int>();
    if (cfg.contains("total_procs"))
        total_procs_ = cfg["total_procs"].get<int>();
    else if (cfg.contains("node_count") && cfg.contains("procs_per_node"))
        total_procs_ = cfg["node_count"].get<int>() * cfg["procs_per_node"].get<int>();
    if (cfg.contains("mode"))
        mode_ = parse_sim_mode(cfg["mode"].get<std::string>());
    if (cfg.contains("size_bins"))
        for (const auto& v : cfg["size_bins"])
            size_bins_.push_back(v.get<double>());
    if (cfg.contains("walltime_bins"))
        for (const auto& v : cfg["walltime_bins"])
            walltime_bins_.push_back(v.get<double>());

    SwfReader reader(swf_path);
    jobs_        = reader.read();
    if (total_procs_ <= 0)
        total_procs_ = reader.max_procs();
    if (total_procs_ <= 0)
        total_procs_ = infer_total_procs_from_jobs(jobs_);

    if (cfg.contains("maintenance_csv")) {
        std::string mcsv     = cfg["maintenance_csv"].get<std::string>();
        double notice_hours  = cfg.value("maintenance_notice_hours", 48.0);
        MaintenanceReader mr(mcsv, notice_hours);
        maintenance_ = mr.read();
        log("loaded " + std::to_string(maintenance_.size())
            + " maintenance windows from " + mcsv);
    }

    log("swf: " + swf_path + "  jobs=" + std::to_string(jobs_.size())
        + "  total_procs=" + std::to_string(total_procs_));
}

void JsonExperiment::driver_initialization() {
    std::ifstream f(json_path_);
    auto cfg = json::parse(f);

    int max_sub = std::min(max_submits_, static_cast<int>(jobs_.size()));

    for (const auto& d : cfg.at("drivers")) {
        std::string type    = d.at("type").get<std::string>();
        std::transform(type.begin(), type.end(), type.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        std::string tag     = d.value("tag", type);
        bool backfill       = d.value("backfilling", false);
        int backfill_mode   = d.value("legacy_backfill_mode", backfill ? 1 : 0);
        int window          = d.value("window_size", std::numeric_limits<int>::max());
        if (window <= 0)
            window = 1;

        DriverConfig dc;
        dc.tag         = tag;
        dc.output_dir  = output_dir_;
        dc.max_jobs    = max_sub;
        dc.start_job   = start_job_index_;
        dc.mode        = mode_;
        dc.backfill    = backfill;
        dc.backfill_mode = backfill_mode;
        dc.submit_scale = legacy_cluster_fraction_;
        dc.submit_shift = legacy_start_time_;
        dc.monitor_interval = legacy_monitor_interval_;
        dc.maintenance = maintenance_;

        auto nodes = make_nodes_for_procs(total_procs_);

        std::unique_ptr<SchedulerPolicy> policy;
        policy = make_heuristic_policy(type, window);
        if (!policy) {
            std::cerr << "Warning: unknown driver type '" << type << "', skipping\n";
            continue;
        }

        policies_.push_back(std::move(policy));
        auto driver = std::make_unique<Driver>(jobs_, nodes, policies_.back().get(), dc);
        log("created driver: " + tag + " (type=" + type + ")");
        register_driver(std::move(driver));
    }
}

void JsonExperiment::output_analytics() {
    write_metrics(total_procs_, jobs_);

    std::cout << "\n=== Experiment Results ===\n";
    std::cout << std::left;
    std::cout << "  " << std::setw(20) << "Driver"
              << std::setw(15) << "Completed"
              << std::setw(15) << "Makespan(s)"
              << std::setw(12) << "AvgWait(s)" << "\n";
    std::cout << "  " << std::string(62, '-') << "\n";
    for (const auto& dp : drivers()) {
        std::cout << "  " << std::setw(20) << dp->tag()
                  << std::setw(15) << dp->jobs_completed()
                  << std::setw(15) << dp->makespan()
                  << std::setw(12) << std::fixed << std::setprecision(1)
                  << dp->avg_wait_time() << "\n";
    }
    std::cout << "\nSummary written to " << output_dir_ << "/summary.csv\n";
}
