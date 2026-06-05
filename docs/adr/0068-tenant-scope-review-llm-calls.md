# ADR-0068: Tenant-scope the review LLM calls (TS divergence from platform-scoped frozen Python)

- Status: Accepted
- Date: 2026-06-05
- Deciders: project owner + backend platform (Python→TypeScript migration)
- Related: ADR-0060 (purpose→model selection; `installation_id` deprecated on the role axis), ADR-0062
  (Postgres connection-pool lifecycle / shared-pool Kysely seam), frozen
  `vendor/codemaster-py/codemaster/integrations/llm/client.py::LlmClient.invoke_model`,
  `apps/backend/src/backend/integrations/llm/client.ts`,
  `apps/backend/src/backend/review/review_activity.ts`,
  `apps/backend/src/backend/cost/postgres_enforcer.ts` (the `ZERO_UUID` global-scope sentinel),
  `telemetry.llm_calls` (TENANT_SCOPED_TABLES)

## Context

The Python→TypeScript backend port re-implements the review pipeline 1:1 against the frozen Python
source-of-truth. The frozen `LlmClient.invoke_model` treats `installation_id` as an OPTIONAL,
deprecated, IGNORED parameter: when a caller omits it, the client substitutes a fixed sentinel
(`TELEMETRY_MISSING_INSTALLATION_ID`, the all-ones UUID) and proceeds. The review-chunk activity
(`_do_review`) does NOT pass an installation id, so EVERY production review LLM call in the frozen
Python is effectively **platform-scoped**: its cost-cap accounting, its blob-archive key, and its
`telemetry.llm_calls` + Langfuse rows are all attributed to the platform sentinel rather than to the
installation whose PR is being reviewed.

That platform-scoping has three concrete downsides for a multi-org platform (codemaster serves 60+
GitHub orgs):

1. **Per-org cost caps cannot protect a noisy installation.** The per-org daily cap
   (`DEFAULT_PER_ORG_CAP_CENTS`) only bites when review spend is charged to the org's
   `installation_id`. If all review spend lands on the platform sentinel, a single noisy installation
   can exhaust the GLOBAL cap and there is no per-org throttle that fires first.
2. **Blob / telemetry / Langfuse attribution under the all-ones UUID degrades incident response,
   billing, and SLOs.** When every review call's forensic archive and cost-telemetry row carries the
   sentinel, "which installation drove this spike / this unsafe output / this latency regression?" is
   unanswerable from the telemetry alone.
3. **Platform-scope is meant for genuine platform jobs** (housekeeping, walkthrough, eval) — not for
   the per-installation core review loop.

## Decision

**The TypeScript port TENANT-SCOPES the review LLM calls.** This is an INTENTIONAL divergence from the
frozen Python, approved by the project owner. Concretely:

1. **`LlmClient.invokeModel` makes `installationId` a REQUIRED argument** (no `?? sentinel` fallback).
   A caller cannot silently omit it. The real id flows to:
   - the cost-cap (`checkOrRaise` / `recordCallCost`) — so per-org isolation actually applies;
   - the blob `put` — so the request/response archive is keyed by the real installation;
   - the `telemetry.llm_calls` INSERT and the Langfuse `BedrockTraceV1` — so cost, incident-response,
     billing, and SLO attribution are correct.

   TS hardening divergence (ADR-0068) — Python keeps `installation_id` optional/ignored and falls back
   to the all-ones sentinel; TS requires it.

2. **`doReview` passes `installationId: context.installation_id`** (the real tenant id carried on every
   `ReviewContextV1`) 1:1 to `invokeModel`. The review loop is tenant-scoped end to end.

