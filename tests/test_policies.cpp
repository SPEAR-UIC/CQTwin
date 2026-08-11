#include <gtest/gtest.h>
#include "policies/bsld.h"
#include "policies/lcfs.h"
#include "policies/sjf.h"
#include "policies/ljf.h"
#include "policies/srf.h"
#include "policies/lrf.h"
#include "policies/scf.h"
#include "policies/lcf.h"
#include "policies/wfp.h"
#include "policies/wfp1.h"
#include "policies/wfp2.h"
#include "policies/sww.h"
#include "policies/fcsj.h"
#include "policies/fat.h"
#include "policies/unicep.h"
#include "policies/f1.h"
#include "policies/f2.h"
#include "policies/f3.h"
#include "policies/f4.h"

// ── Helpers ───────────────────────────────────────────────────────────────────

static NodeInfo make_node(int id, int procs) {
    return NodeInfo(id, "n" + std::to_string(id), Resources{procs, 0, 0});
}

// Build a State with two jobs and a single fat node (so both can start).
// Returns the two Job objects so callers can take their addresses.
struct TwoJobState {
    Job             j1, j2;
    State           s;
    TwoJobState(long sub1, long wall1, int procs1,
                long sub2, long wall2, int procs2,
                long now = 1000)
        : j1(1, sub1, wall1, Resources{procs1, 0, 0})
        , j2(2, sub2, wall2, Resources{procs2, 0, 0})
    {
        s.nodes        = { make_node(0, 512) };
        s.pending      = { &j1, &j2 };
        s.current_time = now;
    }
};

// Returns the job_id of the first Start decision, or -1 if none.
static int first_started(SchedulerPolicy& p, const State& s) {
    auto d = p.schedule(s);
    for (const auto& dec : d)
        if (dec.type == DecisionType::Start) return dec.job_id;
    return -1;
}

// ── Name tests ────────────────────────────────────────────────────────────────

TEST(PolicyNamesTest, AllNamesCorrect) {
    EXPECT_EQ(LcfsPolicy().name(),   "lcfs");
    EXPECT_EQ(SjfPolicy().name(),    "sjf");
    EXPECT_EQ(LjfPolicy().name(),    "ljf");
    EXPECT_EQ(SrfPolicy().name(),    "srf");
    EXPECT_EQ(LrfPolicy().name(),    "lrf");
    EXPECT_EQ(ScfPolicy().name(),    "scf");
    EXPECT_EQ(LcfPolicy().name(),    "lcf");
    EXPECT_EQ(WfpPolicy().name(),    "wfp");
    EXPECT_EQ(Wfp1Policy().name(),   "wfp1");
    EXPECT_EQ(Wfp2Policy().name(),   "wfp2");
    EXPECT_EQ(SwwPolicy().name(),    "sww");
    EXPECT_EQ(FcsjPolicy().name(),   "fcsj");
    EXPECT_EQ(FatPolicy().name(),    "fat");
    EXPECT_EQ(UnicepPolicy().name(), "unicep");
    EXPECT_EQ(F1Policy().name(),     "f1");
    EXPECT_EQ(F2Policy().name(),     "f2");
    EXPECT_EQ(F3Policy().name(),     "f3");
    EXPECT_EQ(F4Policy().name(),     "f4");
    EXPECT_EQ(BsldPolicy().name(),   "bsld");
}

// ── BSLD ──────────────────────────────────────────────────────────────────────

TEST(BsldTest, PrefersLargerBoundedSlowdown) {
    // tau=3600. j1 bsld=(5000+1000)/3600=1.67; j2 bsld=max(1,(3000+100)/3600)=1.0.
    // Note WFP1 would instead pick j2 (raw wait/walltime 30 vs 5) — BSLD differs.
    TwoJobState ts(5000, 1000, 4,   // j1: wait=5000, t=1000
                   7000,  100, 4,   // j2: wait=3000, t=100
                   10000);
    BsldPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 1);
}

TEST(BsldTest, LongWaitLongJobOutranksShortJob) {
    // Both slowed; larger (wait+walltime)/max(walltime,tau) wins.
    TwoJobState ts(0, 4000, 4,      // j1: wait=8000, t=4000, max=4000 → bsld=3.0
                   0, 1000, 4,      // j2: wait=8000, t=1000, max=3600 → bsld=2.5
                   8000);
    BsldPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 1);
}

// ── WFP2 ──────────────────────────────────────────────────────────────────────

