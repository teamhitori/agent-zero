#!/bin/bash
# ===================================================================
# Pocket Smyth (Team Hitori) — runtime copy of pre-staged sources
# -------------------------------------------------------------------
# Drop-in replacement for upstream /ins/copy_A0.sh.
# The fork stages its source tree at /source/agent-zero (via COPY in
# the build), so this script copies from there instead of the
# upstream /git/agent-zero path. Behaviour is otherwise identical:
# only run if /a0 is empty (volume not mounted), preserve nothing,
# never overwrite.
# ===================================================================
set -e

SOURCE_DIR="/source/agent-zero"
TARGET_DIR="/a0"

if [ ! -f "$TARGET_DIR/run_ui.py" ]; then
    echo "Copying files from $SOURCE_DIR to $TARGET_DIR..."
    cp -rn --no-preserve=ownership,mode "$SOURCE_DIR/." "$TARGET_DIR"
fi
