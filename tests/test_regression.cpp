#include <gtest/gtest.h>
#include "adapters/simulation/driver.h"
#include "policies/fifo.h"
#include "policies/sjf.h"
#include <fstream>
#include <sstream>
#include <filesystem>
#include <chrono>

// ── Helpers ───────────────────────────────────────────────────────────────────

static SimJob make_job(int id, long submit, long walltime, long run_time, int procs) {
    return SimJob(id, submit, walltime, Resources{procs, 0, 0}, run_time);
}

static std::vector<NodeInfo> make_nodes(int n, int procs_each) {
    std::vector<NodeInfo> nodes;
    for (int i = 0; i < n; ++i)
        nodes.emplace_back(i, "n" + std::to_string(i), Resources{procs_each, 0, 0});
    return nodes;
}

static DriverConfig basic_config(const std::string& tag, const std::string& out) {
    DriverConfig dc;
    dc.tag        = tag;
    dc.output_dir = out;
    return dc;
}

// ── Test 26: SJF produces lower avg_wait_time than FCFS on a contended cluster ──

TEST(RegressionTest, SjfLowerAvgWaitThanFcfsOnContentedCluster) {
    // 5 jobs all at t=0 with widely varying walltimes on a single-slot cluster.
    // FCFS runs them in original order; SJF picks shortest first.
    // Shorter jobs finish sooner → lower cumulative wait for SJF.
    std::vector<SimJob> jobs = {
        make_job(1, 0, 500, 500, 4),
        make_job(2, 0, 400, 400, 4),
        make_job(3, 0, 300, 300, 4),
        make_job(4, 0, 200, 200, 4),
        make_job(5, 0, 100, 100, 4),
    };
    // Single node with 4 procs so only one 4-proc job fits at a time
    auto nodes = make_nodes(1, 4);

    FifoPolicy fcfs;
    Driver fcfs_d(jobs, nodes, &fcfs, basic_config("fcfs_reg", "/tmp/reg_test_sjf"));
    fcfs_d.run();

    SjfPolicy sjf;
    Driver sjf_d(jobs, nodes, &sjf, basic_config("sjf_reg", "/tmp/reg_test_sjf"));
    sjf_d.run();

    EXPECT_EQ(fcfs_d.jobs_completed(), 5);
    EXPECT_EQ(sjf_d.jobs_completed(), 5);
    EXPECT_LT(sjf_d.avg_wait_time(), fcfs_d.avg_wait_time());
}

// ── Test 27: events.csv sim_time column is non-decreasing ─────────────────────

TEST(RegressionTest, EventsCsvIsChronologicallyOrdered) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0,   100, 80, 4),
        make_job(2, 50,  150, 90, 4),
        make_job(3, 100, 200, 70, 4),
    };
    const std::string out = "/tmp/reg_test_events";
    std::filesystem::remove_all(out);
    Driver d(jobs, make_nodes(2, 4), &p, basic_config("chrono", out));
    d.run();

    std::ifstream f(out + "/chrono/events.csv");
    ASSERT_TRUE(f.is_open());

    std::string header;
    std::getline(f, header);

    // Find sim_time column index
    int time_col = -1;
    { std::istringstream hss(header); std::string col;
      for (int i = 0; std::getline(hss, col, ','); ++i)
          if (col == "sim_time") { time_col = i; break; } }
    ASSERT_GE(time_col, 0);

    long prev_time = -1;
    std::string row;
    while (std::getline(f, row)) {
        std::istringstream rss(row);
        std::string val;
        for (int i = 0; std::getline(rss, val, ','); ++i) {
            if (i == time_col) {
                long t = std::stol(val);
                EXPECT_GE(t, prev_time) << "Time decreased at row: " << row;
                prev_time = t;
            }
        }
    }
}
