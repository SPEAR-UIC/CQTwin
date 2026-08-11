#include <gtest/gtest.h>
#include "adapters/simulation/driver.h"
#include "policies/fifo.h"
#include "policies/sjf.h"
#include "policies/wfp.h"
#include <fstream>
#include <sstream>

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

static DriverConfig basic_config(const std::string& tag = "test",
                                  const std::string& out = "/tmp/driver_test") {
    DriverConfig dc;
    dc.tag        = tag;
    dc.output_dir = out;
    return dc;
}

// ── Construction ──────────────────────────────────────────────────────────────

TEST(DriverTest, ConstructsWithoutCrash) {
    FifoPolicy p;
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    EXPECT_NO_THROW(Driver(jobs, make_nodes(1, 8), &p, basic_config()));
}

TEST(DriverTest, ConstructsWithNoJobs) {
    FifoPolicy p;
    EXPECT_NO_THROW(Driver({}, make_nodes(1, 8), &p, basic_config()));
}

// ── Basic run ─────────────────────────────────────────────────────────────────

TEST(DriverTest, RunCompletesWithSingleJob) {
    FifoPolicy p;
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    Driver d(jobs, make_nodes(1, 8), &p, basic_config("single"));
    EXPECT_NO_THROW(d.run());
    EXPECT_EQ(d.jobs_completed(), 1);
}

TEST(DriverTest, RunCompletesWithMultipleJobs) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0,   100, 80, 4),
        make_job(2, 10,  200, 90, 4),
        make_job(3, 20,  150, 70, 4),
    };
    Driver d(jobs, make_nodes(2, 8), &p, basic_config("multi"));
    d.run();
    EXPECT_EQ(d.jobs_completed(), 3);
}

TEST(DriverTest, RunWithEmptyJobListDoesNotCrash) {
    FifoPolicy p;
    Driver d({}, make_nodes(1, 8), &p, basic_config("empty"));
    EXPECT_NO_THROW(d.run());
    EXPECT_EQ(d.jobs_completed(), 0);
}

// ── max_jobs / start_job slicing ──────────────────────────────────────────────

TEST(DriverTest, MaxJobsLimitsCompletion) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 80, 4),
        make_job(2, 10, 100, 80, 4),
        make_job(3, 20, 100, 80, 4),
        make_job(4, 30, 100, 80, 4),
    };
    DriverConfig dc = basic_config("maxjobs");
    dc.max_jobs = 2;
    Driver d(jobs, make_nodes(1, 8), &p, dc);
    d.run();
    EXPECT_EQ(d.jobs_completed(), 2);
}

TEST(DriverTest, StartJobSkipsEarlyJobs) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0,  100, 80, 4),
        make_job(2, 10, 100, 80, 4),
        make_job(3, 20, 100, 80, 4),
    };
    DriverConfig dc = basic_config("startjob");
    dc.start_job = 1;   // skip first job
    Driver d(jobs, make_nodes(1, 8), &p, dc);
    d.run();
    EXPECT_EQ(d.jobs_completed(), 2);
}

// ── Policy comparison ─────────────────────────────────────────────────────────

TEST(DriverTest, SjfFinishesAllJobs) {
    SjfPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0, 300, 250, 4),
        make_job(2, 0, 100,  80, 4),
        make_job(3, 0, 200, 150, 4),
    };
    Driver d(jobs, make_nodes(1, 8), &p, basic_config("sjf"));
    d.run();
    EXPECT_EQ(d.jobs_completed(), 3);
}

TEST(DriverTest, WfpFinishesAllJobs) {
    WfpPolicy p(10);
    std::vector<SimJob> jobs = {
        make_job(1, 0,  200, 150, 4),
        make_job(2, 0,  100,  80, 4),
        make_job(3, 5,  300, 200, 4),
    };
    Driver d(jobs, make_nodes(1, 8), &p, basic_config("wfp"));
    d.run();
    EXPECT_EQ(d.jobs_completed(), 3);
}

// ── Stats (valid after run) ───────────────────────────────────────────────────

TEST(DriverTest, MakespanPositiveAfterRun) {
    FifoPolicy p;
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    Driver d(jobs, make_nodes(1, 8), &p, basic_config("makespan"));
    d.run();
    EXPECT_GT(d.makespan(), 0L);
}

TEST(DriverTest, AvgWaitTimeNonNegative) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0,   200, 100, 4),
        make_job(2, 0,   200, 100, 4),  // same submit time, second waits
    };
    // Single node, 4 procs each — only one fits at a time
    Driver d(jobs, make_nodes(1, 4), &p, basic_config("avgwait"));
    d.run();
    EXPECT_GE(d.avg_wait_time(), 0.0);
}

