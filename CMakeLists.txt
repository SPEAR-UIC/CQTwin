cmake_minimum_required(VERSION 3.20)
project(cqtwin LANGUAGES CXX C)

# ==============================================================================
# C++ STANDARD
# ==============================================================================
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ==============================================================================
# BUILD TYPE
# Defaults to Debug. Override with: cmake -DCMAKE_BUILD_TYPE=Release
# ==============================================================================
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug)
endif()
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")

# ==============================================================================
# COMPILER WARNINGS
# ==============================================================================
add_compile_options(
    -Wall
    -Wextra
    -Wpedantic
    -Wno-unused-parameter
)

# ==============================================================================
# SANITIZER OPTIONS
# Only one sanitizer may be active at a time.
# Enable with: cmake -DUSE_ASAN=ON  or  cmake -DUSE_TSAN=ON
# ==============================================================================
option(USE_ASAN "Enable AddressSanitizer + UndefinedBehaviorSanitizer" OFF)
option(USE_TSAN "Enable ThreadSanitizer" OFF)

if(USE_ASAN AND USE_TSAN)
    message(FATAL_ERROR "USE_ASAN and USE_TSAN cannot be enabled at the same time.")
endif()

if(USE_ASAN)
    message(STATUS "Sanitizer: AddressSanitizer + UBSan")
    add_compile_options(-fsanitize=address -fsanitize=undefined -fno-omit-frame-pointer)
    add_link_options(-fsanitize=address -fsanitize=undefined)
elseif(USE_TSAN)
    message(STATUS "Sanitizer: ThreadSanitizer")
    add_compile_options(-fsanitize=thread -fno-omit-frame-pointer)
    add_link_options(-fsanitize=thread)
else()
    message(STATUS "Sanitizer: none")
endif()

# ==============================================================================
# DEPENDENCIES
# ==============================================================================

# --- OpenMP (optional) ------------------------------------------------------
find_package(OpenMP)
if(OpenMP_CXX_FOUND)
    message(STATUS "OpenMP: found")
else()
    message(STATUS "OpenMP: not found")
endif()

# --- GoogleTest (fetched automatically at configure time) --------------------
include(FetchContent)
FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG        v1.15.2
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

# ==============================================================================
# HELPER: add_scheduler_test(target_name source1.cpp source2.cpp ...)
# Creates a test executable, links GTest, and registers it with ctest.
# All tests automatically get src/ and third_party/ on the include path.
# ==============================================================================
include(GoogleTest)
function(add_scheduler_test target_name)
    add_executable(${target_name} ${ARGN})
    target_include_directories(${target_name} PRIVATE
        ${PROJECT_SOURCE_DIR}/src
        ${PROJECT_SOURCE_DIR}/third_party
    )
    target_link_libraries(${target_name} PRIVATE GTest::gtest_main)
    if(OpenMP_CXX_FOUND)
        target_link_libraries(${target_name} PRIVATE OpenMP::OpenMP_CXX)
    endif()
    gtest_discover_tests(${target_name})
endfunction()

# ==============================================================================
# TARGETS
# ==============================================================================
enable_testing()

# --- Core scheduler library --------------------------------------------------
# Uncomment and add .cpp files here as you implement them:
# add_library(hpcsched_core STATIC
#     src/scheduler/job_manager.cpp
#     src/scheduler/queue_manager.cpp
#     src/scheduler/resource_manager.cpp
# )
# target_include_directories(hpcsched_core PUBLIC src third_party)

# --- Experiment executable ---------------------------------------------------
set(CQTWIN_SOURCES
    src/main.cpp
    src/adapters/simulation/simulator.cpp
    src/adapters/simulation/driver.cpp
    src/adapters/simulation/legacy_dispatch.cpp
    src/adapters/env/online_env.cpp
    src/adapters/env/ndjson_server.cpp
    src/io/swf_reader.cpp
    src/experiment/experiment.cpp
    src/experiment/json_experiment.cpp
    src/experiment/scenario_preview.cpp
    src/policies/policy_factory.cpp
)

add_executable(cqtwin ${CQTWIN_SOURCES})
target_include_directories(cqtwin PRIVATE
    ${PROJECT_SOURCE_DIR}/src
    ${PROJECT_SOURCE_DIR}/third_party
)
if(OpenMP_CXX_FOUND)
    target_link_libraries(cqtwin PRIVATE OpenMP::OpenMP_CXX)
endif()

# --- Tests -------------------------------------------------------------------
add_scheduler_test(test_resources tests/test_resources.cpp)
add_scheduler_test(test_job      tests/test_job.cpp)
add_scheduler_test(test_node       tests/test_node.cpp)
add_scheduler_test(test_swf_reader  tests/test_swf_reader.cpp  src/io/swf_reader.cpp)
add_scheduler_test(test_simulator   tests/test_simulator.cpp   src/adapters/simulation/simulator.cpp)
add_scheduler_test(test_fifo        tests/test_fifo.cpp)
add_scheduler_test(test_policies    tests/test_policies.cpp)

set(COMMON_SIM_SRCS
    src/adapters/simulation/simulator.cpp
    src/adapters/simulation/driver.cpp
    src/adapters/simulation/legacy_dispatch.cpp
    src/adapters/env/online_env.cpp
    src/io/swf_reader.cpp
    src/experiment/experiment.cpp
    src/experiment/json_experiment.cpp
    src/policies/policy_factory.cpp
)

add_scheduler_test(test_driver       tests/test_driver.cpp              ${COMMON_SIM_SRCS})
add_scheduler_test(test_metrics      tests/test_metrics.cpp)
add_scheduler_test(test_maint_reader tests/test_maintenance_reader.cpp)
add_scheduler_test(test_experiment   tests/test_experiment.cpp          ${COMMON_SIM_SRCS})
add_scheduler_test(test_regression   tests/test_regression.cpp          ${COMMON_SIM_SRCS})
add_scheduler_test(test_online_env   tests/test_online_env.cpp          ${COMMON_SIM_SRCS})
add_scheduler_test(test_online_fidelity tests/test_online_fidelity.cpp   ${COMMON_SIM_SRCS})
add_scheduler_test(test_online_fork_visibility tests/test_online_fork_visibility.cpp ${COMMON_SIM_SRCS})
add_scheduler_test(test_online_projection_copy  tests/test_online_projection_copy.cpp  ${COMMON_SIM_SRCS})
add_scheduler_test(test_online_stream           tests/test_online_stream.cpp           ${COMMON_SIM_SRCS})
add_scheduler_test(test_online_run              tests/test_online_run.cpp              ${COMMON_SIM_SRCS})

# --- Measurement tool (not a test): full-trace stream-mode timings/equality ---
add_executable(measure_stream tools/measure_stream.cpp ${COMMON_SIM_SRCS})
target_include_directories(measure_stream PRIVATE
    ${PROJECT_SOURCE_DIR}/src
    ${PROJECT_SOURCE_DIR}/third_party
)
if(OpenMP_CXX_FOUND)
    target_link_libraries(measure_stream PRIVATE OpenMP::OpenMP_CXX)
endif()
