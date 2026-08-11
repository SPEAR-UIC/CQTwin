#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSUME_YES=false

usage() {
    cat <<'EOF'
Usage:
  ./wipe_data.sh [--yes]

Description:
  Deletes all user/generated simulation data from this CQTwin repo so it can
  be shared cleanly. Source code is not removed.

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

DATA_DIRS=(
    "data/InputFiles"
    "data/Maintenance"
    "data/Fmt"
    "data/Results"
    "data/Debug"
    "data/engine_runs"
    "data/native_results"
    "dashboard/data/operator_forks"
    "dashboard/data/timeseries"
    "dashboard/data/recommendations"
    "dashboard/data/scenario_runs"
    "dashboard/data/worklogs"
    "dashboard/data/run_cache"
    "dashboard/preset"
)

DATA_FILES=(
    "dashboard/data/summary.json"
    "dashboard/data/worklog.json"
)

clear_dir_contents() {
    local abs_dir="$1"
    mkdir -p "$abs_dir"
    find "$abs_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

clear_generated_config_dirs() {
    local config_dir="$1"
    mkdir -p "$config_dir"
    find "$config_dir" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
}

echo "This will permanently delete generated/user data from:"
for rel in "${DATA_DIRS[@]}"; do
    echo "  - $rel"
done
echo "  - data/Config/*/"
for rel in "${DATA_FILES[@]}"; do
    echo "  - $rel"
done
echo "  - repo-wide .DS_Store, __pycache__, and *.pyc"

if [[ "$ASSUME_YES" == false ]]; then
    read -r -p "Continue? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    read -r -p "Type DELETE CQSIM DATA to confirm: " final_check
    if [[ "$final_check" != "DELETE CQSIM DATA" ]]; then
        echo "Confirmation text mismatch. Aborted."
        exit 1
    fi
fi

for rel in "${DATA_DIRS[@]}"; do
    clear_dir_contents "$ROOT_DIR/$rel"
done

clear_generated_config_dirs "$ROOT_DIR/data/Config"

for rel in "${DATA_FILES[@]}"; do
    rm -f "$ROOT_DIR/$rel"
done

# Remove Finder metadata files and Python cache noise left in the repo tree.
find "$ROOT_DIR" -type f -name ".DS_Store" -delete
find "$ROOT_DIR" -type d -name "__pycache__" -exec rm -rf {} +
find "$ROOT_DIR" -type f -name "*.pyc" -delete

echo "Done. All CQTwin input/output data and generated dashboard metadata have been cleared."