TEST(DriverTest, AvgWaitTimeReflectsQueuedContention) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 100, 4),
        make_job(2, 0, 100, 100, 4),
    };
    Driver d(jobs, make_nodes(1, 4), &p, basic_config("avgwait_exact", "/tmp/driver_test_avgwait"));
    d.run();

    EXPECT_EQ(d.jobs_completed(), 2);
    EXPECT_DOUBLE_EQ(d.avg_wait_time(), 50.0);
}

// ── Backfilling ───────────────────────────────────────────────────────────────

TEST(DriverTest, BackfillingEnabledRunsCleanly) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0, 200, 150, 8),  // large job
        make_job(2, 0, 100,  50, 2),  // small job can backfill
    };
    DriverConfig dc = basic_config("backfill");
    dc.backfill = true;
    Driver d(jobs, make_nodes(1, 8), &p, dc);
    d.run();
    EXPECT_EQ(d.jobs_completed(), 2);
}

// ── Null policy (default FIFO) ────────────────────────────────────────────────

TEST(DriverTest, NullPolicyFallsBackToDefaultFifo) {
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    Driver d(jobs, make_nodes(1, 8), nullptr, basic_config("nullpolicy"));
    EXPECT_NO_THROW(d.run());
}

// ── JIT submit ordering ───────────────────────────────────────────────────────

TEST(DriverTest, JobsWithDifferentSubmitTimesAllComplete) {
    FifoPolicy p;
    // Jobs submitted far apart in simulated time
    std::vector<SimJob> jobs = {
        make_job(1, 0,      100,  80, 4),
        make_job(2, 50000,  100,  80, 4),
        make_job(3, 100000, 100,  80, 4),
    };
    Driver d(jobs, make_nodes(1, 8), &p, basic_config("jit"));
    d.run();
    EXPECT_EQ(d.jobs_completed(), 3);
}

TEST(DriverTest, JobsThatArriveConcurrentlyAllComplete) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 1000, 100, 80, 4),
        make_job(2, 1000, 100, 80, 4),
        make_job(3, 1000, 100, 80, 4),
        make_job(4, 1000, 100, 80, 4),
    };
    // All fit simultaneously
    Driver d(jobs, make_nodes(4, 4), &p, basic_config("concurrent"));
    d.run();
    EXPECT_EQ(d.jobs_completed(), 4);
}

// ── Job that exceeds node capacity is skipped gracefully ──────────────────────

TEST(DriverTest, JobRequiringMoreProcsThanAvailableNeverRuns) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 80, 32),   // needs 32 procs
        make_job(2, 0, 100, 80,  4),   // fits fine
    };
    // Only 8 procs total
    Driver d(jobs, make_nodes(1, 8), &p, basic_config("toobig"));
    d.run();
    // Legacy CQSim-compatible FCFS stops at the blocked head job when
    // backfill is disabled, so nothing behind it should start.
    EXPECT_EQ(d.jobs_completed(), 0);
}

// ── Simulation mode ───────────────────────────────────────────────────────────

TEST(DriverTest, PerfectModeRunsCleanly) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0, 200, 180, 4),
        make_job(2, 0, 100,  90, 4),
    };
    DriverConfig dc = basic_config("perfect");
    dc.mode = SimMode::Perfect;
    Driver d(jobs, make_nodes(2, 4), &p, dc);
    d.run();
    EXPECT_EQ(d.jobs_completed(), 2);
}

// ── New tests ─────────────────────────────────────────────────────────────────

// Both modes now end jobs at their actual run_time (job_duration() is mode-
// independent), so a single job yields the SAME makespan in Normal and Perfect.
// The original `PredictionMakespanGreaterThanReal` tested the removed
// ends-at-walltime semantic; the current Normal/Perfect difference is the
// scheduler-visible walltime for backfill reservations (covered by
// test_simulator.cpp's SchedulerSees* tests), not makespan of a lone job.
TEST(DriverTest, NormalAndPerfectSameMakespanForSingleJob) {
    FifoPolicy p;
    std::vector<SimJob> jobs = { make_job(1, 0, 200, 100, 4) };

    DriverConfig normal_dc = basic_config("normal_ms", "/tmp/driver_test_modes");
    normal_dc.mode = SimMode::Normal;
    Driver normal_d(jobs, make_nodes(1, 8), &p, normal_dc);
    normal_d.run();

    DriverConfig perfect_dc = basic_config("perfect_ms", "/tmp/driver_test_modes");
    perfect_dc.mode = SimMode::Perfect;
    Driver perfect_d(jobs, make_nodes(1, 8), &p, perfect_dc);
    perfect_d.run();

    EXPECT_EQ(normal_d.makespan(), perfect_d.makespan());
    EXPECT_EQ(normal_d.jobs_completed(), 1);
}

