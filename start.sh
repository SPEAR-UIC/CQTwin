#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -ti tcp:8080 || true)"
    if [[ -n "$pid" ]]; then
        kill "$pid" || true
    fi
fi

INSTALL_SCRIPT="$ROOT_DIR/sys_req/install_or_update_modules.sh"
if [[ ! -f "$INSTALL_SCRIPT" ]]; then
    echo "Error: installer not found at $INSTALL_SCRIPT"
    exit 1
fi

bash "$INSTALL_SCRIPT"

ENGINE_BIN="$ROOT_DIR/build/cqtwin"
if [[ ! -x "$ENGINE_BIN" ]]; then
    echo "Building native CQTwin engine..."
    bash "$ROOT_DIR/build.sh" --release
fi

VENV_PY="$ROOT_DIR/.venv/bin/python"
if [[ -x "$VENV_PY" ]]; then
    "$VENV_PY" dashboard/serve.py
else
    echo "Warning: venv python not found at $VENV_PY, falling back to python3."
    python3 dashboard/serve.py
fi
