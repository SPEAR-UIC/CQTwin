#include <gtest/gtest.h>
#include "core/node.h"

// ── Construction ─────────────────────────────────────────────────────────────

TEST(NodeInfoTest, ConstructorSetsFields) {
    Resources total{16, 32000, 4};
    NodeInfo node(1, "node001", total);

    EXPECT_EQ(node.id,   1);
    EXPECT_EQ(node.name, "node001");
    EXPECT_EQ(node.total.procs,      16);
    EXPECT_EQ(node.total.memory_mb,  32000);
    EXPECT_EQ(node.total.gpus,       4);
}

TEST(NodeInfoTest, AvailableEqualsTotalOnConstruction) {
    Resources total{16, 32000, 4};
    NodeInfo node(1, "node001", total);

    EXPECT_EQ(node.available.procs,     node.total.procs);
    EXPECT_EQ(node.available.memory_mb, node.total.memory_mb);
    EXPECT_EQ(node.available.gpus,      node.total.gpus);
}

TEST(NodeInfoTest, DefaultStateIsOnline) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    EXPECT_EQ(node.state, NodeState::Online);
}

// ── can_fit ──────────────────────────────────────────────────────────────────

TEST(NodeInfoTest, CanFitReturnsTrueWhenResourcesFit) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    Resources req{8, 16000, 2};
    EXPECT_TRUE(node.can_fit(req));
}

TEST(NodeInfoTest, CanFitReturnsTrueWhenExactMatch) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    Resources req{16, 32000, 4};
    EXPECT_TRUE(node.can_fit(req));
}

TEST(NodeInfoTest, CanFitReturnsFalseWhenProcsExceed) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    EXPECT_FALSE(node.can_fit({20, 8000, 0}));
}

TEST(NodeInfoTest, CanFitReturnsFalseWhenMemoryExceeds) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    EXPECT_FALSE(node.can_fit({4, 64000, 0}));
}

TEST(NodeInfoTest, CanFitReturnsFalseWhenOffline) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    node.state = NodeState::Offline;
    EXPECT_FALSE(node.can_fit({4, 8000, 1}));
}

TEST(NodeInfoTest, CanFitReturnsFalseWhenDraining) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    node.state = NodeState::Draining;
    EXPECT_FALSE(node.can_fit({4, 8000, 1}));
}

TEST(NodeInfoTest, CanFitReturnsFalseWhenMaintenance) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    node.state = NodeState::Maintenance;
    EXPECT_FALSE(node.can_fit({4, 8000, 1}));
}

// ── allocate / release ───────────────────────────────────────────────────────

TEST(NodeInfoTest, AllocateReducesAvailable) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    node.allocate({4, 8000, 1});

    EXPECT_EQ(node.available.procs,     12);
    EXPECT_EQ(node.available.memory_mb, 24000);
    EXPECT_EQ(node.available.gpus,      3);
}

TEST(NodeInfoTest, ReleaseRestoresAvailable) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    node.allocate({4, 8000, 1});
    node.release({4, 8000, 1});

    EXPECT_EQ(node.available.procs,     node.total.procs);
    EXPECT_EQ(node.available.memory_mb, node.total.memory_mb);
    EXPECT_EQ(node.available.gpus,      node.total.gpus);
}

TEST(NodeInfoTest, MultipleAllocationsAccumulate) {
    NodeInfo node(1, "node001", {16, 32000, 4});
    node.allocate({4, 8000, 1});
    node.allocate({4, 8000, 1});

    EXPECT_EQ(node.available.procs,     8);
    EXPECT_EQ(node.available.memory_mb, 16000);
    EXPECT_EQ(node.available.gpus,      2);
}
