#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include "experiment/experiment.h"
#include "experiment/json_experiment.h"
#include "adapters/simulation/driver.h"
#include "policies/fifo.h"
#include "policies/sjf.h"
#include "policies/wfp.h"
#include <fstream>
#include <sstream>
#include <filesystem>

using json = nlohmann::json;

// ── Helpers ───────────────────────────────────────────────────────────────────

static SimJob make_job(int id, long submit, long walltime, long run_time, int procs) {
    return SimJob(id, submit, walltime, Resources{procs, 0, 0}, run_time);
}

static std::vector<NodeInfo> make_nodes(int n, int procs_each) {
    std::vector<NodeInfo> v;
    for (int i = 0; i < n; ++i)
        v.emplace_back(i, "n" + std::to_string(i), Resources{procs_each, 0, 0});
    return v;
}

// ── Concrete Experiment for testing ──────────────────────────────────────────

class TestExperiment : public Experiment {
public:
    explicit TestExperiment(const std::string& out_dir)
        : Experiment("test experiment"),
          policy_(std::make_unique<FifoPolicy>())
    {
        output_dir_ = out_dir;
    }

    void add_driver_with_jobs(std::vector<SimJob> jobs, const std::string& tag) {
        jobs_       = jobs;
        auto nodes  = make_nodes(2, 8);
        DriverConfig dc;
        dc.tag        = tag;
        dc.output_dir = output_dir_;
        register_driver(std::make_unique<Driver>(jobs, nodes, policy_.get(), dc));
    }

    std::vector<SimJob>              jobs_;
    std::unique_ptr<SchedulerPolicy> policy_;

protected:
    void driver_initialization() override {}
    void output_analytics() override {
        write_metrics(16, jobs_);
    }
};

// ── Experiment::run sequentially ──────────────────────────────────────────────

TEST(ExperimentTest, RunWithNoDriversDoesNotCrash) {
    TestExperiment exp("/tmp/exp_test_empty");
    EXPECT_NO_THROW(exp.run());
}

TEST(ExperimentTest, RunCompletesAllRegisteredDrivers) {
    TestExperiment exp("/tmp/exp_test_multi");
    std::vector<SimJob> jobs = {
        make_job(1, 0,  100, 80, 4),
        make_job(2, 10, 200, 90, 4),
    };
    exp.add_driver_with_jobs(jobs, "driver_a");
    exp.run();
    ASSERT_EQ(exp.drivers().size(), 1u);
    EXPECT_EQ(exp.drivers()[0]->jobs_completed(), 2);
}

TEST(ExperimentTest, WritesLogFile) {
    const std::string out = "/tmp/exp_test_log";
    std::filesystem::remove_all(out);
    TestExperiment exp(out);
    exp.add_driver_with_jobs({ make_job(1, 0, 100, 80, 4) }, "t1");
    exp.run();
    EXPECT_TRUE(std::filesystem::exists(out + "/experiment.log"));
}

TEST(ExperimentTest, WriteMeticsProducesSummaryCsv) {
    const std::string out = "/tmp/exp_test_metrics";
    std::filesystem::remove_all(out);
    TestExperiment exp(out);
    exp.add_driver_with_jobs({
        make_job(1, 0,  100, 80, 4),
        make_job(2, 10, 100, 80, 4),
    }, "fifo");
    exp.run();
    EXPECT_TRUE(std::filesystem::exists(out + "/summary.csv"));
}

TEST(ExperimentTest, SummaryCsvHasHeader) {
    const std::string out = "/tmp/exp_test_csvhdr";
    std::filesystem::remove_all(out);
    TestExperiment exp(out);
    exp.add_driver_with_jobs({ make_job(1, 0, 100, 80, 4) }, "x");
    exp.run();

    std::ifstream f(out + "/summary.csv");
    ASSERT_TRUE(f.is_open());
    std::string line;
    ASSERT_TRUE(std::getline(f, line));
    EXPECT_NE(line.find("tag"),           std::string::npos);
    EXPECT_NE(line.find("wait_avg"),      std::string::npos);
    EXPECT_NE(line.find("bsld_avg"),      std::string::npos);
    EXPECT_NE(line.find("total_util"),    std::string::npos);
    EXPECT_NE(line.find("makespan_s"),    std::string::npos);
}