TEST(Wfp2Test, PrefersHighWaitToWalltimeRatio) {
    // Equal procs; j1 has the higher (wait/walltime) → higher squared score.
    TwoJobState ts(0,  100, 4,     // j1: wait=1000, wt=100 → r=10, score=-100*4
                   0, 1000, 4);    // j2: wait=1000, wt=1000→ r=1,  score=-1*4
    Wfp2Policy p;
    EXPECT_EQ(first_started(p, ts.s), 1);
}

// ── SWW ───────────────────────────────────────────────────────────────────────

TEST(SwwTest, PrefersLargerJobAtEqualWaitRatio) {
    // Equal wait & walltime (equal ratio); SWW scales by size, so the larger job
    // wins — where WFP1 (no size factor) would tie and fall back to submit order.
    TwoJobState ts(0, 100, 8,      // j1: procs=8 → score=-(10)*8
                   0, 100, 4);     // j2: procs=4 → score=-(10)*4
    SwwPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 1);
}

// ── LCFS ──────────────────────────────────────────────────────────────────────

TEST(LcfsTest, PrefersLaterSubmit) {
    // j2 submitted later → should start first
    TwoJobState ts(100, 500, 4,   // j1: sub=100
                   200, 500, 4);  // j2: sub=200
    LcfsPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 2);
}

// ── SJF ───────────────────────────────────────────────────────────────────────

TEST(SjfTest, PrefersShorterWalltime) {
    TwoJobState ts(0, 1000, 4,   // j1: wall=1000
                   0,  500, 4);  // j2: wall=500
    SjfPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 2);
}

// ── LJF ───────────────────────────────────────────────────────────────────────

TEST(LjfTest, PrefersLongerWalltime) {
    TwoJobState ts(0,  500, 4,
                   0, 1000, 4);
    LjfPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 2);
}

// ── SRF ───────────────────────────────────────────────────────────────────────

TEST(SrfTest, PrefersFewProcs) {
    TwoJobState ts(0, 500, 16,
                   0, 500,  4);
    SrfPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 2);
}

// ── LRF ───────────────────────────────────────────────────────────────────────

TEST(LrfTest, PrefersMoreProcs) {
    TwoJobState ts(0, 500,  4,
                   0, 500, 16);
    LrfPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 2);
}

// ── SCF ───────────────────────────────────────────────────────────────────────

TEST(ScfTest, PrefersSmallCoreHours) {
    // j1: 1000 * 8 = 8000;  j2: 500 * 4 = 2000
    TwoJobState ts(0, 1000, 8,
                   0,  500, 4);
    ScfPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 2);
}

// ── LCF ───────────────────────────────────────────────────────────────────────

TEST(LcfTest, PrefersLargeCoreHours) {
    TwoJobState ts(0,  500,  4,
                   0, 1000,  8);
    LcfPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 2);
}

// ── WFP ───────────────────────────────────────────────────────────────────────

TEST(WfpTest, PrefersHighWaitToWalltimeRatio) {
    // j1: wait=900, wall=1000 → ratio=0.9;  j2: wait=100, wall=200 → ratio=0.5
    // j1 score = -(0.9^3)*procs is more negative → j1 should start first
    TwoJobState ts(100, 1000, 4,   // j1: submit=100, now=1000 → wait=900
                   900,  200, 4,   // j2: submit=900, now=1000 → wait=100
                   1000);
    WfpPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 1);
}

// ── WFP1 ──────────────────────────────────────────────────────────────────────

TEST(Wfp1Test, PrefersHighWaitToWalltimeRatio) {
    TwoJobState ts(100, 1000, 4,
                   900,  200, 4,
                   1000);
    Wfp1Policy p;
    EXPECT_EQ(first_started(p, ts.s), 1);
}

// ── FCSJ ─────────────────────────────────────────────────────────────────────

TEST(FcsjTest, PrefersSmallerJobAtEqualWaitRatio) {
    // FCSJ = -wait/(walltime*procs). Equal wait & walltime → the smaller job wins,
    // where WFP1 (no size term) would tie and fall back to submit order.
    TwoJobState ts(0, 100, 4,    // j1: procs=4 → score=-1000/(100*4)=-2.5
                   0, 100, 8);   // j2: procs=8 → score=-1000/(100*8)=-1.25
    FcsjPolicy p;
    EXPECT_EQ(first_started(p, ts.s), 1);
}

// ── Window size ───────────────────────────────────────────────────────────────

TEST(WindowSizeTest, SjfWindowOneKeepsOriginalOrder) {
    // window_size=1: only first job sorted (trivially), tail stays in place
    // j1 (long) is first in pending → should start first even though j2 is shorter
    TwoJobState ts(0, 1000, 4,
                   0,  500, 4);
    SjfPolicy p(1);  // only consider first 1 job
    EXPECT_EQ(first_started(p, ts.s), 1);
}

