# ── Cache-bust: 2026-09-02T20:00 — migrates web providers from tls-client-node to wreq-js (fixes #7802) ──
# ── Common base with runtime deps ──────────────────────────────────────────
FROM node:22.23.1-bookworm-slim AS base
WORKDIR /app

# Guard: fail the build if the base image drifts from the pinned Node version.
# The 2026-08-10 Railway outage was caused by a floating `node:22` tag drifting
# to a runtime whose teardown aborts better-sqlite3 (SIGABRT); node:22.23.2
# additionally SIGSEGV'd a next-build worker locally (no standalone emitted),
# so the pin is 22.23.1. When bumping the base image, update BOTH the FROM line
# and this guard together (ci.yml also runs `check:dockerfile-pins` to catch
# drift before merge).
RUN node --version | grep -qx "v22.23.1" \
  || { echo "Base image Node version drifted: expected v22.23.1, got $(node --version). Update Dockerfile FROM + guard together." >&2; exit 1; }

# `apt-get upgrade` pulls the security-patched versions of the Debian (trixie)
# base-image packages at build time — clears the subset of container-scan CVEs
# (perl / util-linux / systemd / ncurses / zlib / tar / sqlite / shadow / pam …)
# that already have a fix published in trixie. CVEs without an upstream fix yet
# (local-only TOCTOU, etc.) remain until the distro patches them and the image
# is rebuilt; none are reachable from the proxy's request surface at runtime.
RUN --mount=type=cache,target=/var/cache/apt,sharing=shared \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=shared \
  apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Refresh the globally-installed npm so its *bundled* node_modules ship patched
# versions of the packages the container scanner flags (npm 11.19.0 bundles
# tar@^7.5.19 and no longer declares undici as a bundled dependency, so that
# stale copy from older npm lines is gone). These are npm's own internals — not
# application dependencies (our app already resolves undici@8.5.0 / tar@7.5.16,
# both fixed) — and npm is not invoked at runtime in the runner stages, so this
# is hygiene, not an exploitable runtime path.
#
# Pinned to npm@11.19.0 (the last 11.x line), NOT npm 12: npm 12's allowScripts
# policy blocks `npm rebuild better-sqlite3` install scripts by default, so the
# native binary is never built and the build fails with "Could not locate the
# bindings file" (hit during the 2026-08-10 local Docker build). 11.x runs
# rebuild scripts normally. Same rationale as the pinned node:22.23.2 base
# image — bump deliberately, and keep check-dockerfile-pins.mjs in sync.
RUN npm install -g npm@11.19.0 \
  && test "$(npm --version)" = "11.19.0" \
  && npm cache clean --force

# ── Builder ────────────────────────────────────────────────────────────────
FROM base AS builder

# Build tools for native module compilation
# apt-get update needed here because base's rm -rf clears the shared cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=shared \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=shared \
  apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Workspace package manifests MUST be present before `npm ci` so npm materializes
# the workspace and installs its *workspace-only* deps (e.g. safe-regex,
# @toon-format/toon — declared in open-sse/package.json, not hoisted to root).
# Without this, `npm ci` skips them and the application build fails with "Module not
# found" (root cause of the v3.8.39 Docker build break). workspaces = ["open-sse"].
COPY open-sse/package.json ./open-sse/package.json
COPY scripts/build/postinstall.mjs ./scripts/build/postinstall.mjs
COPY scripts/build/postinstallSupport.mjs ./scripts/build/postinstallSupport.mjs
COPY scripts/build/native-binary-compat.mjs ./scripts/build/native-binary-compat.mjs
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true
# --ignore-scripts blocks broad dependency install/postinstall hooks, closing
# the supply-chain attack surface where a transitive dep can run arbitrary code
# at install time. better-sqlite3 still needs a native binding for the target
# platform, so rebuild and smoke-test only that known runtime dependency below.
#
# We REQUIRE a committed package-lock.json so resolved dependency versions
# are reproducible.
RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds" >&2 && exit 1)
RUN --mount=type=cache,target=/root/.npm \
  npm ci --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
  && npm rebuild better-sqlite3 \
  && node -e "require('better-sqlite3')(':memory:').close()"

