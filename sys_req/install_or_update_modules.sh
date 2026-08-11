#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REQ_FILE="$SCRIPT_DIR/requirements.txt"
MARKER_FILE="$SCRIPT_DIR/.deps_bootstrapped"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

MODE="${1:-}"
if [[ "$MODE" != "" && "$MODE" != "--update" ]]; then
    echo "Usage: $0 [--update]"
    echo "  no args   Install dependencies once (first-use bootstrap)"
    echo "  --update  Reinstall/upgrade dependencies now"
    exit 2
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "Error: Python interpreter not found: $PYTHON_BIN"
    exit 1
fi

if [[ ! -f "$REQ_FILE" ]]; then
    echo "Error: requirements file missing: $REQ_FILE"
    exit 1
fi

VENV_PY="$VENV_DIR/bin/python"

if [[ "$MODE" != "--update" && -f "$MARKER_FILE" && -x "$VENV_PY" ]]; then
    echo "Dependencies already bootstrapped. Use '$0 --update' to refresh."
    exit 0
fi

if [[ ! -x "$VENV_PY" ]]; then
    echo "Creating virtual environment at $VENV_DIR ..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if [[ ! -x "$VENV_PY" ]]; then
    echo "Error: virtual environment python not found at $VENV_PY"
    exit 1
fi

echo "Installing/updating Python modules from $REQ_FILE ..."
"$VENV_PY" -m pip install --upgrade pip setuptools wheel
"$VENV_PY" -m pip install --upgrade -r "$REQ_FILE"

date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER_FILE"
echo "Dependency setup complete."
echo "Virtual environment: $VENV_DIR"
