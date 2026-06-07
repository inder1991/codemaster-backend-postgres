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
# dependency, absent from node:*-slim. ca-certificates: TLS trust for the HTTPS clone to the GitHub host.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
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