# Build with webpack (stable). Turbopack hit a non-recoverable internal panic on this
# Next.js version during the v3.8.27 release build — TurbopackInternalError "entered
# unreachable code: there must be a path to a root" in ImportTracer::get_traces, on both
# linux/amd64 and linux/arm64. Webpack is the proven engine (build:release / VPS / CI Build
# all green). Re-enable Turbopack (=1) once the upstream tracer bug is fixed.
# See docs/ops/QUALITY_GATE_PLAYBOOK.md Parte 6.
ENV OMNIROUTE_USE_TURBOPACK=0

# Raise the V8 heap ceiling for the build. The webpack production optimization
# pass (forced above since Turbopack panics) needs more than V8's default ceiling
# (~2 GB) for a codebase this size; a memory-constrained Docker build otherwise
# dies with "FATAL ERROR: ... JavaScript heap out of memory" during the builder
# stage (#4076). NODE_OPTIONS propagates to the spawned `next build` child
# (build-next-isolated.mjs → resolveNextBuildEnv spreads process.env). Build-only;
# the runtime heap is set separately on the runner stage (OMNIROUTE_MEMORY_MB).
# Override for hosts with more/less RAM: `--build-arg OMNIROUTE_BUILD_MEMORY_MB=6144`.
ARG OMNIROUTE_BUILD_MEMORY_MB=6144
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_BUILD_MEMORY_MB}"

# Cap Next.js build worker pools. Next 16 defaults to `os.cpus().length - 1`
# workers (31 on a 32-core builder) for page-data collection; on memory-tight
# hosts (e.g. Docker Desktop with a small VM) 31 workers + webpack's multi-GB
# heap blow past RAM and a worker dies with SIGSEGV at teardown ("worker exited
# with code: null and signal: SIGSEGV"), silently leaving no standalone bundle.
# Next derives the default worker count from CIRCLE_NODE_TOTAL (workers = N-1),
# so N=8 → 7 workers: fast enough while fitting comfortably in RAM on any host.
ENV CIRCLE_NODE_TOTAL=8

COPY . ./
# Only the native binary is hidden (not the whole package) while `npm run build` runs.
# Build-time code that evaluates the driver — Next.js page-data workers load route
# modules natively, and OMNIROUTE_BUILDING=1 routes every DB entry point to a no-op
# stub — can then never load the addon, whose Statement destructor aborts with SIGABRT
# during worker teardown on some Node versions (node::RemoveEnvironmentCleanupHook
# assertion, env == nullptr). The npm-rebuild smoke test above is safe: it opens
# `:memory:` and closes it immediately with zero Statements. The mv-restore puts the
# binary back before the runner stages COPY it; the runner's
# `COPY --from=builder .../better-sqlite3` (AFTER the standalone COPY) is what
# guarantees the complete package (lib/ + .node) lands in the image — keep that order.
RUN --mount=type=cache,target=/app/.build/next/cache \
  mkdir -p /app/data \
  && ( mv /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
       /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node.build-hide 2>/dev/null || true ) \
  && ( npm run build ; \
       # next build can exit 0 even when a page-data worker crashed (intermittent
       # SIGSEGV during teardown on many-CPU hosts; the standalone bundle is then
       # never emitted). Retry once if the standalone output is missing, then fail
       # loudly — this also stops the broken layer from being cached as a success.
       if [ ! -d /app/.build/next/standalone ]; then \
         echo "Retrying next build: no standalone emitted (intermittent worker SIGSEGV during page-data collection)" ; \
         npm run build ; \
       fi ; \
       test -d /app/.build/next/standalone \
         || { echo "ERROR: next build produced no standalone after retry — worker crash is persistent (check the node:22.23.1 pin)." >&2 ; exit 1 ; } ) \
  && ( mv /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node.build-hide \
       /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node 2>/dev/null || true )

# ── Runner base ────────────────────────────────────────────────────────────
FROM base AS runner-base

LABEL org.opencontainers.image.title="omniroute" \
  org.opencontainers.image.description="Unified AI proxy — route any LLM through one endpoint" \
  org.opencontainers.image.url="https://omniroute.online" \
  org.opencontainers.image.source="https://github.com/diegosouzapw/OmniRoute" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV OMNIROUTE_MEMORY_MB=1024
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_MEMORY_MB}"

# Data directory inside Docker — must match the volume mount in docker-compose.yml
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

