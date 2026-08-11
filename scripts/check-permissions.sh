#!/bin/sh
set -e

# ── Memory limit override ──────────────────────────────────────────────
# If OMNIROUTE_MEMORY_MB is set, build NODE_OPTIONS dynamically so the
# user can tune heap size via environment without editing the Dockerfile.
if [ -n "$OMNIROUTE_MEMORY_MB" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${OMNIROUTE_MEMORY_MB}"
fi

# Hard Rule #13: never interpolate OMNIROUTE_BASE_PATH (or any runtime path)
# into sed/awk/shell. The Node guard reads process.env itself — invoke with a
# fixed argv only; do not pass the subpath as a CLI argument or script body.
if [ -f docker/ensure-docker-base-path.mjs ]; then
  node docker/ensure-docker-base-path.mjs || exit 1
fi

DATA_PATH="${DATA_DIR:-/app/data}"

# ── Data volume ownership ──────────────────────────────────────────────
# Docker named volumes and Railway volumes mount as root, while the app
# runs as the non-root `node` user (UID/GID 1000). The Dockerfile's final
# USER is root so this entrypoint can fix the mount before dropping
# privileges below. Idempotent and cheap for a small SQLite volume; also
# repairs files written while the service briefly ran as root
# (RAILWAY_RUN_UID=0).
if [ "$(id -u)" = "0" ]; then
  if [ -e "$DATA_PATH" ]; then
    chown -R node:node "$DATA_PATH" 2>/dev/null || true
    chmod -R u+rwX "$DATA_PATH" 2>/dev/null || true
  fi
  if [ -d "$DATA_PATH" ] && [ "$(stat -c '%u' "$DATA_PATH" 2>/dev/null)" != "1000" ]; then
    echo "WARNING: $DATA_PATH still not owned by node (UID 1000) after chown — check the volume mount."
  fi
else
  # Non-root invocation (docker run --user, Kubernetes runAsNonRoot, ...):
  # cannot chown, so warn and let the operator fix the mount on the host.
  if [ -d "$DATA_PATH" ] && [ ! -w "$DATA_PATH" ]; then
    echo "WARNING: $DATA_PATH is not writable by the current user (UID $(id -u))."
    if [ "${CONTAINER_HOST:-}" = "podman" ]; then
      echo "Podman bind-mount permissions depend on whether the engine is local or"
      echo "reached through Podman Machine; this container cannot determine that topology."
      echo "Use the host-side fix for your topology:"
      echo "  https://github.com/diegosouzapw/OmniRoute/blob/main/contrib/podman/README.md#data-directory-permissions-by-topology"
    else
      echo "Run this on the Docker host to fix (using the host-side bind-mount path):"
      echo "  sudo chown -R $(id -u):$(id -g) <host-data-dir>"
      echo "  chmod -R u+rwX <host-data-dir>"
    fi
  fi
fi

# ── Drop privileges ────────────────────────────────────────────────────
# The image's final USER is root so this entrypoint could fix the volume;
# hand the actual server process to the `node` user before exec'ing CMD.
# setpriv ships in util-linux (present in Debian bookworm-slim).
if [ "$(id -u)" = "0" ]; then
  echo "[check-permissions] volume ready; dropping to node (UID 1000): $*"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
