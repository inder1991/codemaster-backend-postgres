# ADR-0075: Confluence ingest subsystem port — dependencies, worker topology, deferrals

- **Status:** Accepted
- **Date:** 2026-06-08
- **Related:** CLAUDE.md Invariant 1 (background work off the review spine), "No new dependencies
  without justification" guardrail; ADR-0074 (Schedule bootstrap seam); ADR-0059 (embeddings
  consumer); the frozen Python `ingest/confluence/*`, `integrations/confluence/*`,
  `workflows/confluence_sync_workflow.py`. Project-owner decisions recorded 2026-06-08.

## Context

The TypeScript port has the Confluence RETRIEVAL side fully ported + wired into HybridRetriever, but
the INGEST (producer) side is unported — which is why the live Confluence corpus is empty. Wave 4
ports the producer stack (~4000 LoC: client + token_provider + chunker + sanitizer + redactor +
injection_patterns + hard_limits + 2 repos + 7 activities + 3 workflows). The TS baseline migration
(`migrations/0001_baseline.sql`) already carries every ingest column (`content_sha256`, `labels`,
`quarantined`/`quarantine_reasons`, `token_count`, `default_approval`, `deleted_at`/`superseded_at`,
`embedding vector(1024)`) + `confluence_page_approvals` + `integrations`, so the port is **code-only —
no migration**.

Two decisions require project-owner sign-off under CLAUDE.md's own rules; both were made 2026-06-08.

## Decision 1 — New dependencies (approved)

Faithful 1:1 chunk/sanitize parity requires two libraries the codebase does not have:

- **`js-tiktoken`** (cl100k_base BPE tokenizer). The Python chunker measures + bounds chunks by
  cl100k_base token count (`count_tokens`); the chunk-overlap windows (400/600/800-token targets) are
  defined in token space. The review-pipeline chunker uses a *heuristic* token estimate — NOT reusable
  here, because a divergent tokenizer silently shifts every chunk boundary, producing different
  embeddings and different retrieval results. `js-tiktoken` reproduces the exact boundaries.
- **`sanitize-html`** (a `bleach`-equivalent HTML allowlist sanitizer). The production
  `sanitize_page_activity` runs `bleach`-style allowlist sanitization over the Confluence storage-format
  HTML; a regex-only strip would diverge from the Python allowlist on the corpus the review LLM cites.

The HTTP client reuses Node's native `fetch` (no third dependency). These are added to `package.json`
+ `package-lock.json`; they are NOT spine-path deps (the ingest subsystem is background work), but are
recorded here per the guardrail.

**Rejected alternative:** heuristic token-estimate + regex HTML-strip (zero new deps) — rejected because
it makes the ingested corpus non-faithful to the frozen Python, defeating the point of the port.

## Decision 2 — Worker topology: reuse the combined-pod review worker (Invariant-1 exception)

The frozen Python runs Confluence ingest on a **dedicated `confluence-sync` task queue + worker pool**
(F-39 explicitly moved it OFF `review-default` to keep heavy/long ingest off the review hot loop), per
**CLAUDE.md Invariant 1** (background work runs on different task queues + worker pools than the review
spine).

The TS port's standing project-owner directive is **"reuse the combined-pod review worker, no separate
ingest worker"** (the same decision that placed the reconcile/repair workflows and the Wave-1 liveness
schedules on `review-default`). The project owner confirmed this applies to Confluence ingest too: the
3 Confluence workflows are re-exported from `all_workflows.ts` (the combined-pod review worker's single
`workflowsPath` bundle), their activities registered in `build_activities.ts`, and the sync + mark-stale
schedules target `review-default`.

**This is a deliberate, owner-approved exception to Invariant 1**, accepted because the TS deployment is
a single combined pod (one process: API + review worker + outbox-dispatcher + now Confluence ingest).
Mitigations: per-page + per-space fail-open isolation (a slow/broken space cannot stall the cycle);
sequential (not fan-out) per-page processing bounds concurrency; the Temporal Schedule `overlap=SKIP`
prevents cycle pile-up. **If Confluence ingest later starves the review queue, the documented remedy is
to split it onto a dedicated `confluence-sync` worker pool** (the faithful Python topology) — the
workflow/activity code is queue-agnostic, so only the bundle + schedule target change.

## Deferrals (faithful divergences, tracked)

- **Embedder generation layer** — ship `embedderCache=null`: `chunk_and_embed` embeds each chunk via the
  existing embeddings port and writes the legacy `confluence_chunks.embedding` column ONLY (no
  `chunk_embeddings` dual-write). Tracked under `FOLLOW-UP-embedder-cache-worker-composition` (the same
  follow-up covering the 3 retrieval-side cache=null sites).
- **`platform_config_cache`** — not ported; hard-limit (25 chunks / 50 000 tokens per space) and
  mark-stale (180-day default / 90-day security_policy) thresholds are inlined as spec-pinned fallbacks
  (the same pattern `review_run_reaper` + `retrieve_knowledge` already use). Tracked under
  `FOLLOW-UP-platform-config-cache`.
- **Admin write routes** (page-approvals CRUD, quarantined-chunks read, the TriggerPageResync
  admin-trigger) — deferred per the backend-first directive. The `TriggerPageResyncWorkflow` body IS
  ported (startable via the dispatcher seam); the admin route that enqueues it defers with the rest of
  the admin console.
- **Schedule cadence** — Python uses `ScheduleIntervalSpec(every=6h/24h)` (floats from creation);
  `ensureCronSchedule` is extended with an interval variant to preserve floating-interval semantics
  (rather than a wall-clock-anchored cron approximation).

## Release gate (non-negotiable)

Per the live-untested history (the Python client shipped 6 bugs found only against real Atlassian Cloud:
Bearer-vs-Basic auth, `/wiki` base_url, spaceId-vs-spaceKey, inline-vs-dedicated `/labels`, config_json
JSONB deserialization, 800-vs-512-token chunking), the `ConfluenceClient` + end-to-end ingest MUST be
**live-Cloud smoke-validated (user-gated)** before being declared production-ready — cassette replay
proves shape parity, not live correctness.
