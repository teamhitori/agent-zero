#!/bin/bash
set -e

# activate venv
. "/ins/setup_venv.sh" "$@"

# install playwright if not installed (should be from requirements.txt)
uv pip install playwright

# set PW installation path to temporary Browser runtime storage
export PLAYWRIGHT_BROWSERS_PATH=/a0/tmp/playwright
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

# Install chromium runtime libs explicitly. We do NOT use
# `playwright install --with-deps` because playwright's fallback list targets
# ubuntu20.04 and references pre-time_t64 package names (libasound2,
# ttf-unifont, ttf-ubuntu-font-family) that no longer exist on Kali Rolling.
# apt-get update is required because earlier image layers run `rm -rf
# /var/lib/apt/lists/*`.
apt-get update
apt-get install -y --no-install-recommends \
    fonts-unifont \
    fonts-liberation \
    libnss3 \
    libnspr4 \
    libatk1.0-0t64 \
    libatk-bridge2.0-0t64 \
    libatspi2.0-0t64 \
    libcups2t64 \
    libasound2t64 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2
playwright install chromium
