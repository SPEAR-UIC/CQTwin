#include <gtest/gtest.h>
#include "policies/fifo.h"

static NodeInfo make_node(int id, int procs) {
    return NodeInfo(id, "node" + std::to_string(id), Resources{procs, 0, 0});
}

static const Job make_job(int id, int procs) {
    return Job(id, 0, 100, Resources{procs, 0, 0});
}

// ── Basic dispatch ────────────────────────────────────────────────────────────

TEST(FifoTest, StartsJobWhenResourcesFit) {
    State s;
    s.nodes = { make_node(0, 8) };
    Job j = make_job(1, 4);
    s.pending = { &j };

    FifoPolicy policy;
    auto decisions = policy.schedule(s);

    ASSERT_EQ(decisions.size(), 1u);
    EXPECT_EQ(decisions[0].type,   DecisionType::Start);
    EXPECT_EQ(decisions[0].job_id, 1);
}

TEST(FifoTest, NoDecisionWhenNoResourcesFit) {
    State s;
    s.nodes = { make_node(0, 2) };
    Job j = make_job(1, 4);
    s.pending = { &j };

    FifoPolicy policy;
    auto decisions = policy.schedule(s);

    EXPECT_TRUE(decisions.empty());
}

TEST(FifoTest, EmptyQueueProducesNoDecisions) {
    State s;
    s.nodes = { make_node(0, 8) };

    FifoPolicy policy;
    EXPECT_TRUE(policy.schedule(s).empty());
}

// ── Multi-job ─────────────────────────────────────────────────────────────────

TEST(FifoTest, StartsMultipleJobsOnSeparateNodes) {
    State s;
    s.nodes = { make_node(0, 4), make_node(1, 4) };
    Job j1 = make_job(1, 4);
    Job j2 = make_job(2, 4);
    s.pending = { &j1, &j2 };

    FifoPolicy policy;
    auto decisions = policy.schedule(s);

    EXPECT_EQ(decisions.size(), 2u);
}

TEST(FifoTest, RespectsOrderFirstJobBlocksSecond) {
    // One node with 4 procs. Job 1 needs 4, job 2 needs 4.
    // Job 1 should start, job 2 should not (node now full).
    State s;
    s.nodes = { make_node(0, 4) };
    Job j1 = make_job(1, 4);
    Job j2 = make_job(2, 4);
    s.pending = { &j1, &j2 };

    FifoPolicy policy;
    auto decisions = policy.schedule(s);

    ASSERT_EQ(decisions.size(), 1u);
    EXPECT_EQ(decisions[0].job_id, 1);
}

TEST(FifoTest, PacksTwoSmallJobsOntoOneNode) {
    State s;
    s.nodes = { make_node(0, 8) };
    Job j1 = make_job(1, 4);
    Job j2 = make_job(2, 4);
    s.pending = { &j1, &j2 };

    FifoPolicy policy;
    auto decisions = policy.schedule(s);

    EXPECT_EQ(decisions.size(), 2u);
}

// ── Offline nodes ─────────────────────────────────────────────────────────────

TEST(FifoTest, SkipsOfflineNode) {
    State s;
    NodeInfo offline = make_node(0, 8);
    offline.state = NodeState::Offline;
    s.nodes = { offline };
    Job j = make_job(1, 4);
    s.pending = { &j };

    FifoPolicy policy;
    EXPECT_TRUE(policy.schedule(s).empty());
}

// ── Name ──────────────────────────────────────────────────────────────────────

TEST(FifoTest, NameIsFifo) {
    FifoPolicy policy;
    EXPECT_EQ(policy.name(), "fifo");
}