// ── Empty / no-fit ────────────────────────────────────────────────────────────

TEST(SortPolicyTest, NoDecisionsWhenQueueEmpty) {
    State s;
    s.nodes        = { make_node(0, 16) };
    s.current_time = 0;
    SjfPolicy p;
    EXPECT_TRUE(p.schedule(s).empty());
}

TEST(SortPolicyTest, NoDecisionsWhenNoNodeFits) {
    Job j(1, 0, 100, Resources{64, 0, 0});
    State s;
    s.nodes        = { make_node(0, 4) };
    s.pending      = { &j };
    s.current_time = 0;
    SjfPolicy p;
    EXPECT_TRUE(p.schedule(s).empty());
}

// ── New tests ─────────────────────────────────────────────────────────────────

// Test 17: stable_sort preserves original relative order for equal-priority jobs
TEST(SjfTest, StableSortPreservesOrderForEqualWalltimes) {
    // j1 and j2 have identical walltime → SJF key is equal → stable sort must preserve j1 first
    // With window=2 and a tiny cluster (only 1 job fits), j1 should start (original order)
    Job j1(1, 0, 500, Resources{4, 0, 0});
    Job j2(2, 0, 500, Resources{4, 0, 0});
    State s;
    s.nodes        = { make_node(0, 4) };  // only 4 procs — one job at a time
    s.pending      = { &j1, &j2 };
    s.current_time = 0;
    SjfPolicy p;
    auto decisions = p.schedule(s);
    // Only j1 starts (j2 can't fit after j1 uses all procs)
    ASSERT_FALSE(decisions.empty());
    EXPECT_EQ(decisions[0].job_id, 1);  // original order preserved
}

// Test 18: FAT and UNICEP handle heterogeneous cluster (nodes with different proc counts)
TEST(FatTest, HeterogeneousClusterRuns) {
    Job j(1, 0, 100, Resources{4, 0, 0});
    State s;
    s.nodes        = { make_node(0, 8), make_node(1, 4), make_node(2, 16) };
    s.pending      = { &j };
    s.current_time = 100;
    FatPolicy p;
    auto decisions = p.schedule(s);
    // Job fits in any node — should get a Start decision
    ASSERT_FALSE(decisions.empty());
    EXPECT_EQ(decisions[0].type, DecisionType::Start);
}

TEST(UnicepTest, HeterogeneousClusterRuns) {
    Job j(1, 0, 100, Resources{4, 0, 0});
    State s;
    s.nodes        = { make_node(0, 8), make_node(1, 4), make_node(2, 16) };
    s.pending      = { &j };
    s.current_time = 100;
    UnicepPolicy p;
    auto decisions = p.schedule(s);
    ASSERT_FALSE(decisions.empty());
    EXPECT_EQ(decisions[0].type, DecisionType::Start);
}

// Test 19: Window larger than queue is equivalent to unbounded sort
TEST(SjfTest, LargeWindowEquivalentToUnbounded) {
    // 5 jobs with decreasing walltime: SJF should pick the shortest
    Job j1(1, 0, 500, Resources{4, 0, 0});
    Job j2(2, 0, 400, Resources{4, 0, 0});
    Job j3(3, 0, 300, Resources{4, 0, 0});
    Job j4(4, 0, 200, Resources{4, 0, 0});
    Job j5(5, 0, 100, Resources{4, 0, 0});

    State s;
    s.nodes        = { make_node(0, 4) };  // one fits at a time
    s.pending      = { &j1, &j2, &j3, &j4, &j5 };
    s.current_time = 0;

    SjfPolicy default_p;       // default window
    SjfPolicy large_p(10000);  // window larger than queue

    int first_default = first_started(default_p, s);
    int first_large   = first_started(large_p, s);
    EXPECT_EQ(first_default, first_large);
    EXPECT_EQ(first_default, 5);  // j5 has shortest walltime
}

// Test 20: Policies are stateless — two calls with same state return same decisions
TEST(SortPolicyTest, ScheduleIsStateless) {
    TwoJobState ts(0, 1000, 4,
                   0,  500, 4);
    SjfPolicy p;
    auto d1 = p.schedule(ts.s);
    auto d2 = p.schedule(ts.s);
    ASSERT_EQ(d1.size(), d2.size());
    for (size_t i = 0; i < d1.size(); ++i) {
        EXPECT_EQ(d1[i].type,   d2[i].type);
        EXPECT_EQ(d1[i].job_id, d2[i].job_id);
    }
}
