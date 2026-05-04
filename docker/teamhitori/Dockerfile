# ===================================================================
# Pocket Smyth (Team Hitori) — Agent Zero runtime image
# -------------------------------------------------------------------
# Differences vs. upstream docker/run/Dockerfile:
#   1. No git clone at build time. The fork source tree is COPY'd
#      into /source/agent-zero from the build context. Hermetic and
#      independent of github.com.
#   2. Uses install_A0_teamhitori.sh in place of upstream's
#      install_A0.sh + install_A02.sh combo.
#   3. Overrides /ins/copy_A0.sh so runtime population of /a0 reads
#      from /source/agent-zero (not /git/agent-zero).
#   4. No BRANCH build arg — the Pocket Smyth fork commit IS the
#      version pin. The CMD still passes a label to initialize.sh
#      because the upstream startup script empty-checks $1.
#
# Build context: pocket-smyth/agent-zero/ (the fork repo root).
# Layer-1 exclusions: docker/teamhitori/Dockerfile.dockerignore
# (BuildKit per-Dockerfile ignore file).
# ===================================================================
# syntax=docker/dockerfile:1.6

FROM agent0ai/agent-zero-base:latest

# Stage upstream filesystem overlay (supervisord configs, /exe scripts,
# upstream /ins scripts).
COPY ./docker/run/fs/ /

# Layer in Pocket Smyth scripts: a parallel install script and a
# copy_A0.sh override that points at /source/agent-zero. The override
# MUST come after the upstream fs/ overlay above.
COPY ./docker/teamhitori/install_A0_teamhitori.sh /ins/install_A0_teamhitori.sh
COPY ./docker/teamhitori/copy_A0.sh                /ins/copy_A0.sh
RUN chmod +x /ins/install_A0_teamhitori.sh /ins/copy_A0.sh

# Pre-stage the entire fork source so install + runtime never need to
# clone from GitHub. .dockerignore (BuildKit per-Dockerfile) controls
# what is actually copied.
COPY . /source/agent-zero

# Pre-install (apt update, ssh setup, etc.)
RUN bash /ins/pre_install.sh

# Install A0 (uses pre-staged /source/agent-zero, no git clone)
RUN bash /ins/install_A0_teamhitori.sh

# Install additional packages (LibreOffice, Xpra, fonts, ...)
RUN bash /ins/install_additional.sh

# Strip Xpra's auto-generated dev TLS material — Trivy flags it as a leaked
# private key (HIGH). Regenerate per-container at runtime if Xpra TLS is
# actually used; otherwise the absence is harmless.
RUN rm -f /etc/xpra/ssl/key.pem \
          /etc/xpra/ssl/ssl-cert.pem \
          /etc/xpra/ssl/ssl-cert.pem.* 2>/dev/null || true

# Cachebuster for downstream layers when explicitly bumped in CI.
ARG CACHE_DATE=none
RUN echo "cache buster $CACHE_DATE"

# Post-install cleanup (apt cache, etc.)
RUN bash /ins/post_install.sh

# Ports: 22 (sshd), 80 (Flask UI), 9000-9009 (reserved range used by A0)
EXPOSE 22 80 9000-9009

RUN chmod +x \
    /exe/initialize.sh \
    /exe/run_A0.sh \
    /exe/run_searxng.sh \
    /exe/run_tunnel_api.sh \
    /exe/trigger_self_update.sh

# OCI labels — populated by CI build args
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="pocket-smyth/agent-zero" \
      org.opencontainers.image.source="https://github.com/teamhitori/agent-zero" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.ref.name="$GIT_REF" \
      org.opencontainers.image.created="$BUILD_DATE" \
      com.pocketsmyth.variant="teamhitori"

# initialize.sh empty-checks $1; pass a label only.
CMD ["/exe/initialize.sh", "teamhitori"]