TEST(ExperimentTest, SummaryCsvHasOneDataRow) {
    const std::string out = "/tmp/exp_test_csvrow";
    std::filesystem::remove_all(out);
    TestExperiment exp(out);
    exp.add_driver_with_jobs({ make_job(1, 0, 100, 80, 4) }, "mydriver");
    exp.run();

    std::ifstream f(out + "/summary.csv");
    std::string header, row;
    std::getline(f, header);
    ASSERT_TRUE(std::getline(f, row));
    EXPECT_NE(row.find("mydriver"), std::string::npos);
}

TEST(ExperimentTest, SummaryWaitAverageReflectsQueuedContention) {
    const std::string out = "/tmp/exp_test_waitavg";
    std::filesystem::remove_all(out);

    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 100, 4),
        make_job(2, 0, 100, 100, 4),
    };

    TestExperiment exp(out);
    exp.jobs_ = jobs;

    FifoPolicy p;
    DriverConfig dc;
    dc.tag = "fifo";
    dc.output_dir = out;
    exp.register_driver(std::make_unique<Driver>(jobs, make_nodes(1, 4), &p, dc));
    exp.run();

    std::ifstream f(out + "/summary.csv");
    ASSERT_TRUE(f.is_open());

    std::string header, row;
    ASSERT_TRUE(std::getline(f, header));
    ASSERT_TRUE(std::getline(f, row));

    int wait_avg_col = -1;
    { std::istringstream hss(header); std::string col;
      for (int i = 0; std::getline(hss, col, ','); ++i)
          if (col == "wait_avg") { wait_avg_col = i; break; } }
    ASSERT_GE(wait_avg_col, 0);

    { std::istringstream rss(row); std::string val;
      for (int i = 0; std::getline(rss, val, ','); ++i) {
          if (i == wait_avg_col) {
              EXPECT_DOUBLE_EQ(std::stod(val), 50.0);
              break;
          }
      } }
}

// ── Performance CSV columns ───────────────────────────────────────────────────

TEST(ExperimentTest, PerfCsvHasNewColumns) {
    const std::string out = "/tmp/exp_test_perfcsv";
    std::filesystem::remove_all(out);

    FifoPolicy p;
    DriverConfig dc;
    dc.tag        = "chk";
    dc.output_dir = out;
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    Driver d(jobs, make_nodes(1, 8), &p, dc);
    d.run();

    std::ifstream f(out + "/chk/performance.csv");
    ASSERT_TRUE(f.is_open());
    std::string header;
    ASSERT_TRUE(std::getline(f, header));
    EXPECT_NE(header.find("jobs_running"),  std::string::npos);
    EXPECT_NE(header.find("jobs_finished"), std::string::npos);
    EXPECT_NE(header.find("util"),          std::string::npos);
    EXPECT_NE(header.find("selected_policy"), std::string::npos);
    // Old columns still present
    EXPECT_NE(header.find("cycle"),         std::string::npos);
    EXPECT_NE(header.find("queue_len"),     std::string::npos);
    EXPECT_NE(header.find("jobs_run"),      std::string::npos);
}

TEST(ExperimentTest, PerfCsvUtilBetweenZeroAndOne) {
    const std::string out = "/tmp/exp_test_util";
    std::filesystem::remove_all(out);

    FifoPolicy p;
    DriverConfig dc;
    dc.tag = "util"; dc.output_dir = out;
    std::vector<SimJob> jobs = {
        make_job(1, 0, 200, 100, 4),
        make_job(2, 0, 200, 100, 4),
    };
    Driver d(jobs, make_nodes(2, 4), &p, dc);
    d.run();

    std::ifstream f(out + "/util/performance.csv");
    ASSERT_TRUE(f.is_open());
    std::string header;
    std::getline(f, header);

    // Find utilization column index
    int util_col = -1;
    std::istringstream hss(header);
    std::string col;
    for (int i = 0; std::getline(hss, col, ','); ++i)
        if (col == "utilization") { util_col = i; break; }
    ASSERT_GE(util_col, 0);

    std::string row;
    while (std::getline(f, row)) {
        std::istringstream rss(row);
        std::string val;
        for (int i = 0; std::getline(rss, val, ','); ++i) {
            if (i == util_col) {
                double u = std::stod(val);
                EXPECT_GE(u, 0.0);
                EXPECT_LE(u, 1.0);
            }
        }
    }
}

// ── JsonExperiment ────────────────────────────────────────────────────────────

class JsonExperimentFixture : public ::testing::Test {
protected:
    std::string json_path_;
    std::string out_dir_;

