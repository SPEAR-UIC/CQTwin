#!/usr/bin/env bash
# build.sh — Configure and compile CQTwin.
# Usage:
#   bash build.sh                   # debug build (default)
#   bash build.sh --release         # release build
#   bash build.sh --asan            # debug + AddressSanitizer
#   bash build.sh --tsan            # debug + ThreadSanitizer
#   bash build.sh --clean           # wipe build dir first, then debug build

set -euo pipefail

# ==============================================================================
# Defaults
# ==============================================================================
BUILD_TYPE="Debug"
USE_ASAN="OFF"
USE_TSAN="OFF"
CLEAN=false

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${PROJECT_DIR}/build"

# ==============================================================================
# Argument parsing
# ==============================================================================
for arg in "$@"; do
    case "$arg" in
        --release) BUILD_TYPE="Release" ;;
        --asan)    USE_ASAN="ON" ;;
        --tsan)    USE_TSAN="ON" ;;
        --clean)   CLEAN=true ;;
        *)
            echo "Unknown argument: $arg"
            echo "Usage: bash build.sh [--release] [--asan] [--tsan] [--clean]"
            exit 1
            ;;
    esac
done

# ==============================================================================
# Environment
# ==============================================================================
module load cmake 2>/dev/null || true

PYTHON_USER_BASE_BIN="$(python3 -m site --user-base 2>/dev/null)/bin"
if [[ -n "${PYTHON_USER_BASE_BIN}" && -d "${PYTHON_USER_BASE_BIN}" ]]; then
    export PATH="${PYTHON_USER_BASE_BIN}:${PATH}"
fi

if ! command -v cmake &>/dev/null; then
    for candidate in "${HOME}/Library/Python/"*/bin; do
        if [[ -x "${candidate}/cmake" ]]; then
            export PATH="${candidate}:${PATH}"
            break
        fi
    done
fi

if ! command -v cmake &>/dev/null; then
    echo "ERROR: cmake not found. Load the module or install cmake."
    exit 1
fi

# ==============================================================================
# Build
# ==============================================================================
if $CLEAN; then
    echo "Cleaning build directory..."
    rm -rf "${BUILD_DIR}"
fi

mkdir -p "${BUILD_DIR}"

echo "Configuring (type=${BUILD_TYPE}, ASAN=${USE_ASAN}, TSAN=${USE_TSAN})..."
cmake -S "${PROJECT_DIR}" -B "${BUILD_DIR}" \
    -DCMAKE_BUILD_TYPE="${BUILD_TYPE}"      \
    -DUSE_ASAN="${USE_ASAN}"                \
    -DUSE_TSAN="${USE_TSAN}"

JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

echo "Compiling..."
cmake --build "${BUILD_DIR}" --target cqtwin -- -j"${JOBS}"

echo "Build complete: ${BUILD_DIR}/cqtwin"