// Test 6: Sum of jobs_run column in perf CSV equals total jobs completed
TEST(DriverTest, JobsRunSumEqualsJobsCompleted) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0,   100, 80, 4),
        make_job(2, 100, 100, 80, 4),
        make_job(3, 200, 100, 80, 4),
    };
    DriverConfig dc = basic_config("jobsrun_sum", "/tmp/driver_test_jobsrun");
    Driver d(jobs, make_nodes(1, 8), &p, dc);
    d.run();

    std::ifstream f("/tmp/driver_test_jobsrun/jobsrun_sum/performance.csv");
    ASSERT_TRUE(f.is_open());
    std::string header;
    std::getline(f, header);

    int jobs_run_col = -1;
    { std::istringstream hss(header); std::string col;
      for (int i = 0; std::getline(hss, col, ','); ++i)
          if (col == "jobs_run") { jobs_run_col = i; break; } }
    ASSERT_GE(jobs_run_col, 0);

    int total_run = 0;
    std::string row;
    while (std::getline(f, row)) {
        std::istringstream rss(row);
        std::string val;
        for (int i = 0; std::getline(rss, val, ','); ++i)
            if (i == jobs_run_col) total_run += std::stoi(val);
    }
    EXPECT_EQ(total_run, d.jobs_completed());
}

// Test 7: jobs_finished column in perf CSV is non-decreasing
TEST(DriverTest, JobsFinishedNonDecreasingInCsv) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0,  100, 80, 4),
        make_job(2, 10, 100, 80, 4),
        make_job(3, 20, 100, 80, 4),
    };
    DriverConfig dc = basic_config("jf_nondec", "/tmp/driver_test_jfnon");
    Driver d(jobs, make_nodes(1, 8), &p, dc);
    d.run();

    std::ifstream f("/tmp/driver_test_jfnon/jf_nondec/performance.csv");
    ASSERT_TRUE(f.is_open());
    std::string header;
    std::getline(f, header);

    int jf_col = -1;
    { std::istringstream hss(header); std::string col;
      for (int i = 0; std::getline(hss, col, ','); ++i)
          if (col == "jobs_finished") { jf_col = i; break; } }
    ASSERT_GE(jf_col, 0);

    int prev = -1;
    std::string row;
    while (std::getline(f, row)) {
        std::istringstream rss(row);
        std::string val;
        for (int i = 0; std::getline(rss, val, ','); ++i) {
            if (i == jf_col) {
                int cur = std::stoi(val);
                EXPECT_GE(cur, prev);
                prev = cur;
            }
        }
    }
}

// Test 8: Deterministic output — two identical Drivers produce identical stats
TEST(DriverTest, DeterministicResults) {
    FifoPolicy p1, p2;
    std::vector<SimJob> jobs = {
        make_job(1, 0,  200, 150, 4),
        make_job(2, 10, 100,  80, 4),
        make_job(3, 50, 300, 200, 4),
    };

    Driver d1(jobs, make_nodes(2, 4), &p1, basic_config("det1", "/tmp/driver_test_det"));
    Driver d2(jobs, make_nodes(2, 4), &p2, basic_config("det2", "/tmp/driver_test_det"));
    d1.run();
    d2.run();

    EXPECT_EQ(d1.jobs_completed(), d2.jobs_completed());
    EXPECT_EQ(d1.makespan(),       d2.makespan());
    EXPECT_DOUBLE_EQ(d1.avg_wait_time(), d2.avg_wait_time());
}

// Test 9: Maintenance window passed via DriverConfig delays job completion
TEST(DriverTest, MaintenanceWindowViaDriverConfig) {
    FifoPolicy p;
    std::vector<SimJob> jobs = { make_job(1, 0, 300, 50, 4) };

    DriverConfig no_maint_dc = basic_config("no_maint", "/tmp/driver_test_maint");
    Driver no_maint_d(jobs, make_nodes(1, 8), &p, no_maint_dc);
    no_maint_d.run();

    MaintenanceWindow mw;
    mw.notice_time = 0;
    mw.start_time  = 0;
    mw.end_time    = 100;
    mw.scheduled   = false;

    DriverConfig maint_dc = basic_config("with_maint", "/tmp/driver_test_maint");
    maint_dc.maintenance = {mw};
    Driver maint_d(jobs, make_nodes(1, 8), &p, maint_dc);
    maint_d.run();

    EXPECT_GT(maint_d.makespan(), no_maint_d.makespan());
}