    void SetUp() override {
        out_dir_  = "/tmp/json_exp_test_" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count() % 1000000);
        json_path_ = out_dir_ + "_config.json";
        std::filesystem::create_directories(out_dir_);
    }
    void TearDown() override {
        std::filesystem::remove_all(out_dir_);
        std::filesystem::remove(json_path_);
    }

    // Write a tiny synthetic SWF file — 3 jobs
    std::string write_swf() {
        std::string path = out_dir_ + "/test.swf";
        std::ofstream f(path);
        // SWF format: id sub wait run alloc avgcpu mem reqproc wall reqmem stat proj alloc exec q part prev think
        f << "; MaxProcs: 16\n";
        f << "1 0 -1 80 4 -1 -1 4 100 -1 1 -1 -1 -1 -1 -1 -1 -1\n";
        f << "2 10 -1 90 4 -1 -1 4 200 -1 1 -1 -1 -1 -1 -1 -1 -1\n";
        f << "3 20 -1 70 4 -1 -1 4 150 -1 1 -1 -1 -1 -1 -1 -1 -1\n";
        return path;
    }

    void write_json(const std::string& swf, const nlohmann::json& extra = {}) {
        nlohmann::json cfg;
        cfg["swf_path"]   = swf;
        cfg["output_dir"] = out_dir_;
        cfg["max_submits"] = 100;
        cfg["drivers"] = nlohmann::json::array();

        for (auto& [k, v] : extra.items()) cfg[k] = v;

        std::ofstream f(json_path_);
        f << cfg.dump(2);
    }
};

TEST_F(JsonExperimentFixture, MissingConfigThrows) {
    EXPECT_THROW(JsonExperiment("/nonexistent.json").run(), std::exception);
}

TEST_F(JsonExperimentFixture, EmptyDriversListRunsCleanly) {
    auto swf = write_swf();
    write_json(swf);
    EXPECT_NO_THROW(JsonExperiment(json_path_).run());
}

TEST_F(JsonExperimentFixture, FifoDriverRunsToCompletion) {
    auto swf = write_swf();
    json cfg;
    cfg["drivers"] = json::array({
        json{{"type", "fcfs"}, {"tag", "fifo_run"}}
    });
    write_json(swf, cfg);

    JsonExperiment exp(json_path_);
    EXPECT_NO_THROW(exp.run());
    ASSERT_EQ(exp.drivers().size(), 1u);
    EXPECT_EQ(exp.drivers()[0]->jobs_completed(), 3);
}

TEST_F(JsonExperimentFixture, MultipleHeuristicDriversRun) {
    auto swf = write_swf();
    json cfg;
    cfg["drivers"] = json::array({
        json{{"type", "fcfs"},  {"tag", "fcfs"}},
        json{{"type", "sjf"},   {"tag", "sjf"},  {"window_size", 10}},
        json{{"type", "wfp"},   {"tag", "wfp"},  {"window_size", 10}},
    });
    write_json(swf, cfg);

    JsonExperiment exp(json_path_);
    exp.run();
    ASSERT_EQ(exp.drivers().size(), 3u);
    for (const auto& d : exp.drivers())
        EXPECT_EQ(d->jobs_completed(), 3) << "Driver " << d->tag() << " incomplete";
}

TEST_F(JsonExperimentFixture, UnknownDriverTypeSkipped) {
    auto swf = write_swf();
    json cfg;
    cfg["drivers"] = json::array({
        json{{"type", "nonexistent_policy"}, {"tag", "bad"}},
        json{{"type", "fcfs"}, {"tag", "good"}},
    });
    write_json(swf, cfg);

    JsonExperiment exp(json_path_);
    exp.run();
    EXPECT_EQ(exp.drivers().size(), 1u);
    EXPECT_EQ(exp.drivers()[0]->tag(), "good");
}

TEST_F(JsonExperimentFixture, MaxSubmitsLimitsJobs) {
    auto swf = write_swf();
    json cfg;
    cfg["max_submits"] = 2;
    cfg["drivers"] = json::array({
        json{{"type", "fcfs"}, {"tag", "limited"}}
    });
    write_json(swf, cfg);

    JsonExperiment exp(json_path_);
    exp.run();
    ASSERT_EQ(exp.drivers().size(), 1u);
    EXPECT_EQ(exp.drivers()[0]->jobs_completed(), 2);
}

TEST_F(JsonExperimentFixture, SummaryWrittenAfterRun) {
    auto swf = write_swf();
    json cfg;
    cfg["drivers"] = json::array({
        json{{"type", "sjf"}, {"tag", "stest"}}
    });
    write_json(swf, cfg);

    JsonExperiment exp(json_path_);
    exp.run();
    EXPECT_TRUE(std::filesystem::exists(out_dir_ + "/summary.csv"));
}

