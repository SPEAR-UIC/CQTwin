#include <gtest/gtest.h>
#include "io/maintenance_reader.h"
#include <fstream>
#include <filesystem>

// ── Fixture: write a temp mlog file and clean up ──────────────────────────────

class MlogFixture : public ::testing::Test {
protected:
    std::string path_;

    void SetUp() override {
        path_ = "/tmp/test_maintenance_reader_" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count() % 1000000) + ".mlog";
    }

    void TearDown() override {
        std::filesystem::remove(path_);
    }

    void write(const std::string& content) {
        std::ofstream f(path_);
        f << content;
    }
};

// ── Missing file throws ───────────────────────────────────────────────────────

TEST(MaintenanceReaderTest, MissingFileThrows) {
    MaintenanceReader r("/nonexistent/path/missing.mlog");
    EXPECT_THROW(r.read(), std::runtime_error);
}

// ── Empty / comment-only file ─────────────────────────────────────────────────

TEST_F(MlogFixture, EmptyFileReturnsEmpty) {
    write("");
    MaintenanceReader r(path_);
    EXPECT_TRUE(r.read().empty());
}

TEST_F(MlogFixture, CommentOnlyReturnsEmpty) {
    write("# This is a comment\n# Another comment\n");
    MaintenanceReader r(path_);
    EXPECT_TRUE(r.read().empty());
}

// ── Scheduled window ──────────────────────────────────────────────────────────

TEST_F(MlogFixture, ScheduledWindowHasAdvanceNotice) {
    // start=100000, end=200000, notice=48h=172800s before start
    write("100000 200000 S maintenance\n");
    MaintenanceReader r(path_, 48.0);
    auto wins = r.read();
    ASSERT_EQ(wins.size(), 1u);
    EXPECT_EQ(wins[0].start_time, 100000L);
    EXPECT_EQ(wins[0].end_time,   200000L);
    EXPECT_TRUE(wins[0].scheduled);
    EXPECT_EQ(wins[0].notice_time, std::max(0L, 100000L - 172800L));
}

TEST_F(MlogFixture, ScheduledWindowLowercase) {
    write("100000 200000 s\n");
    MaintenanceReader r(path_);
    auto wins = r.read();
    ASSERT_EQ(wins.size(), 1u);
    EXPECT_TRUE(wins[0].scheduled);
}

TEST_F(MlogFixture, ScheduledNoticeClampsToZero) {
    // start very early, 48h notice would go negative
    write("1000 5000 S\n");
    MaintenanceReader r(path_, 48.0);
    auto wins = r.read();
    ASSERT_EQ(wins.size(), 1u);
    EXPECT_EQ(wins[0].notice_time, 0L);
}

// ── Unscheduled window ────────────────────────────────────────────────────────

TEST_F(MlogFixture, UnscheduledWindowNoticeEqualsStart) {
    write("300000 400000 U emergency\n");
    MaintenanceReader r(path_, 48.0);
    auto wins = r.read();
    ASSERT_EQ(wins.size(), 1u);
    EXPECT_EQ(wins[0].start_time,  300000L);
    EXPECT_EQ(wins[0].end_time,    400000L);
    EXPECT_FALSE(wins[0].scheduled);
    EXPECT_EQ(wins[0].notice_time, 300000L);  // no advance notice
}

// ── Multiple windows ──────────────────────────────────────────────────────────

TEST_F(MlogFixture, MultipleWindowsParsedInOrder) {
    write(
        "100000 110000 S planned\n"
        "200000 210000 U emergency\n"
        "300000 320000 S another\n"
    );
    MaintenanceReader r(path_);
    auto wins = r.read();
    ASSERT_EQ(wins.size(), 3u);
    EXPECT_EQ(wins[0].start_time, 100000L);
    EXPECT_EQ(wins[1].start_time, 200000L);
    EXPECT_EQ(wins[2].start_time, 300000L);
    EXPECT_TRUE(wins[0].scheduled);
    EXPECT_FALSE(wins[1].scheduled);
    EXPECT_TRUE(wins[2].scheduled);
}

// ── Malformed / edge cases ────────────────────────────────────────────────────

TEST_F(MlogFixture, MalformedLinesSkipped) {
    write(
        "not_a_number 200000 S\n"
        "100000 200000 S good\n"
    );
    MaintenanceReader r(path_);
    auto wins = r.read();
    EXPECT_EQ(wins.size(), 1u);
}

TEST_F(MlogFixture, EndBeforeStartSkipped) {
    write(
        "200000 100000 S\n"   // end <= start
        "100000 200000 S\n"   // valid
    );
    MaintenanceReader r(path_);
    auto wins = r.read();
    EXPECT_EQ(wins.size(), 1u);
    EXPECT_EQ(wins[0].start_time, 100000L);
}

TEST_F(MlogFixture, WindowsWithWindowsCrlfLineEndings) {
    write("100000 200000 S\r\n200000 300000 U\r\n");
    MaintenanceReader r(path_);
    auto wins = r.read();
    EXPECT_EQ(wins.size(), 2u);
}

TEST_F(MlogFixture, CustomNoticeHours) {
    write("1000000 2000000 S\n");
    MaintenanceReader r(path_, 24.0);  // 24h = 86400s
    auto wins = r.read();
    ASSERT_EQ(wins.size(), 1u);
    EXPECT_EQ(wins[0].notice_time, 1000000L - 86400L);
}