// Test 10: Number of rows in performance CSV equals number of scheduling cycles fired
TEST(DriverTest, PerfCsvRowCountEqualsCycleCount) {
    FifoPolicy p;
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 80, 4),
        make_job(2, 0, 200, 80, 4),
    };
    DriverConfig dc = basic_config("rowcount", "/tmp/driver_test_rowcount");
    Driver d(jobs, make_nodes(1, 8), &p, dc);
    d.run();

    // Count rows in performance CSV (excluding header)
    std::ifstream perf("/tmp/driver_test_rowcount/rowcount/performance.csv");
    ASSERT_TRUE(perf.is_open());
    std::string line;
    std::getline(perf, line);  // skip header
    int perf_rows = 0;
    while (std::getline(perf, line)) ++perf_rows;

    // Count SchedulingCycle events in events CSV
    std::ifstream ev("/tmp/driver_test_rowcount/rowcount/events.csv");
    ASSERT_TRUE(ev.is_open());
    std::getline(ev, line);  // skip header
    int sched_events = 0;
    while (std::getline(ev, line))
        if (line.find("SchedulingCycle") != std::string::npos) ++sched_events;

    EXPECT_EQ(perf_rows, sched_events);
}

// Test: jobs killed by a maintenance window are requeued and all complete.
//
// Setup: 3 jobs submitted at t=0, each needing 4 procs and running for 200s.
// A scheduled maintenance window is announced at t=50 (notice) and runs from
// t=100 to t=300.  The jobs' walltime (200s) would spill past t=100, so they
// get killed on the announcement at t=50 and requeued.  After the window ends
// at t=300 a SchedulingCycle must fire (from handle_sme) AND the resubmitted
// jobs must also trigger their own cycle (from the fixed handle_resubmit) so
// that no job is stranded with an empty event queue.  All 3 jobs must complete.
TEST(DriverTest, MaintenanceKilledJobsAllCompleteAfterWindow) {
    FifoPolicy p;

    // 3 jobs: walltime 200s, run_time 180s, 4 procs each.
    // With 1 node of 12 procs they can all run in parallel.
    std::vector<SimJob> jobs = {
        make_job(1, 0, 200, 180, 4),
        make_job(2, 0, 200, 180, 4),
        make_job(3, 0, 200, 180, 4),
    };

    // Scheduled maintenance: announced at t=50, runs t=100..t=300.
    // Jobs started at t=0 would end at t=180 which is past t=100 → killed.
    MaintenanceWindow mw;
    mw.notice_time = 50;
    mw.start_time  = 100;
    mw.end_time    = 300;
    mw.scheduled   = true;

    DriverConfig dc = basic_config("resubmit_completes", "/tmp/driver_test_resubmit");
    dc.maintenance = {mw};

    Driver d(jobs, make_nodes(1, 12), &p, dc);
    d.run();

    EXPECT_EQ(d.jobs_completed(), 3);
}

// Test: jobs killed by an *unscheduled* (emergency) maintenance window all complete.
//
// Unscheduled maintenance fires with no advance notice: nodes go to Maintenance
// immediately and all running jobs are killed and requeued at w.end_time.  The
// UME handler (priority 1) restores nodes and pushes a SchedulingCycle before
// the Resubmit events (priority 3) fire, so jobs land in the queue in time for
// that cycle.  All 3 jobs must complete.
TEST(DriverTest, UnscheduledMaintenanceKilledJobsAllComplete) {
    FifoPolicy p;

    std::vector<SimJob> jobs = {
        make_job(1, 0, 200, 180, 4),
        make_job(2, 0, 200, 180, 4),
        make_job(3, 0, 200, 180, 4),
    };

    // Unscheduled maintenance: no notice, fires at t=50, ends at t=300.
    // Jobs started at t=0 are killed immediately when UMS fires at t=50.
    MaintenanceWindow mw;
    mw.notice_time = 50;
    mw.start_time  = 50;
    mw.end_time    = 300;
    mw.scheduled   = false;

    DriverConfig dc = basic_config("unscheduled_resubmit", "/tmp/driver_test_unscheduled");
    dc.maintenance = {mw};

    Driver d(jobs, make_nodes(1, 12), &p, dc);
    d.run();

    EXPECT_EQ(d.jobs_completed(), 3);
}