3. **A separate, EXPLICIT platform-scope path is preserved for genuine internal/platform jobs.**
   `client.ts` exports `PLATFORM_INVOCATION_INSTALLATION_ID` (= `ZERO_UUID`,
   `"00000000-0000-0000-0000-000000000000"`, the cost-cap's global-scope sentinel). A platform job
   OPTS IN to platform-scope by passing this constant explicitly. Normal review calls can never
   accidentally charge their spend / attribution to the platform sentinel, because there is no implicit
   fallback — omission is a compile error.

4. **The all-ones `TELEMETRY_MISSING_INSTALLATION_ID` is retained ONLY as a defensive last-resort
   normalization for an empty-string id** (a wiring bug that production never produces), so a malformed
   empty value never charges spend or archives under an empty key. It is no longer reachable on any
   normal path.

The `telemetry.llm_calls` table is in `TENANT_SCOPED_TABLES`; the writer's INSERT already binds
`installation_id` explicitly (the raw-SQL gate's "installation_id token in the SQL" escape hatch). This
ADR does NOT add a new ledger table — it changes WHICH installation id the existing tenant-scoped
ledger records (the real tenant id, not the platform sentinel) for review calls.

## Rationale (project-owner decision, verbatim)

> "Pass real installation_id. Per-org cost caps cannot protect a noisy installation if all review spend
> is charged to the platform sentinel; blob/telemetry/Langfuse attribution under all-ones UUID makes
> incident response/billing/SLOs worse. Platform-scope should be reserved for genuine platform jobs.
> Make the divergence explicit in an ADR. Keep a separate explicit platform-scope path for internal
> jobs using ZERO_UUID or a named platformInvocation helper, but do not let normal review calls omit
> installationId. Add a unit test that doReview() passes context.installation_id and that the injected
> cost-cap/blob/telemetry doubles receive that exact id."

## Consequences

- **Per-org cost caps now apply to review spend.** Review calls accumulate against the org's
  `telemetry.cost_daily` per-org row, so the per-org cap throttles a noisy installation before the
  global cap. This changes runtime cost-cap behavior versus the frozen Python (the divergence is the
  point — the frozen platform-scoping was the defect).
- **Telemetry / blob / Langfuse rows for review calls now carry the real installation id.** Operators
  can answer "which installation drove this?" from telemetry. Any dashboards / alerts that previously
  keyed review LLM telemetry off the all-ones sentinel must be re-pointed at the per-installation id.
- **Genuine platform jobs must pass `PLATFORM_INVOCATION_INSTALLATION_ID` explicitly.** Forgetting it
  is a compile error (the arg is required), so a platform job cannot accidentally land in an
  installation's per-org accounting either — the scoping decision is explicit on both sides.
- **Acceptance is asserted by a unit test** (`test/unit/review/review_activity.test.ts`,
  "ADR-0068 tenant-scoping" describe): `doReview()` against a context with a tenant installation id
  distinct from BOTH sentinels drives recording cost-cap / blob / telemetry doubles, and the test
  asserts each double received THAT EXACT id and NOT `PLATFORM_INVOCATION_INSTALLATION_ID`.

## Divergence risk

- This is a behavioral divergence from the byte-faithful port: the observable cost-cap accounting and
  the telemetry/blob/Langfuse attribution differ from the frozen Python for review calls. The
  divergence is contained to the `installation_id` THREADED through these side-effects — the
  PARITY-CRITICAL invoke transform (content extraction, token usage, output-safety, the
  `LlmInvokeResultV1` build) is untouched, so the activity's RETURN shape (`ReviewChunkResponseV1`) is
  byte-identical to the frozen Python. The dual-run parity oracle remains valid for the review-output
  surface; only the off-observable-path attribution diverges, by design.
- The risk is mitigated by (a) the required-arg compile-time guard, (b) the explicit platform-scope
  opt-in helper, and (c) the unit-test acceptance above. The frozen Python remains the reference for
  the pure transform; THIS ADR is the record of the deliberate, owner-approved attribution divergence.

---

## Addendum: NARROW LLM-invocation idempotency ledger (second ADR-0068 divergence)

- Related: `core.llm_invocation_ledger` (TENANT_SCOPED_TABLES), migration
  `migrations/0003_llm_invocation_ledger.sql`,
  `apps/backend/src/backend/integrations/llm/invocation_ledger.ts`,
  `apps/backend/src/backend/integrations/llm/client.ts` (the `idempotency` arg + `ledger` collaborator),
  `apps/backend/src/backend/review/review_activity.ts` (the `REVIEW_TOOL_SCHEMA_VERSION` + idempotency
  context), `test/integration/llm/llm_invocation_ledger.integration.test.ts`.

### Context

The frozen Python `LlmClient.invoke_model` ALWAYS calls the Bedrock SDK — the SDK call is the only
non-repeatable, **paid** edge, and Python repeats it on every retry. The review-chunk LLM call runs
inside a Temporal activity, so a post-call persistence failure (telemetry / blob / finding write throws
after the completion came back) + the activity's automatic retry buys a **second paid completion** for
the same logical work. Across 60+ orgs and thousands of repos, that duplicate-paid-call class is a real
spend leak, not a theoretical one.

### Decision

**The TypeScript port adds a NARROW, owner-approved LLM-invocation idempotency ledger.** It is the
smallest durable record that makes the paid provider call idempotent — explicitly NOT a generic outbox.

1. **A new table `core.llm_invocation_ledger`** (TS divergence — the frozen Python has no ledger):
   `idempotency_key text PRIMARY KEY`, `installation_id uuid NOT NULL`, `review_id`, `chunk_id`,
   `role`, `model`, `prompt_sha256`, `tool_schema_version`, `provider_response jsonb NOT NULL`,
   `created_at`. Tenant-scoped (registered in `TENANT_SCOPED_TABLES`; every statement filters on
   `installation_id`).
2. **A stable idempotency key from the deterministic activity inputs** (owner decision verbatim):
   `sha256(review_id ∥ chunk_id ∥ role ∥ model ∥ prompt_sha256 ∥ tool_schema_version)`. Same inputs →
   same key, across processes and retries — the property that lets a retry find the prior record.
3. **`LlmClient.invokeModel` gains an OPTIONAL `idempotency` arg + an OPTIONAL injected `ledger`.** When
   BOTH are present, the client probes the ledger FIRST: on a **HIT** it REPLAYS the stored
   `provider_response` and **SKIPS the paid SDK call entirely**; on a **MISS** it calls the SDK, then
   `store`s the raw provider response (`INSERT ... ON CONFLICT DO NOTHING`, so a racing retry is a safe
   no-op) **BEFORE returning**. When either is absent (platform jobs / unit tests), the client behaves
   exactly as the frozen Python — invoke, no ledger.
4. **Telemetry + Langfuse stay as replayable side effects against the stored result.** The post-call
   transform, output-safety, telemetry row, and Langfuse export all run on the replayed response, so
   observability stays correct on a retry. The provider invocation is the ONLY non-repeatable edge.
5. **`doReview` always passes the idempotency context** (`reviewId = context.pr_id`,
   `chunkId = context.chunk.chunk_id`, `toolSchemaVersion = REVIEW_TOOL_SCHEMA_VERSION`). `ReviewContextV1`
   carries `pr_id` (the PR/review identity — there is no separate `review_id` field) and `chunk.chunk_id`
   (the deterministic per-chunk id). The client only acts on the context when a ledger is wired.

### Rationale (project-owner decision, verbatim)

> "Add idempotency now, but scope it narrowly. Generate a stable idempotency key from deterministic
> activity inputs: review_id + chunk_id + role + model + prompt hash + tool schema version. Persist the
> raw provider response and parsed result before returning. On retry, check the idempotency record first
> and return/replay the stored result instead of invoking Bedrock. Keep telemetry/Langfuse as
> retryable/replayable side effects against the stored result. Make provider invocation the only
> non-repeatable paid edge. Do NOT build a broad generic outbox yet — build the smallest LLM invocation
> ledger that prevents duplicate paid calls. Document as an intentional TS hardening divergence from
> Python."

### tool_schema_version source

`REVIEW_TOOL_SCHEMA_VERSION` (in `review_activity.ts`) is a content-addressable digest:
`rfs-${sha256(JSON.stringify([REVIEW_TOOL_SCHEMA, ARBITRATION_INTENT_TOOL_SCHEMA])).slice(0,16)}`. When
the tool schema changes — which changes the SHAPE of the LLM's structured output and therefore the parse
— the digest changes, so a stale stored response under the old schema is NOT replayed. A bare constant
string would NOT invalidate on a schema change; the digest does.

### Production wiring (follow-up)

`LlmInvocationLedger.fromDsn(dsn)` is the REAL production entry point (over the ADR-0062 shared pool) and
is ready to inject. Wiring it into the production `LlmClientCache` client factory is the operator-facing
follow-up (consistent with how telemetry / Langfuse were de-stubbed incrementally in this file); until
then the ledger is dormant on the shipped path — the client takes the exactly-as-Python no-ledger branch,
which the dual-run parity oracle still covers. This is NOT a stub: the ledger, its SQL, and its
`fromDsn` constructor are real and DB-exercised by the integration test.

### Consequences

- **A retry no longer buys a duplicate paid completion** when the ledger is wired — the dominant spend
  leak this addendum closes.
- **Cost-cap on replay**: the replay path re-runs `recordCallCost` against the stored response. Re-applying
  internal cost accounting on a replay can slightly over-count the daily budget, but it NEVER buys a real
  completion (the external paid edge — the SDK call — is skipped). This is a deliberate narrow-scope
  trade: the dollar that matters (the Bedrock call) is saved; the internal accounting row is idempotent
  enough for the daily-budget invariant.
- **A ledger write failure is guarded** so it never masks a successful invocation; the fallback is a retry
  re-paying (the pre-ADR-0068 Python behavior), strictly no worse than before.

### Divergence risk

- The ledger is a NEW table + a NEW optional code path with no Python analogue, so the dual-run parity
  oracle does NOT cover it — coverage is the dedicated DB-gated integration test
  (`test/integration/llm/llm_invocation_ledger.integration.test.ts`): first invoke (SDK once + row
  written + result), second invoke same key (SDK NOT re-called + replay + same result + telemetry/Langfuse
  re-fire), no-idempotency invoke (SDK called, no row).
- The parity surface is preserved on the no-ledger path: with `idempotencyKey === null` the SDK
  invoke/store/replay branch collapses to the original single `createMessage` call, so the review-output
  transform is byte-identical to the frozen Python (the dual-run parity test stays green).