TEST_F(JsonExperimentFixture, AllHeuristicPoliciesRun) {
    auto swf = write_swf();
    json cfg;
    cfg["drivers"] = json::array({
        json{{"type","fcfs"}}, json{{"type","sjf"}},  json{{"type","ljf"}},
        json{{"type","srf"}},  json{{"type","lrf"}},  json{{"type","scf"}},
        json{{"type","lcf"}},  json{{"type","lcfs"}}, json{{"type","wfp"}},
        json{{"type","wfp1"}}, json{{"type","fcsj"}}, json{{"type","fat"}},
        json{{"type","unicep"}},json{{"type","f1"}}, json{{"type","f2"}},
        json{{"type","f3"}},   json{{"type","f4"}},
    });
    write_json(swf, cfg);

    JsonExperiment exp(json_path_);
    exp.run();
    EXPECT_EQ(exp.drivers().size(), 17u);
    for (const auto& d : exp.drivers())
        EXPECT_EQ(d->jobs_completed(), 3) << "Failed: " << d->tag();
}

// ── New tests ─────────────────────────────────────────────────────────────────

// Test 21: BSLD values in summary.csv are always >= 1.0 (wait >= 0 invariant)
TEST(ExperimentTest, BsldSummaryAlwaysAtLeastOne) {
    const std::string out = "/tmp/exp_test_bsld";
    std::filesystem::remove_all(out);
    TestExperiment exp(out);
    exp.add_driver_with_jobs({
        make_job(1, 0,  100, 80, 4),
        make_job(2, 0,  100, 80, 4),  // second job waits
        make_job(3, 50, 200, 50, 4),
    }, "bsld");
    exp.run();

    std::ifstream f(out + "/summary.csv");
    ASSERT_TRUE(f.is_open());
    std::string header;
    std::getline(f, header);

    // Find bsld_min column
    int bsld_min_col = -1;
    { std::istringstream hss(header); std::string col;
      for (int i = 0; std::getline(hss, col, ','); ++i)
          if (col == "bsld_min") { bsld_min_col = i; break; } }
    ASSERT_GE(bsld_min_col, 0);

    std::string row;
    while (std::getline(f, row)) {
        std::istringstream rss(row);
        std::string val;
        for (int i = 0; std::getline(rss, val, ','); ++i) {
            if (i == bsld_min_col) {
                EXPECT_GE(std::stod(val), 1.0);
            }
        }
    }
}

// Test 23: Summary CSV has exactly one data row per registered driver
TEST(ExperimentTest, SummaryHasOneRowPerDriver) {
    const std::string out = "/tmp/exp_test_multirow";
    std::filesystem::remove_all(out);

    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4), make_job(2, 10, 100, 80, 4) };

    FifoPolicy fp;
    SjfPolicy  sp;

    DriverConfig dc1; dc1.tag = "fifo"; dc1.output_dir = out;
    DriverConfig dc2; dc2.tag = "sjf";  dc2.output_dir = out;

    // Use TestExperiment which exposes register_driver via add_driver_with_jobs
    TestExperiment exp(out);
    auto nodes = make_nodes(2, 8);
    exp.register_driver(std::make_unique<Driver>(jobs, nodes, &fp, dc1));
    exp.register_driver(std::make_unique<Driver>(jobs, nodes, &sp, dc2));
    exp.run();

    std::ifstream f(out + "/summary.csv");
    ASSERT_TRUE(f.is_open());
    std::string line;
    std::getline(f, line);  // header
    int rows = 0;
    while (std::getline(f, line)) ++rows;
    EXPECT_EQ(rows, 2);
}

// Test 25: start_job_index in JSON config slices job list correctly
TEST_F(JsonExperimentFixture, StartJobIndexSlicesJobs) {
    auto swf = write_swf();  // 3 jobs
    json cfg;
    cfg["start_job_index"] = 1;  // skip first job
    cfg["drivers"] = json::array({
        json{{"type", "fcfs"}, {"tag", "sliced"}}
    });
    write_json(swf, cfg);

    JsonExperiment exp(json_path_);
    exp.run();
    ASSERT_EQ(exp.drivers().size(), 1u);
    EXPECT_EQ(exp.drivers()[0]->jobs_completed(), 2);  // 3 - 1 skipped
}
