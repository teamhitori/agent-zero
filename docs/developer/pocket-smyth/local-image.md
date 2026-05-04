# Local image (Pocket Smyth fork)

Cheat sheet for building, running, debugging and troubleshooting the
Pocket Smyth Agent Zero image **on your local Docker daemon**, before
pushing to ACR via `.github/workflows/teamhitori-build-and-push-acr.yml`.

Naming convention used in this doc:
- Image: `pocket-smyth/agent-zero:local`
- Container: `ps-agent-local`
- Dockerfile: `docker/teamhitori/Dockerfile`
- Build context: the fork repo root (`pocket-smyth/agent-zero/`) — same as CI (`BUILD_CONTEXT=.`)

> Run all commands from `pocket-smyth/agent-zero/` unless stated otherwise.

## Prerequisites

```bash
docker version                              # Docker Desktop / engine reachable
docker buildx version                       # buildx present (CI uses buildx)
docker buildx ls                            # confirm a builder exists & is selected

# One-off: create a dedicated builder that mirrors CI (linux/amd64)
docker buildx create --name ps-local --driver docker-container --use
docker buildx inspect --bootstrap
```

## Build image (mirrors CI step)

CI uses `docker/build-push-action@v6` with `push: false, load: true`.
The local equivalent:

```bash
# Standard build — loads result into local daemon for `docker run`
docker buildx build \
  --file docker/teamhitori/Dockerfile \
  --platform linux/amd64 \
  --load \
  --tag pocket-smyth/agent-zero:local \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --build-arg GIT_REF=$(git rev-parse --abbrev-ref HEAD) \
  --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --build-arg CACHE_DATE=$(date +%s) \
  .
```

```bash
# No-cache rebuild + verbose plain log (use when diagnosing failures)
docker buildx build \
  --file docker/teamhitori/Dockerfile \
  --platform linux/amd64 \
  --no-cache \
  --progress=plain \
  --load \
  --tag pocket-smyth/agent-zero:local \
  .
```

```bash
# Cache-only rebuild (fastest iteration when you only changed a late layer)
docker buildx build \
  -f docker/teamhitori/Dockerfile \
  --load \
  -t pocket-smyth/agent-zero:local \
  .
```

## Inspect what the build context actually ships

The Pocket Smyth Dockerfile uses a per-Dockerfile ignore file
(`docker/teamhitori/Dockerfile.dockerignore`). When a `COPY` reports
*"not found"* the file was almost certainly stripped by an ignore
rule — verify before changing the Dockerfile.

```bash
# Lint the Dockerfile (BuildKit's built-in checks)
docker buildx build \
  -f docker/teamhitori/Dockerfile \
  --check \
  .
```

```bash
# Materialise the EXACT context BuildKit will see, then grep it.
# Uses a throwaway stage that just tars the context — no app build runs.
mkdir -p /tmp/ps-ctx && \
docker buildx build \
  -f - \
  --output type=tar,dest=/tmp/ps-ctx/context.tar \
  . <<'EOF'
# syntax=docker/dockerfile:1.6
FROM scratch
COPY . /
EOF

# Now inspect it
tar -tf /tmp/ps-ctx/context.tar | grep -E '^docker/(run|teamhitori)/' | head
tar -tf /tmp/ps-ctx/context.tar | wc -l
```

> If `docker/teamhitori/copy_A0.sh` or `docker/run/fs/` are missing from
> that listing, the fix lives in `docker/teamhitori/Dockerfile.dockerignore`,
> not in the Dockerfile.

```bash
# Show which ignore file is in effect for this Dockerfile
ls -l docker/teamhitori/Dockerfile.dockerignore .dockerignore 2>/dev/null
```

## Run container

Ports baked into the image: `22` (sshd), `80` (Flask UI), `9000-9009` (A0 reserved).

```bash
# Foreground — easiest for first-run / log reading. Ctrl-C to stop.
docker run --rm -it \
  --name ps-agent-local \
  -p 8080:80 \
  -p 2222:22 \
  -p 9000-9009:9000-9009 \
  pocket-smyth/agent-zero:local
```

```bash
# Detached — for shell-in / longer sessions
docker run -d \
  --name ps-agent-local \
  -p 8080:80 \
  -p 2222:22 \
  -p 9000-9009:9000-9009 \
  pocket-smyth/agent-zero:local

docker logs -f ps-agent-local
```

```bash
# Persistent user data (mirrors VM layout: /data/<user>/{usr,memory,logs})
mkdir -p /tmp/ps-local/{usr,memory,logs}

docker run -d \
  --name ps-agent-local \
  -p 8080:80 \
  -v /tmp/ps-local/usr:/a0/usr \
  -v /tmp/ps-local/memory:/a0/memory \
  -v /tmp/ps-local/logs:/a0/logs \
  pocket-smyth/agent-zero:local
```

```bash
# .env file (mirrors the VM convention of /data/<user>/usr/.env)
docker run -d \
  --name ps-agent-local \
  -p 8080:80 \
  --env-file /tmp/ps-local/usr/.env \
  -v /tmp/ps-local/usr:/a0/usr \
  pocket-smyth/agent-zero:local
```

