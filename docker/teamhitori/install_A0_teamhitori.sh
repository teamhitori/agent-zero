#!/bin/bash
# ===================================================================
# Pocket Smyth (Team Hitori) — A0 install script
# -------------------------------------------------------------------
# Assumes the fork's source tree has already been COPY'd into
# /source/agent-zero by the Dockerfile. No git, no network, no
# branch selection — Pocket Smyth controls which upstream version
# is shipped via its fork commit.
# ===================================================================
set -e

SOURCE_DIR="/source/agent-zero"

if [ ! -f "$SOURCE_DIR/requirements.txt" ]; then
    echo "CRITICAL ERROR: $SOURCE_DIR is missing or incomplete. The Dockerfile must COPY the repo into $SOURCE_DIR before running this script."
    exit 1
fi

echo "Pocket Smyth install — using pre-staged sources at $SOURCE_DIR"

# Activate the base image's Python venv
. "/ins/setup_venv.sh"

# Install A0 python deps
uv pip install -r "$SOURCE_DIR/requirements.txt"
# Override packages with overly strict pins
uv pip install -r "$SOURCE_DIR/requirements2.txt"

# Install playwright (browser drivers, etc.)
bash /ins/install_playwright.sh

# Preload model assets baked into the image
python "$SOURCE_DIR/preload.py" --dockerized=true

# Purge caches to keep the image small. Note: $SOURCE_DIR is intentionally
# NOT removed — copy_A0.sh consumes it at container start to populate /a0.
pip cache purge || true
uv cache prune || true
