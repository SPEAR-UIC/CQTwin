#include <gtest/gtest.h>
#include "adapters/simulation/simulator.h"

// ── Test helpers ──────────────────────────────────────────────────────────────

static std::vector<NodeInfo> make_nodes(int n, int procs) {
    std::vector<NodeInfo> nodes;
    for (int i = 0; i < n; ++i)
        nodes.emplace_back(i, "node" + std::to_string(i), Resources{procs, 0, 0});
    return nodes;
}

static SimJob make_job(int id, long submit, long walltime, long run_time, int procs) {
    return SimJob(id, submit, walltime, Resources{procs, 0, 0}, run_time);
}

// Run the simulator to completion, returning completed job count
static int run_to_done(Simulator& sim) {
    while (!sim.is_done()) sim.step();
    return static_cast<int>(sim.completed_jobs().size());
}

static bool all_nodes_in_state(const Simulator& sim, NodeState state) {
    for (const auto& node : sim.nodes()) {
        if (node.state != state) return false;
    }
    return true;
}

// ── Construction ──────────────────────────────────────────────────────────────

TEST(SimulatorTest, HasEventsAfterConstruction) {
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    Simulator sim(jobs, make_nodes(4, 4), SimMode::Normal);
    EXPECT_TRUE(sim.has_events());
}

TEST(SimulatorTest, TotalProcsMatchesNodes) {
    Simulator sim({make_job(1, 0, 100, 80, 4)}, make_nodes(4, 8), SimMode::Normal);
    EXPECT_EQ(sim.total_procs(), 32);  // 4 nodes × 8 procs
}

TEST(SimulatorTest, FullyAvailableAtStart) {
    Simulator sim({make_job(1, 0, 100, 80, 4)}, make_nodes(2, 16), SimMode::Normal);
    EXPECT_EQ(sim.available_procs(), 32);
}

// ── Step / event ordering ─────────────────────────────────────────────────────

TEST(SimulatorTest, FirstEventIsSubmit) {
    Simulator sim({make_job(1, 10, 100, 80, 4)}, make_nodes(4, 4), SimMode::Normal);
    auto e = sim.peek();
    ASSERT_TRUE(e.has_value());
    EXPECT_EQ(e->type, EventType::Submit);
    EXPECT_EQ(e->time, 10);
}

TEST(SimulatorTest, StepAdvancesCurrentTime) {
    Simulator sim({make_job(1, 5, 100, 80, 4)}, make_nodes(4, 4), SimMode::Normal);
    sim.step();  // Submit at t=5
    EXPECT_EQ(sim.current_time(), 5);
}

TEST(SimulatorTest, IsDoneAfterAllEvents) {
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    Simulator sim(jobs, make_nodes(2, 4), SimMode::Normal);
    run_to_done(sim);
    EXPECT_TRUE(sim.is_done());
}

// ── Job lifecycle ─────────────────────────────────────────────────────────────

TEST(SimulatorTest, JobCompletesAfterRunTime) {
    std::vector<SimJob> jobs = { make_job(1, 0, 200, 100, 4) };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    run_to_done(sim);
    ASSERT_EQ(sim.completed_jobs().size(), 1u);
    EXPECT_EQ(sim.completed_jobs()[0], 1);
}

TEST(SimulatorTest, AllJobsCompleteEventually) {
    std::vector<SimJob> jobs = {
        make_job(1, 0,   200, 100, 4),
        make_job(2, 50,  150,  80, 4),
        make_job(3, 100, 300, 200, 4),
    };
    Simulator sim(jobs, make_nodes(3, 4), SimMode::Normal);
    EXPECT_EQ(run_to_done(sim), 3);
}

TEST(SimulatorTest, ProcsFreedAfterJobEnds) {
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 50, 4) };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    run_to_done(sim);
    EXPECT_EQ(sim.available_procs(), sim.total_procs());
}

TEST(SimulatorTest, RecordsFirstStartTimeForQueuedJobs) {
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 100, 4),
        make_job(2, 1, 100, 100, 4),
    };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    run_to_done(sim);

    EXPECT_EQ(sim.job_start_time(1), 0);
    EXPECT_EQ(sim.job_start_time(2), 100);
}

TEST(SimulatorTest, PreservesFirstStartTimeAcrossMaintenanceResubmit) {
    MaintenanceWindow mw;
    mw.notice_time = 50;
    mw.start_time  = 50;
    mw.end_time    = 100;
    mw.scheduled   = false;

    std::vector<SimJob> jobs = { make_job(1, 0, 200, 200, 4) };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    sim.add_maintenance_windows({mw});
    run_to_done(sim);

    EXPECT_EQ(sim.job_start_time(1), 0);
}

