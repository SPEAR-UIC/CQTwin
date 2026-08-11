#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSUME_YES=false

usage() {
    cat <<'EOF'
Usage:
  ./clean_cmake.sh [--yes]

Description:
  Deletes generated CMake and native build artifacts from this CQTwin repo.
  Source code, docs, tests, and virtual environments are not removed.

Options:
  --yes, -y    Skip interactive confirmation prompts.
  --help, -h   Show this help message.
EOF
}

while (($#)); do
    case "$1" in
        --yes|-y)
            ASSUME_YES=true
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

CM_BUILD_DIRS=(
    "build"
    "CMakeFiles"
    "Testing"
)

CM_FILES=(
    "compile_commands.json"
    "CMakeCache.txt"
    "cmake_install.cmake"
    "CTestTestfile.cmake"
    "Makefile"
)

echo "This will permanently delete generated CMake/build artifacts from:"
for rel in "${CM_BUILD_DIRS[@]}"; do
    echo "  - $rel"
done
for rel in "${CM_FILES[@]}"; do
    echo "  - $rel"
done

if [[ "$ASSUME_YES" == false ]]; then
    read -r -p "Continue? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    read -r -p "Type DELETE CMAKE BUILD ARTIFACTS to confirm: " final_check
    if [[ "$final_check" != "DELETE CMAKE BUILD ARTIFACTS" ]]; then
        echo "Confirmation text mismatch. Aborted."
        exit 1
    fi
fi

for rel in "${CM_BUILD_DIRS[@]}"; do
    rm -rf "$ROOT_DIR/$rel"
done

for rel in "${CM_FILES[@]}"; do
    rm -f "$ROOT_DIR/$rel"
done

echo "Done. All CQTwin CMake/build artifacts have been cleared."
