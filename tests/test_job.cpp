#include <gtest/gtest.h>
#include "core/job.h"

// ── Job ──────────────────────────────────────────────────────────────────────

TEST(JobTest, ConstructorSetsFields) {
    Resources res{4, 8000, 0};
    Job job(1, 1000, 3600, res, 5);

    EXPECT_EQ(job.id,                  1);
    EXPECT_EQ(job.submit_time,         1000);
    EXPECT_EQ(job.walltime,            3600);
    EXPECT_EQ(job.requested.procs,     4);
    EXPECT_EQ(job.requested.memory_mb, 8000);
    EXPECT_EQ(job.requested.gpus,      0);
    EXPECT_EQ(job.priority,            5);
}

TEST(JobTest, Defaults) {
    Resources res{1, 1000, 0};
    Job job(2, 500, 1800, res);

    EXPECT_EQ(job.state,      JobState::Queued);
    EXPECT_EQ(job.queue_id,   -1);
    EXPECT_EQ(job.start_time, -1);
    EXPECT_EQ(job.end_time,   -1);
    EXPECT_EQ(job.priority,   0);
}

// ── SimJob ───────────────────────────────────────────────────────────────────

TEST(SimJobTest, ConstructorSetsAllFields) {
    Resources res{8, 16000, 2};
    SimJob job(3, 2000, 7200, res, 6000, 10);

    EXPECT_EQ(job.id,                  3);
    EXPECT_EQ(job.submit_time,         2000);
    EXPECT_EQ(job.walltime,            7200);
    EXPECT_EQ(job.run_time,            6000);
    EXPECT_EQ(job.requested.procs,     8);
    EXPECT_EQ(job.requested.memory_mb, 16000);
    EXPECT_EQ(job.requested.gpus,      2);
    EXPECT_EQ(job.priority,            10);
}

TEST(SimJobTest, InheritsJobDefaults) {
    Resources res{2, 4000, 0};
    SimJob job(4, 100, 900, res, 800);

    EXPECT_EQ(job.state,      JobState::Queued);
    EXPECT_EQ(job.queue_id,   -1);
    EXPECT_EQ(job.start_time, -1);
    EXPECT_EQ(job.end_time,   -1);
}

TEST(SimJobTest, RunTimeLessThanWalltime) {
    Resources res{4, 8000, 0};
    SimJob job(5, 0, 3600, res, 2500);

    // Actual runtime is less than requested walltime — normal in HPC traces
    EXPECT_LT(job.run_time, job.walltime);
}

TEST(SimJobTest, UsableAsConstJobRef) {
    Resources res{4, 8000, 0};
    SimJob sim_job(6, 300, 1800, res, 1200, 3);

    const Job& base = sim_job;

    EXPECT_EQ(base.id,          6);
    EXPECT_EQ(base.submit_time, 300);
    EXPECT_EQ(base.walltime,    1800);
    EXPECT_EQ(base.priority,    3);
    EXPECT_EQ(base.state,       JobState::Queued);
}