```bash
# Diagnostic run — override CMD to drop into bash before initialize.sh runs.
# Use this when the container exits immediately or supervisord is misbehaving.
docker run --rm -it \
  --name ps-agent-debug \
  --entrypoint /bin/bash \
  pocket-smyth/agent-zero:local

# Once inside, you can manually invoke pieces of the boot chain:
#   ls /ins/                  # install scripts (incl. install_A0_teamhitori.sh)
#   ls /exe/                  # runtime entrypoints (initialize.sh, run_A0.sh, ...)
#   ls /source/agent-zero     # pre-staged fork source (no git clone at runtime)
#   ls /a0                    # populated at runtime by /ins/copy_A0.sh
#   /exe/initialize.sh teamhitori
```

## Shell into a running container

```bash
docker exec -it ps-agent-local bash         # base image is Debian/Ubuntu — bash works
docker exec -it ps-agent-local sh -c 'ps -ef | head'
```

## Logs

```bash
docker logs -f ps-agent-local
docker logs --tail 200 ps-agent-local
```

```bash
# A0 / supervisord internal logs (when the container is up)
docker exec ps-agent-local sh -c 'ls -la /var/log/ /a0/logs 2>/dev/null'
docker exec ps-agent-local sh -c 'tail -n 200 /var/log/supervisor/supervisord.log'
```

## Inspect the image

```bash
docker images pocket-smyth/agent-zero
docker image inspect pocket-smyth/agent-zero:local | jq '.[0].Config.Labels'
docker image inspect pocket-smyth/agent-zero:local --format '{{.Size}}' | numfmt --to=iec
docker history pocket-smyth/agent-zero:local --no-trunc | head -40
```

```bash
# Confirm the fork commit baked into the image (set by --build-arg GIT_SHA)
docker image inspect pocket-smyth/agent-zero:local \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

## Stop / remove

```bash
docker stop ps-agent-local
docker rm   ps-agent-local
docker rm -f ps-agent-local                  # force, if hung

docker rmi pocket-smyth/agent-zero:local     # remove image
```

## Resource usage

```bash
docker stats ps-agent-local --no-stream
docker stats                                 # all containers, live
```

## Cleanup / disk reclaim

```bash
docker system df                             # what's using disk

# Safe-ish: remove dangling layers + stopped containers + unused networks.
# DOES NOT touch named volumes.
docker system prune

# More aggressive: also drop unused images (not just dangling).
# ⚠ Will remove any local image not referenced by a running container.
docker system prune -a

# BuildKit cache (the `cache-from/cache-to` GHA scope is separate from
# this — local buildx cache is what you want to nuke after a bad build)
docker buildx prune                          # interactive prompt
docker buildx prune -af                      # all, no prompt
```

## Common troubleshooting

```bash
# 1. "failed to compute cache key: <path>: not found" on a COPY line.
#    -> The path was excluded from the build context. Inspect the
#       per-Dockerfile ignore (see "Inspect what the build context
#       actually ships" above) before editing the Dockerfile.

# 2. Build appears to use stale layers after a code change.
docker buildx build --no-cache -f docker/teamhitori/Dockerfile --load \
  -t pocket-smyth/agent-zero:local .

# 3. Cross-arch surprise (Apple Silicon → linux/amd64 image).
#    Always pass --platform linux/amd64 to match CI; emulation is slower
#    but matches what runs in ACR / on the Hetzner VM.
docker buildx build --platform linux/amd64 ...

# 4. Container exits immediately.
docker run --rm -it --entrypoint /bin/bash pocket-smyth/agent-zero:local
#    then run /exe/initialize.sh teamhitori manually and read the error.

# 5. Port already in use on host.
ss -ltnp | grep -E ':(8080|2222|9000)'
docker run ... -p 18080:80 ...               # remap to a free host port

# 6. Bind-mount perms (Linux host): files written by container appear root-owned.
docker run --user "$(id -u):$(id -g)" ...    # only safe if image tolerates non-root
```

## Optional: local Trivy scan (mirror CI gate)

CI fails the build on `HIGH,CRITICAL` OS / library findings. To reproduce:

```bash
# Requires trivy CLI (`brew install aquasecurity/trivy/trivy` or apt)
trivy image \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --vuln-type os,library \
  --exit-code 1 \
  pocket-smyth/agent-zero:local
```

## Reference

- CI workflow: [.github/workflows/teamhitori-build-and-push-acr.yml](../../../.github/workflows/teamhitori-build-and-push-acr.yml)
- Dockerfile: [docker/teamhitori/Dockerfile](../../../docker/teamhitori/Dockerfile)
- Per-Dockerfile ignore: [docker/teamhitori/Dockerfile.dockerignore](../../../docker/teamhitori/Dockerfile.dockerignore)
- VM cheat sheet (sister doc): `pocket-smyth/logic-agent-platform/docs/ops/vm.md`
