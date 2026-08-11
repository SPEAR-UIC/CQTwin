#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include <nlohmann/json.hpp>

#include "experiment/json_experiment.h"
#include "experiment/scenario_preview.h"
#include "adapters/env/online_env.h"
#include "adapters/env/ndjson_server.h"
#include "adapters/simulation/driver.h"

int main(int argc, char* argv[]) {
    auto print_usage = []() {
        std::cerr << "Usage:\n"
                  << "  cqtwin <config.json>\n"
                  << "  cqtwin run <config.json>\n"
                  << "  cqtwin preview <config.json>\n"
                  << "  cqtwin online-serve <online_env.json> [--host 127.0.0.1] [--port 0]\n"
                  << "  cqtwin online-run <online_run.json>   (CQTwin headless online advisory run)\n";
    };

    if (argc < 2) {
        print_usage();
        return 1;
    }

    std::string command = "run";
    std::string config_path;

    std::string arg1 = argv[1];
    if (arg1 == "run" || arg1 == "preview" || arg1 == "online-serve" || arg1 == "online-run") {
        if (argc < 3) { print_usage(); return 1; }
        command = arg1;
        config_path = argv[2];
    } else if (argc == 2) {
        config_path = argv[1];
    } else {
        print_usage();
        return 1;
    }

    try {
        if (command == "preview") {
            ScenarioPreview preview(config_path);
            preview.run();
        } else if (command == "online-serve") {
            std::string host = "127.0.0.1";
            int port = 0;  // 0 => OS-assigned ephemeral port
            for (int i = 3; i + 1 < argc; i += 2) {
                std::string flag = argv[i];
                if (flag == "--host")      host = argv[i + 1];
                else if (flag == "--port") port = std::stoi(argv[i + 1]);
            }
            OnlineEnvConfig cfg = OnlineEnvConfig::from_file(config_path);
            OnlineEnv env(std::move(cfg));
            return run_ndjson_server(env, host, port);
        } else if (command == "online-run") {
            // CQTwin headless online-advisory run: drive OnlineEnv (trace mode)
            // with a CONSTANT committed policy, logging per-cycle advisory
            // projections for the pool, and write the committed run's jobs.csv.
            // Because the fixed-action committed schedule is provably identical to
            // an offline Driver run of that policy, jobs.csv is byte-identical to
            // the offline path (write_job_results_csv is shared) — the dashboard
            // preprocesses it with no new code. Closes the no-non-socket-advisory
            // driver gap noted in PAPER_DATA §4.
            std::ifstream f(config_path);
            if (!f.is_open())
                throw std::runtime_error("online-run: cannot open config: " + config_path);
            nlohmann::json j = nlohmann::json::parse(f);

            std::string committed = j.at("committed_policy").get<std::string>();
            std::transform(committed.begin(), committed.end(), committed.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            std::string output_dir = j.at("output_dir").get<std::string>();
            std::string tag = j.value("tag", std::string("online_advisory"));
            std::string run_dir = output_dir + "/" + tag;
            std::filesystem::create_directories(run_dir);

            OnlineEnvConfig cfg = OnlineEnvConfig::from_json(j);
            cfg.include_advisory = true;                       // advisory is the point of this run
            if (cfg.advisory_csv.empty())
                cfg.advisory_csv = run_dir + "/advisory.csv";

            OnlineEnv env(std::move(cfg));
            int action = env.policy_index(committed);
            if (action < 0)
                throw std::runtime_error("online-run: committed_policy '" + committed +
                                         "' must be one of the pool policies");

            // Best-effort progress markers from the trace: job count (for the
            // "jobs c/total" readout) and the last arrival time (drives a % that
            // climbs with sim_time, so it keeps moving through congested stretches
            // where jobs queue without completing). Long runs otherwise look frozen.
            long total_jobs = 0;
            double max_submit = 0.0;
            {
                std::ifstream tf(j.value("swf_path", std::string()));
                std::string ln;
                while (std::getline(tf, ln)) {
                    std::size_t p = ln.find_first_not_of(" \t");
                    if (p == std::string::npos || ln[p] == ';') continue;
                    ++total_jobs;
                    std::istringstream is(ln);           // SWF field 1 = submit time
                    long id; double submit;
                    if (is >> id >> submit && submit > max_submit) max_submit = submit;
                }
            }

            env.reset();
            long cycle = 0;
            auto t_last = std::chrono::steady_clock::now();
            while (!env.done()) {
                env.step(action);                             // fixed committed policy every cycle
                ++cycle;
                // Emit progress on a wall-clock cadence (~every 2s), not per cycle:
                // congested periods run few cycles/sec, so time-based keeps the bar
                // moving even when the sim slows down.
                auto now = std::chrono::steady_clock::now();
                if (std::chrono::duration<double>(now - t_last).count() >= 2.0) {
                    t_last = now;
                    long done = static_cast<long>(env.simulator().completed_jobs().size());
                    double t = static_cast<double>(env.simulator().current_time());
                    // Blend two monotonic signals: completions (responsive early) and
                    // sim-time (keeps creeping through congestion where jobs queue but
                    // don't finish). max() of the two never stalls mid-run.
                    int pct_done = total_jobs > 0 ? static_cast<int>(done * 100 / total_jobs) : 0;
                    int pct_time = max_submit > 0.0 ? static_cast<int>(100.0 * t / max_submit) : 0;
                    int pct = std::min(99, std::max(pct_done, pct_time));
                    std::cout << "progress: " << pct << "% | cycle " << cycle
                              << " | sim_time " << static_cast<long long>(t)
                              << " | jobs " << done << "/" << total_jobs << std::endl;
                }
            }

            write_job_results_csv(env.simulator(), run_dir + "/jobs.csv");
            std::cout << "progress: 100% | cycle " << cycle << " | done\n";
            std::cout << "online-run complete: " << run_dir
                      << " (jobs.csv, advisory.csv)\n";
        } else {
            JsonExperiment exp(config_path);
            exp.run();
        }
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
