# Multi-stage build for the codemaster TypeScript backend. ONE image, ONE process: the combined entrypoint
# (apps/backend/src/main.ts) runs the HTTP API + review worker + outbox-dispatcher worker in a single
# fail-loud process (the production single-pod architecture). The migrate Job overrides `command`.
# Debian base (NOT alpine) — @node-rs/argon2 + @temporalio/* gRPC core are native (glibc) addons.
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY libs ./libs
COPY apps ./apps
COPY scripts ./scripts
# tsc -> dist/, then copy the vendored tree-sitter .wasm grammars into dist (tsc emits only .js).
RUN npm run build

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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Flatten the compiled tree into /app so the package.json "imports" map (#backend/* -> ./apps/backend/src/*,
# which tsc keeps VERBATIM in the emitted .js) resolves against the compiled .js. node_modules at /app
# resolves by walk-up from /app/apps/backend/src/*.js.
COPY --from=build /app/dist/ ./
# Raw SQL migrations for the node-pg-migrate job (tsc does not process .sql).
COPY migrations ./migrations
EXPOSE 8080
# Default = the combined entrypoint (HTTP API + review worker + outbox-dispatcher worker, fail-loud, one
# process). The migrate Job overrides `command` with `npm run migrate:up`.
CMD ["node", "apps/backend/src/main.js"]
