#include <gtest/gtest.h>
#include "experiment/metrics.h"
#include <cmath>

// ── percentile ────────────────────────────────────────────────────────────────

TEST(PercentileTest, EmptyVectorReturnsZero) {
    std::vector<double> v;
    EXPECT_DOUBLE_EQ(percentile(v, 50), 0.0);
}

TEST(PercentileTest, SingleValueAllPercentilesEqual) {
    std::vector<double> v = {42.0};
    EXPECT_DOUBLE_EQ(percentile(v, 0),   42.0);
    EXPECT_DOUBLE_EQ(percentile(v, 50),  42.0);
    EXPECT_DOUBLE_EQ(percentile(v, 100), 42.0);
}

TEST(PercentileTest, TwoValuesMedianInterpolates) {
    std::vector<double> v = {0.0, 100.0};
    EXPECT_DOUBLE_EQ(percentile(v, 0),   0.0);
    EXPECT_DOUBLE_EQ(percentile(v, 50),  50.0);
    EXPECT_DOUBLE_EQ(percentile(v, 100), 100.0);
}

TEST(PercentileTest, FiveValuesKnownPercentiles) {
    // percentile() requires pre-sorted input
    std::vector<double> v = {1.0, 2.0, 3.0, 4.0, 5.0};
    EXPECT_DOUBLE_EQ(percentile(v, 0),   1.0);
    EXPECT_NEAR(percentile(v, 25),  2.0, 0.5);
    EXPECT_NEAR(percentile(v, 50),  3.0, 0.5);
    EXPECT_NEAR(percentile(v, 75),  4.0, 0.5);
    EXPECT_DOUBLE_EQ(percentile(v, 100), 5.0);
}

// ── compute_percentile_stats ──────────────────────────────────────────────────

TEST(PercentileStatsTest, EmptyReturnsZeros) {
    auto s = compute_percentile_stats({});
    EXPECT_DOUBLE_EQ(s.avg, 0.0);
    EXPECT_DOUBLE_EQ(s.min, 0.0);
    EXPECT_DOUBLE_EQ(s.max, 0.0);
}

TEST(PercentileStatsTest, UniformValuesAllEqual) {
    auto s = compute_percentile_stats({5.0, 5.0, 5.0, 5.0});
    EXPECT_DOUBLE_EQ(s.avg, 5.0);
    EXPECT_DOUBLE_EQ(s.min, 5.0);
    EXPECT_DOUBLE_EQ(s.max, 5.0);
    EXPECT_DOUBLE_EQ(s.p50, 5.0);
}

TEST(PercentileStatsTest, AvgCorrect) {
    auto s = compute_percentile_stats({1.0, 2.0, 3.0, 4.0, 10.0});
    EXPECT_DOUBLE_EQ(s.avg, 4.0);
}

TEST(PercentileStatsTest, MinMaxCorrect) {
    auto s = compute_percentile_stats({7.0, 1.0, 5.0, 3.0, 9.0});
    EXPECT_DOUBLE_EQ(s.min, 1.0);
    EXPECT_DOUBLE_EQ(s.max, 9.0);
}

TEST(PercentileStatsTest, P99LessThanMax) {
    // With many values, p99 < max
    std::vector<double> vals;
    for (int i = 1; i <= 100; ++i) vals.push_back(static_cast<double>(i));
    auto s = compute_percentile_stats(vals);
    EXPECT_LT(s.p99, s.max);
    EXPECT_GT(s.p99, s.p95);
}

TEST(PercentileStatsTest, OrderingInvariant) {
    // p25 <= p50 <= p75 <= p80 <= p90 <= p95 <= p99
    std::vector<double> vals;
    for (int i = 0; i < 200; ++i) vals.push_back(i * 1.5 + 0.3 * (i % 7));
    auto s = compute_percentile_stats(vals);
    EXPECT_LE(s.min,  s.p25);
    EXPECT_LE(s.p25,  s.p50);
    EXPECT_LE(s.p50,  s.p75);
    EXPECT_LE(s.p75,  s.p80);
    EXPECT_LE(s.p80,  s.p90);
    EXPECT_LE(s.p90,  s.p95);
    EXPECT_LE(s.p95,  s.p99);
    EXPECT_LE(s.p99,  s.max);
}

TEST(PercentileStatsTest, DoesNotMutateInput) {
    std::vector<double> vals = {5.0, 1.0, 3.0};
    auto copy = vals;
    compute_percentile_stats(vals);  // takes by value — original unchanged
    EXPECT_EQ(vals, copy);
}
