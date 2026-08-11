#include <gtest/gtest.h>
#include "core/resources.h"

// Test 1: fits_in returns true when all fields fit
TEST(ResourcesTest, FitsInTrueWhenAllFit) {
    Resources available{10, 16000, 2};
    
    // Completely smaller
    Resources job1{4, 8000, 1};
    EXPECT_TRUE(job1.fits_in(available));

    // Exactly the same size
    Resources job2{10, 16000, 2};
    EXPECT_TRUE(job2.fits_in(available));
}

// Test 2: fits_in returns false when procs exceed available
TEST(ResourcesTest, FitsInFalseWhenProcsExceed) {
    Resources available{10, 16000, 2};
    Resources job{12, 8000, 1}; // Procs too high
    
    EXPECT_FALSE(job.fits_in(available));
}

// Test 3: fits_in returns false when memory exceeds available
TEST(ResourcesTest, FitsInFalseWhenMemoryExceeds) {
    Resources available{10, 16000, 2};
    Resources job{4, 24000, 1}; // Memory too high
    
    EXPECT_FALSE(job.fits_in(available));
}

// Test 4: fits_in returns false when gpus exceed available
TEST(ResourcesTest, FitsInFalseWhenGpusExceed) {
    Resources available{10, 16000, 2};
    Resources job{4, 8000, 4}; // GPUs too high
    
    EXPECT_FALSE(job.fits_in(available));
}

// Test 5: operator+= correctly accumulates two Resources
TEST(ResourcesTest, OperatorPlusEqualsAccumulates) {
    Resources pool{10, 16000, 2};
    Resources incoming{4, 8000, 1};
    
    pool += incoming;
    
    EXPECT_EQ(pool.procs, 14);
    EXPECT_EQ(pool.memory_mb, 24000);
    EXPECT_EQ(pool.gpus, 3);
}

// Test 6: operator-= correctly subtracts two Resources
TEST(ResourcesTest, OperatorMinusEqualsSubtracts) {
    Resources pool{10, 16000, 2};
    Resources outgoing{4, 6000, 1};
    
    pool -= outgoing;
    
    EXPECT_EQ(pool.procs, 6);
    EXPECT_EQ(pool.memory_mb, 10000);
    EXPECT_EQ(pool.gpus, 1);
}

// Test 7: Default-constructed Resources has all fields zero
TEST(ResourcesTest, DefaultConstructorIsZero) {
    Resources empty;
    
    EXPECT_EQ(empty.procs, 0);
    EXPECT_EQ(empty.memory_mb, 0);
    EXPECT_EQ(empty.gpus, 0);
}