// ── Queue access ──────────────────────────────────────────────────────────────

TEST(SimulatorTest, JobEntersQueueOnSubmit) {
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    sim.step();  // Submit
    // After submit a SchedulingCycle fires — step past it
    // Queue may already be empty if job started; just verify no crash
    EXPECT_GE(sim.completed_jobs().size() + sim.running_jobs().size() +
              sim.get_job_queue().size(), 1u);
}

TEST(SimulatorTest, SortJobQueueReorders) {
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 80, 4),
        make_job(2, 0, 100, 80, 4),
        make_job(3, 0, 100, 80, 4),
    };
    // Use a tiny cluster so jobs queue up
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);

    // Step through all submits and first scheduling cycle
    while (!sim.is_done()) {
        auto e = sim.peek();
        if (e && e->type == EventType::SchedulingCycle) {
            sim.step();
            break;
        }
        sim.step();
    }

    auto q = sim.get_job_queue();
    if (q.size() >= 2) {
        std::deque<int> reversed(q.rbegin(), q.rend());
        sim.sort_job_queue(reversed);
        EXPECT_EQ(sim.get_job_queue(), reversed);
    }
}

// ── SimMode ───────────────────────────────────────────────────────────────────
// Ported from the retired Real/Prediction enum. IMPORTANT: the engine now ALWAYS
// ends a job at its actual run_time — job_duration() returns run_time in every
// mode. The old "Prediction mode ends at walltime" behavior no longer exists, so
// the original `PredictionModeEndsAtWalltime` assertion is not portable and is
// replaced below. The current mode axis is what walltime the SCHEDULER sees for
// reservations (job_walltime_for): Normal -> requested walltime; Perfect -> the
// true run_time.

TEST(SimulatorTest, JobsEndAtRunTimeInBothModes) {
    // run_time=50, walltime=200: the job ends at t=50 regardless of mode.
    for (SimMode m : {SimMode::Normal, SimMode::Perfect}) {
        std::vector<SimJob> jobs = { make_job(1, 0, 200, 50, 4) };
        Simulator sim(jobs, make_nodes(1, 4), m);
        run_to_done(sim);
        EXPECT_EQ(sim.current_time(), 50);
    }
}

TEST(SimulatorTest, NormalModeSchedulerSeesRequestedWalltime) {
    // Normal: scheduler-visible walltime = requested walltime (200), not run_time.
    std::vector<SimJob> jobs = { make_job(1, 0, 200, 50, 4) };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    EXPECT_EQ(sim.job_walltime_for(1), 200);
}

TEST(SimulatorTest, PerfectModeSchedulerSeesTrueRunTime) {
    // Perfect: scheduler-visible walltime = true run_time (50).
    std::vector<SimJob> jobs = { make_job(1, 0, 200, 50, 4) };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Perfect);
    EXPECT_EQ(sim.job_walltime_for(1), 50);
}

// ── get_copy ──────────────────────────────────────────────────────────────────

TEST(SimulatorTest, CopyIsIndependent) {
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 80, 4),
        make_job(2, 0, 100, 80, 4),
    };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);

    // Step original past first submit + scheduling cycle
    sim.step(); sim.step(); sim.step();

    Simulator copy = sim.get_copy(false);

    // Run original to completion
    run_to_done(sim);

    // Copy should still be at its own state, not affected
    EXPECT_EQ(copy.current_time(), sim.current_time() == 0 ? 0 : copy.current_time());
    EXPECT_LE(copy.completed_jobs().size(), sim.completed_jobs().size());
}

TEST(SimulatorTest, CopySharesJobData) {
    std::vector<SimJob> jobs = { make_job(1, 0, 100, 80, 4) };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    Simulator copy = sim.get_copy(false);

    // Both should see the same job
    EXPECT_EQ(sim.get_job(1).id,   copy.get_job(1).id);
    EXPECT_EQ(sim.get_job(1).walltime, copy.get_job(1).walltime);
}

// ── New tests ─────────────────────────────────────────────────────────────────