# `npm run build` (build-next-isolated → assembleStandalone) bundles ALL runtime
# files into .build/next/standalone/ — .next, node_modules, migrations, scripts,
# docs, and the previously hand-COPY'd modules below (@swc/helpers, pino-*, split2,
# migrations). assembleStandalone copies them straight from the builder's
# node_modules, so they are present regardless of NFT/Turbopack trace behaviour.
# The old per-module overrides were therefore pure duplication and were removed
# (build-output-isolation cleanup). See scripts/build/assembleStandalone.mjs
# (EXTRA_MODULE_ENTRIES) for the single source of truth.
COPY --from=builder /app/.build/next/standalone ./
# better-sqlite3 is the one exception still copied explicitly: assembleStandalone
# only syncs its native build/ dir; the JS wrapper (lib/, package.json) is left to
# Next.js tracing. bootstrap-env requires SQLite BEFORE the standalone server
# starts, so guarantee the complete package independent of trace behaviour.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# migrations land at <standalone>/migrations via assembleStandalone; point the runtime at them.
ENV OMNIROUTE_MIGRATIONS_DIR=/app/migrations

# Docker healthcheck script — not traced by Next.js standalone output, so copy
# it explicitly. The HEALTHCHECK CMD references it as `node healthcheck.mjs`.
COPY --from=builder /app/scripts/dev/healthcheck.mjs ./healthcheck.mjs

# Hand /app over to the baked-in `node` non-root user (UID/GID 1000) so the
# runtime process never holds root privileges. The chown happens after all
# COPYs so it covers files originally owned by root in the builder stage.
RUN chown -R node:node /app

EXPOSE 20128

# Warns if the mounted data volume has wrong ownership
COPY --chmod=755 scripts/check-permissions.sh /tmp/check-permissions.sh
# Belt-and-suspenders: strip CR from the entrypoint even if the build context
# came from a CRLF checkout (Windows + core.autocrlf without .gitattributes
# honoring). A CRLF shebang ("#!/bin/sh\r") makes kernel exec fail with
# `exec /tmp/check-permissions.sh: no such file or directory`. .gitattributes
# (*.sh text eol=lf) is the root fix; this guards stale checkouts. No-op when
# the file is already LF. Runs before `USER node` because sed -i renames a
# temp file over the target, which fails with EPERM under the sticky-bit /tmp
# for the non-root user when the COPY'd file is root-owned.
RUN sed -i 's/\r$//' /tmp/check-permissions.sh

# Drop to non-root before ENTRYPOINT/CMD so every derived stage (runner-cli,
# runner-web) also runs as a non-root user unless they explicitly switch back.
USER node

ENTRYPOINT ["/tmp/check-permissions.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "dev/run-standalone.mjs"]

# ── Runner Web (web-cookie providers: Gemini Web, Claude Turnstile) ───────────
#
#  Two image flavors:
#    runner-base  →  omniroute:VERSION        Lean base (~500 MB). No browsers.
#    runner-web   →  omniroute:VERSION-web    +Chromium/Playwright (~800 MB).
#
#  Use runner-web when you need web-cookie providers (gemini-web, claude-web,
#  claude-turnstile). For all other providers runner-base is sufficient.
#
#  Build:
#    docker build --target runner-web -t omniroute:web .
#  Compose:
#    build:
#      context: .
#      target: runner-web
FROM runner-base AS runner-web

USER root

# Copy playwright and playwright-core from the builder stage.
# The slim runtime image does not have playwright in node_modules, so npx falls
# back to a registry download — unreliable on CI runners (exits 127 on failure).
# Copying from the builder avoids any network access at image-build time and also
# ensures the same playwright version is available at runtime for web-session providers.
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright

# Install Playwright browser binaries + OS dependencies under root, then hand
# ownership of the browsers cache to the node user.
# PLAYWRIGHT_BROWSERS_PATH overrides the default ~/.cache/ms-playwright so the
# browsers land under /home/node which persists across image layers and is
# accessible to the non-root runtime user.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && node node_modules/playwright/cli.js install chromium --with-deps \
  && chown -R node:node /home/node/.cache \
  && rm -rf /var/lib/apt/lists/*

USER node

FROM runner-base AS runner-cli

# Drop back to root briefly so we can install system + global npm packages,
# then return to the `node` non-root user before the CMD inherited from
# runner-base runs.
USER root

# Install system dependencies required by openclaw (git+ssh references).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates docker.io docker-compose \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system url."https://github.com/".insteadOf "ssh://git@github.com/"

# Install CLI tools globally. Separate layer from apt for better cache reuse.
RUN --mount=type=cache,target=/root/.npm \
  npm install -g --no-audit --no-fund @openai/codex @anthropic-ai/claude-code droid openclaw@latest

USER node
