# ADR-0066: Temporal-TS workflow bundle + payload converter must not import `node:crypto`

- Status: Accepted
- Date: 2026-06-04
- Deciders: backend platform (Python→TypeScript migration)
- Related: Phase-2.0 Temporal-TS walking skeleton; ADR-0047 (single typed activity input); ADR-0051
  (provenance-backed evidence / `mintEvidenceId`); ADR-0062 (Postgres connection-pool lifecycle);
  frozen `vendor/codemaster-py/codemaster/review/` per-chunk closures.

> NOTE on numbering: this ADR was authored for the slug
> `temporal-ts-workflow-bundle-crypto-boundary`. Number `0065` was already taken in this repo by
> `0065-magika-model-divergence.md`, so this ADR is filed as `0066` to avoid clobbering an accepted
> ADR.

## Context

The Python→TypeScript backend port (see MEMORY: "Python→TypeScript backend migration") is bringing up
the review pipeline on the Temporal TypeScript SDK. Temporal runs **workflow** code inside an isolated
V8 sandbox (a webpack-bundled isolate) to guarantee deterministic replay. That sandbox **bans a set of
Node builtins** — `node:crypto` among them — because they introduce non-determinism (random bytes,
native bindings) that would break replay.

Two of our ported Zod contracts import `node:crypto` for their deterministic-id minting helpers:

- `libs/contracts/src/diff_chunking.v1.ts` — `computeChunkId` (uuid5 over chunk identity, SHA-1 via
  `node:crypto.createHash`).
- `libs/contracts/src/retrieved_evidence.v1.ts` — `mintEvidenceId` / `buildRetrievedEvidence`
  (uuid5-derived `ev_*` ids, per ADR-0051).

(The repo `apps/backend/.../review_findings_repo.ts` also imports `node:crypto` for its `uuid5`
`deriveReviewFindingId` — but the repo runs in ACTIVITY context, never the sandbox, so it is unaffected.)

These minting helpers are `node:crypto`-of-a-hash form (deterministic content-addressing, NOT
randomness — they are outside the clock/random gate's scope), but the **sandbox bans the `node:crypto`
module wholesale regardless of how it is used**. A workflow module that transitively imports either
contract for its VALUES would fail to bundle.

The frozen-Python design already isolates minting to activity context: the per-chunk closure structure
mints `ev_*` ids and chunk ids INSIDE activities, never in the workflow body — the workflow only fans
work out to activities and fans results in. The TS port must preserve that boundary.

## Decision

**The Temporal workflow bundle — every module reachable from a `workflowsPath` entry — AND the payload
converter module (`apps/backend/src/worker/data_converter.ts`, loaded into both the main thread
and the sandbox via `dataConverter.payloadConverterPath`) MUST NOT (transitively) import `node:crypto`
or any other sandbox-illegal module.**

Concretely, in the Phase-2.0 skeleton:

- `review_skeleton.workflow.ts` imports ONLY `@temporalio/workflow` and the **type-only**
  input/output shapes from `#contracts/persist_review_findings.v1.js`. With `verbatimModuleSyntax`
  (tsconfig) a `import type { ... }` is ERASED at emit, so no runtime edge to the contract is created.
  `persist_review_findings.v1` is itself crypto-free (its transitive contract graph —
  `aggregated_findings` → `review_findings`, `finding_policy_metadata`, `resolved_guidance` — contains
  no `node:crypto` import), so even a value import would bundle; the type-only discipline keeps the
  rule structurally enforced regardless.
- `data_converter.ts` imports ONLY `@temporalio/common` and exports the stock `JsonPayloadConverter`
  as `payloadConverter`. No contract module, no `node:crypto`.
- All minting / hashing / DB writes live in the ACTIVITY layer
  (`activities/persist_review_findings.activity.ts` → the repo), which runs in the normal Node runtime
  where `node:crypto` is fully available. This mirrors the frozen-Python per-chunk-closure structure
  that isolates minting to activity context.

For the future fan-out (Phase 2.1+): when chunk-id / evidence-id minting is needed, it runs in
ACTIVITIES (which return the minted ids to the workflow as plain wire values), NEVER in the workflow
body or the converter.

## Enforcement

`scripts/check_workflow_bundle.ts` is the build-time proof, WITHOUT a running Temporal server. It calls
`bundleWorkflowCode({ workflowsPath: require.resolve(".../review_skeleton.workflow") })`, which runs the
SDK's webpack bundler over the workflow graph. The bundler refuses sandbox-illegal builtins, so a
transitive `node:crypto` import makes bundling fail loudly (non-zero exit); a clean exit 0 proves the
boundary holds. Run it via `npx tsx scripts/check_workflow_bundle.ts`.

FOLLOW-UP: promote `check_workflow_bundle.ts` into `scripts/gates/` (wired into `run_all.ts`, hence
`make validate-fast`) once Phase 2.1 adds more workflows — bundling is heavier than the AST gates, so
it stays a standalone manual/CI check until there is more than one workflow to guard. Until then the
type-only-import discipline in the workflow module + this ADR are the standing contract.

## Consequences

- The skeleton (and every future workflow) is provably sandbox-safe at build time, with no Temporal
  server required — the same offline-verifiability the parity oracle gives the pure ports.
- Engineers adding a workflow MUST keep contract imports type-only (or import only crypto-free
  contracts for values) and MUST keep minting in activities. The bundle self-check catches a violation
  the moment it is introduced.
- The payload converter is constrained to the same boundary because Temporal imports it into the
  sandbox too — a future bespoke `CompositePayloadConverter` must stay crypto-free / deterministic.