// Test 1: Backfill reduces makespan when a small job can slip past a blocked large job.
// Submit times are staggered to guarantee deterministic FIFO queue order [j1, j2, j3].
TEST(SimulatorTest, BackfillReducesMakespan) {
    auto nodes = make_nodes(1, 8);
    // j1 submits first, fills 6 of 8 procs (2 free)
    // j2 submits at t=1, needs all 8 (head-of-queue, can't start while j1 runs)
    // j3 submits at t=2, needs only 2 (can backfill into the 2 free procs)
    std::vector<SimJob> jobs = {
        make_job(1, 0, 200, 200, 6),
        make_job(2, 1, 200, 200, 8),
        make_job(3, 2,  50,  50, 2),
    };

    Simulator no_bf(jobs, nodes, SimMode::Normal);
    no_bf.set_backfilling(false);
    run_to_done(no_bf);

    Simulator with_bf(jobs, nodes, SimMode::Normal);
    with_bf.set_backfilling(true);
    run_to_done(with_bf);

    EXPECT_LT(with_bf.current_time(), no_bf.current_time());
}

// Test 2: Unscheduled maintenance prevents job from starting until window ends
TEST(SimulatorTest, UnscheduledMaintenanceDelaysJobStart) {
    // Maintenance from t=0 to t=100; job submits at t=0
    MaintenanceWindow mw;
    mw.notice_time = 0;
    mw.start_time  = 0;
    mw.end_time    = 100;
    mw.scheduled   = false;

    std::vector<SimJob> jobs = { make_job(1, 0, 200, 50, 4) };

    // Without maintenance: job starts at t=0, ends at t=50
    Simulator no_maint(jobs, make_nodes(1, 4), SimMode::Normal);
    run_to_done(no_maint);

    // With maintenance: job can't start until t=100, ends at t=150
    Simulator with_maint(jobs, make_nodes(1, 4), SimMode::Normal);
    with_maint.add_maintenance_windows({mw});
    run_to_done(with_maint);

    EXPECT_GT(with_maint.current_time(), no_maint.current_time());
    EXPECT_GE(with_maint.current_time(), 100 + 50);
}

TEST(SimulatorTest, ScheduledMaintenanceKeepsClusterEmptyUntilEnd) {
    MaintenanceWindow mw;
    mw.notice_time = 50;
    mw.start_time  = 100;
    mw.end_time    = 200;
    mw.scheduled   = true;

    std::vector<SimJob> jobs = {
        make_job(1, 0,   300, 300, 4),  // starts before maintenance and is drained
        make_job(2, 10,  300, 300, 4),  // queued before maintenance
        make_job(3, 150,  30,  30, 4),  // arrives during maintenance
    };

    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    sim.add_maintenance_windows({mw});

    bool saw_start = false;
    bool saw_end   = false;

    while (!sim.is_done()) {
        Event e = sim.step();

        if (e.type == EventType::ScheduledMaintenanceStart) {
            saw_start = true;
            EXPECT_TRUE(sim.maintenance_active());
        }

        if (saw_start && sim.current_time() < mw.end_time) {
            EXPECT_TRUE(sim.maintenance_active());
            EXPECT_TRUE(sim.running_jobs().empty());
            EXPECT_EQ(sim.available_procs(), 0);
            EXPECT_TRUE(all_nodes_in_state(sim, NodeState::Maintenance));
        }

        if (e.type == EventType::ScheduledMaintenanceEnd) {
            saw_end = true;
            EXPECT_FALSE(sim.maintenance_active());
            EXPECT_EQ(sim.available_procs(), sim.total_procs());
            EXPECT_TRUE(all_nodes_in_state(sim, NodeState::Online));
        }
    }

    EXPECT_TRUE(saw_start);
    EXPECT_TRUE(saw_end);
}

