# Multi-stage build for the codemaster TypeScript backend. ONE image, ONE process: the combined entrypoint
# (apps/backend/src/main.ts) runs the HTTP API + the Postgres background runtime (review-job runner +
# scheduler + outbox-drain loops) in a single fail-loud process. The migrate Job overrides `command`.
# Debian base (NOT alpine) — @node-rs/argon2 is a native (glibc) addon.
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Registry fetches through the Docker Desktop VM NAT flake under load (ECONNRESET observed 3x,
# 2026-06-11): retry hard with long timeouts, and persist the npm tarball cache across builds
# (BuildKit cache mount) so a retry/rebuild RESUMES from cached tarballs instead of re-pulling
# the whole tree — the long single-shot download is exactly what keeps getting reset.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY libs ./libs
COPY apps ./apps
COPY scripts ./scripts
# tsc -> dist/, then copy the vendored tree-sitter .wasm grammars into dist (tsc emits only .js).
RUN npm run build
# Prune devDependencies HERE (after the build that needs them) so the runtime stage COPYs an
# already-slim node_modules — one layer, not the old COPY-full-then-prune which left BOTH the full
# tree AND the prune-rewrite layer in the image (~800MB of duplicated node_modules). prune is offline
# (no registry round-trip), deterministic against the same lockfile.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# git: the review cloner (GitSubprocessCloner) shells out to `git clone/fetch/checkout` — a HARD runtime
# dependency, absent from node:*-slim. ca-certificates: TLS trust for the HTTPS clone. curl: fetch the
# static-analysis release binaries below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# ── Tier-1 deterministic static-analysis binaries (1:1 with the frozen Python image, vendor/.../Dockerfile) ──
# The review's in-worker runners spawn `ruff` / `gitleaks` / `eslint` BY NAME; if absent the spawn fails
# (ENOENT → SubprocessLaunchError → failed_startup) and the whole deterministic linter + secret-scan layer
# silently disappears, leaving LLM-only reviews. Pinned versions; each install ends in a --version verify so
# a silent registry-side regression fails the build.
ARG RUFF_VERSION=0.6.9
ARG GITLEAKS_VERSION=8.18.4
ARG ESLINT_VERSION=10.4.1
# TARGETARCH is auto-supplied by BuildKit (amd64 on prod x86, arm64 on Apple-Silicon kind). Map it to each
# tool's release-asset arch tag so the image is multi-arch (a hardcoded x86_64 binary crashes on arm64 with
# "rosetta error … exit 133" at the --version verify). ruff: standalone release binary (node:*-slim has no
# python/pip, so NOT `pip install ruff`). gitleaks: pinned release tarball.
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) RUFF_ARCH=x86_64; GL_ARCH=x64 ;; \
      arm64) RUFF_ARCH=aarch64; GL_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/astral-sh/ruff/releases/download/${RUFF_VERSION}/ruff-${RUFF_ARCH}-unknown-linux-gnu.tar.gz" -o /tmp/ruff.tar.gz; \
    tar -xzf /tmp/ruff.tar.gz -C /tmp; \
    find /tmp -maxdepth 2 -type f -name ruff -exec mv {} /usr/local/bin/ruff \; ; \
    rm -rf /tmp/ruff.tar.gz /tmp/ruff-*; \
    chmod +x /usr/local/bin/ruff; \
    ruff --version; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GL_ARCH}.tar.gz" -o /tmp/gitleaks.tar.gz; \
    tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks; \
    rm /tmp/gitleaks.tar.gz; \
    chmod +x /usr/local/bin/gitleaks; \
    gitleaks version
# eslint: the bundled flat config (config/static_analysis/eslint/eslint.config.mjs) is plugin-FREE
# (built-in rules only), so the eslint binary alone suffices. Installed GLOBALLY (on PATH) because the
# review repo's own eslint is a devDependency that `npm ci --omit=dev` strips.
RUN npm install -g "eslint@${ESLINT_VERSION}" \
  && eslint --version
# All /app COPYs use --chown=1001:1001 to set runtime-user ownership AT COPY TIME. A separate
# `chown -R /app` would instead REWRITE every file (the 812MB node_modules + dist) into a NEW layer
# — duplicating /app in the image (~800MB). Numeric --chown needs no pre-existing user. The process
# never writes to /app at runtime (read-only root FS); only the volume-mounted scratch dirs below.
COPY --chown=1001:1001 package.json package-lock.json ./
# Reuse the BUILD stage's node_modules — already devDep-pruned there (above) — instead of a second
# full `npm ci`: BuildKit would otherwise run the two stages CONCURRENTLY and the doubled registry
# traffic through Docker Desktop's NAT reliably ECONNRESETs one ~10 min in (observed 2026-06-11).
# COPYing the pruned tree gives a SINGLE slim node_modules layer. The native addon (@node-rs/argon2)
# was compiled in the SAME base image, so the copied tree is ABI-identical.
COPY --from=build --chown=1001:1001 /app/node_modules ./node_modules
# Flatten the compiled tree into /app so the package.json "imports" map (#backend/* -> ./apps/backend/src/*,
# which tsc keeps VERBATIM in the emitted .js) resolves against the compiled .js. node_modules at /app
# resolves by walk-up from /app/apps/backend/src/*.js.
COPY --from=build --chown=1001:1001 /app/dist/ ./
# Raw SQL migrations for the node-pg-migrate job (tsc does not process .sql).
COPY --chown=1001:1001 migrations ./migrations
# ── Non-root runtime user (uid/gid 1001) ──────────────────────────────────────
# The process writes ONLY to CODEMASTER_WORKSPACE_ROOT, CODEMASTER_CLONE_CACHE_ROOT and (transiently)
# /tmp — never to /app, $HOME or the tool dirs. So it runs as a non-root user with a read-only root
# filesystem; the Helm chart mounts those scratch paths as writable emptyDir volumes. /app is already
# 1001-owned (the --chown COPYs above); here we only create + own the small writable dirs + $HOME.
RUN groupadd --gid 1001 codemaster \
  && useradd --uid 1001 --gid 1001 --home-dir /home/codemaster --create-home --shell /usr/sbin/nologin codemaster \
  && mkdir -p /var/lib/codemaster/workspaces /clone-cache \
  && chown -R 1001:1001 /home/codemaster /var/lib/codemaster /clone-cache
ENV HOME=/home/codemaster
USER 1001
EXPOSE 8080
# Default = the combined entrypoint (HTTP API + the Postgres background runtime, fail-loud, one
# process). The migrate Job overrides `command` with `npm run migrate:up`.
CMD ["node", "apps/backend/src/main.js"]
