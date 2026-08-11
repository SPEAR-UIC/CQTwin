#include <gtest/gtest.h>
#include "io/swf_reader.h"
#include <filesystem>
#include <fstream>

// Resolve the fixture independent of CWD: ctest runs from build/ ("../tests/..."),
// but running the binary from the repo root needs "tests/...".
static std::string resolve_swf_path() {
    for (const char* c : {"../tests/test.swf", "tests/test.swf", "test.swf"})
        if (std::filesystem::exists(c)) return c;
    return "../tests/test.swf";  // fallback: surfaces a clear open error
}
static const std::string SWF_PATH = resolve_swf_path();

// ── Header parsing ────────────────────────────────────────────────────────────

TEST(SwfReaderTest, OpensWithoutThrowing) {
    EXPECT_NO_THROW(SwfReader reader(SWF_PATH); reader.read(););
}

TEST(SwfReaderTest, MaxNodesFromHeader) {
    SwfReader reader(SWF_PATH);
    reader.read();
    EXPECT_EQ(reader.max_nodes(), 4360);
}

TEST(SwfReaderTest, MaxProcsFromHeader) {
    SwfReader reader(SWF_PATH);
    reader.read();
    EXPECT_EQ(reader.max_procs(), 4360);
}

TEST(SwfReaderTest, UnixStartTimeFromHeader) {
    SwfReader reader(SWF_PATH);
    reader.read();
    EXPECT_EQ(reader.unix_start_time(), 0);
}

// ── Job count ─────────────────────────────────────────────────────────────────

TEST(SwfReaderTest, ReturnsCorrectJobCount) {
    SwfReader reader(SWF_PATH);
    auto jobs = reader.read();
    EXPECT_EQ(static_cast<int>(jobs.size()), 500);
}

// ── First job fields ──────────────────────────────────────────────────────────

TEST(SwfReaderTest, FirstJobFields) {
    SwfReader reader(SWF_PATH);
    auto jobs = reader.read();
    ASSERT_FALSE(jobs.empty());

    const SimJob& j = jobs[0];
    EXPECT_EQ(j.id,          1);
    EXPECT_EQ(j.submit_time, 1641021254);
    EXPECT_EQ(j.walltime,    10800);
    EXPECT_EQ(j.run_time,    10800);
    EXPECT_EQ(j.requested.procs, 128);
    EXPECT_EQ(j.user_id,     -1);
    EXPECT_EQ(j.group_id,    -1);
}

// ── Sanity checks across all jobs ─────────────────────────────────────────────

TEST(SwfReaderTest, AllJobsStartQueued) {
    SwfReader reader(SWF_PATH);
    auto jobs = reader.read();
    for (const auto& j : jobs) {
        EXPECT_EQ(j.state, JobState::Queued) << "job id=" << j.id;
    }
}

TEST(SwfReaderTest, NoJobHasZeroProcs) {
    SwfReader reader(SWF_PATH);
    auto jobs = reader.read();
    for (const auto& j : jobs) {
        EXPECT_GT(j.requested.procs, 0) << "job id=" << j.id;
    }
}

TEST(SwfReaderTest, ThrowsOnBadPath) {
    SwfReader reader("nonexistent.swf");
    EXPECT_THROW(reader.read(), std::runtime_error);
}

TEST(SwfReaderTest, ParsesLargeUserAndGroupIds) {
    const auto temp_path = std::filesystem::temp_directory_path() / "swf_large_ids_test.swf";
    {
        std::ofstream out(temp_path);
        out << "; UnixStartTime: 0\n";
        out << "; MaxNodes: 4\n";
        out << "; MaxProcs: 4\n";
        out << "1 100 0 60 4 -1 -1 4 120.5 -1 1 67851294981246 97210915757907 -1 -1 -1 -1 -1\n";
    }

    SwfReader reader(temp_path.string());
    auto jobs = reader.read();

    ASSERT_EQ(jobs.size(), 1u);
    EXPECT_EQ(jobs[0].id, 1);
    EXPECT_EQ(jobs[0].submit_time, 100);
    EXPECT_EQ(jobs[0].run_time, 60);
    EXPECT_DOUBLE_EQ(jobs[0].walltime, 120.5);
    EXPECT_DOUBLE_EQ(jobs[0].requested_time, 120.5);
    EXPECT_EQ(jobs[0].requested.procs, 4);
    EXPECT_EQ(jobs[0].user_id, 67851294981246LL);
    EXPECT_EQ(jobs[0].group_id, 97210915757907LL);

    std::filesystem::remove(temp_path);
}