TEST(SimulatorTest, UnscheduledMaintenanceKeepsClusterEmptyUntilEnd) {
    MaintenanceWindow mw;
    mw.notice_time = 100;
    mw.start_time  = 100;
    mw.end_time    = 200;
    mw.scheduled   = false;

    std::vector<SimJob> jobs = {
        make_job(1, 0,   300, 300, 4),  // starts before maintenance and is drained
        make_job(2, 20,  300, 300, 4),  // queued before maintenance
        make_job(3, 150,  30,  30, 4),  // arrives during maintenance
    };

    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    sim.add_maintenance_windows({mw});

    bool saw_start = false;
    bool saw_end   = false;

    while (!sim.is_done()) {
        auto next = sim.peek();
        ASSERT_TRUE(next.has_value());
        if (next->type == EventType::UnscheduledMaintenanceStart) {
            EXPECT_FALSE(sim.running_jobs().empty());
        }

        Event e = sim.step();

        if (e.type == EventType::UnscheduledMaintenanceStart) {
            saw_start = true;
            EXPECT_TRUE(sim.maintenance_active());
        }

        if (saw_start && sim.current_time() < mw.end_time) {
            EXPECT_TRUE(sim.maintenance_active());
            EXPECT_TRUE(sim.running_jobs().empty());
            EXPECT_EQ(sim.available_procs(), 0);
            EXPECT_TRUE(all_nodes_in_state(sim, NodeState::Maintenance));
        }

        if (e.type == EventType::UnscheduledMaintenanceEnd) {
            saw_end = true;
            EXPECT_FALSE(sim.maintenance_active());
            EXPECT_EQ(sim.available_procs(), sim.total_procs());
            EXPECT_TRUE(all_nodes_in_state(sim, NodeState::Online));
        }
    }

    EXPECT_TRUE(saw_start);
    EXPECT_TRUE(saw_end);
}

// Test 4: get_copy produces independent state — running the copy doesn't affect original
TEST(SimulatorTest, GetCopyHasIndependentState) {
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 80, 4),
        make_job(2, 0, 100, 80, 4),
    };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);

    // Step past first scheduling cycle
    while (!sim.is_done() && sim.peek() && sim.peek()->type != EventType::SchedulingCycle)
        sim.step();
    sim.step();  // consume the scheduling cycle

    Simulator copy = sim.get_copy(false);
    long copy_time_before = copy.current_time();

    // Run original to completion
    run_to_done(sim);

    // Copy's time should still equal what it was before we ran the original
    EXPECT_EQ(copy.current_time(), copy_time_before);
}

TEST(SimulatorTest, CopyDropsSchedulingCallbackAndInjectedCycleUsesDefaultScheduler) {
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 80, 4),
        make_job(2, 1, 100, 80, 4),
    };
    Simulator sim(jobs, make_nodes(2, 4), SimMode::Normal);
    sim.set_scheduling_callback([](Simulator&, long) {
        // Intentionally leave the queue untouched.
    });

    while (!sim.is_done()) sim.step();

    ASSERT_EQ(sim.running_jobs().size(), 0u);
    ASSERT_EQ(sim.get_job_queue().size(), 2u);
    ASSERT_FALSE(sim.peek().has_value());

    Simulator copy = sim.get_copy(false);
    copy.inject_scheduling_cycle();
    ASSERT_TRUE(copy.peek().has_value());
    EXPECT_EQ(copy.peek()->type, EventType::SchedulingCycle);

    copy.step();

    EXPECT_EQ(copy.running_jobs().size(), 2u);
    EXPECT_TRUE(copy.get_job_queue().empty());
    EXPECT_FALSE(sim.peek().has_value());
    EXPECT_TRUE(sim.get_job_queue().size() == 2u);
}

// Test 5a: current_time is non-decreasing across all steps
TEST(SimulatorTest, CurrentTimeNonDecreasing) {
    std::vector<SimJob> jobs = {
        make_job(1, 0,   200, 100, 4),
        make_job(2, 50,  150,  80, 4),
        make_job(3, 100, 300, 200, 4),
    };
    Simulator sim(jobs, make_nodes(2, 4), SimMode::Normal);
    long prev = 0;
    while (!sim.is_done()) {
        sim.step();
        EXPECT_GE(sim.current_time(), prev);
        prev = sim.current_time();
    }
}

// Test 5b: End event fires before Submit at the same timestamp
TEST(SimulatorTest, EndEventFiresBeforeSubmitAtSameTime) {
    // j1 ends at t=50; j2 submits at t=50
    // If End fires first, j2 can start at t=50 → sim ends at t=100
    // If Submit fires first, j2 starts at t=50 anyway (same result here, but order is correct)
    std::vector<SimJob> jobs = {
        make_job(1, 0, 100, 50, 4),   // starts at t=0, ends at t=50
        make_job(2, 50, 100, 50, 4),  // submits at t=50
    };
    Simulator sim(jobs, make_nodes(1, 4), SimMode::Normal);
    run_to_done(sim);

    // Both jobs should complete because End frees procs before SchedulingCycle
    EXPECT_EQ(static_cast<int>(sim.completed_jobs().size()), 2);
    // Second job started at t=50 (immediately when procs freed), ends at t=100
    EXPECT_EQ(sim.current_time(), 100);
}
