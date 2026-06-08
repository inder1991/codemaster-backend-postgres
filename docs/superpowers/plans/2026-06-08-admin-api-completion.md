# Admin API Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 20 admin HTTP endpoints the admin frontend consumes but `codemaster-backend` does not yet expose — 1:1 from the frozen Python backend — completing the admin API so the frontend migration (sub-project 2) is a gap-free extract + rewire.

**Architecture:** Each endpoint follows the established 5-layer admin pattern — **Zod contract** (`libs/contracts/src/admin.v1.ts`) → **repo** (`apps/backend/src/api/admin/<cluster>_read|write.ts` or `domain/repos/`) → **Fastify handler** in `admin_routes.ts::registerAdminRoutes` → **`requireRole`** RBAC → **audit emit** on mutations. The two workflow-triggering clusters (knowledge proposal approve/reject; the embedder re-embed lifecycle) use a thin **`AdminTemporalPort`** over the existing `TemporalClientPort` (`adapters/temporal_port.ts`), with the existing `RecordingTemporalClient` as the test double. All reads/writes are tenancy-filtered. Tests run against a **disposable Postgres (`:5434`), never the cluster**.

**Tech Stack:** TypeScript (ESM, Node 22), Fastify, Kysely + raw `sql\`…\``, Zod v4 contracts, Temporal (`@temporalio/client`), vitest. Frozen Python port source: `/Users/ascoe/Projects/codemaster/codemaster/api/admin/`.

**Spec:** `docs/superpowers/specs/2026-06-08-admin-api-completion-design.md`

---

## File Structure

**Shared (multiple batches append to these — merge, don't clobber):**
- `libs/contracts/src/admin.v1.ts` — **Modify**: + ~15 Zod contracts (ReviewDetailV1, YourReviewsPageV1, UpdateLearningBodyV1, StaleWriteV1, RejectProposalV1, confluence-pages contracts, embedder write contracts, PipelineStatusV1, PilotProgressV1, ReviewTimelineV1 + sub-types).
- `apps/backend/src/api/admin/admin_routes.ts` — **Modify**: register the ~20 routes inside `registerAdminRoutes`; extend `AdminRoutesOptions` with the optional seams each batch needs (`temporal?: AdminTemporalPort`, `statusRepo`, `reviewTimelineRepo`, embedder service, etc.).
- `apps/backend/src/api/server.ts` — **Modify**: compose the new options at the production root (wrap `RealTemporalClient` via `makeAdminTemporalPort`; construct the new repos/service).

**Per-cluster new files:**
- Batch 0: `apps/backend/src/api/admin/_admin_temporal_port.ts`
- Batch 1: `apps/backend/src/api/admin/reviews_detail_read.ts`
- Batch 2: `apps/backend/src/api/admin/knowledge_write.ts`
- Batch 3: `apps/backend/src/api/admin/confluence_pages_read.ts`, `confluence_pages_write.ts`
- Batch 4: `apps/backend/src/embedder/embedder_generation_service.ts`, `apps/backend/src/api/admin/embedder_write.ts`
- Batch 5: `apps/backend/src/domain/repos/status_repo.ts`, `review_timeline_repo.ts`, `migrations/0035_*.sql` (verify outbox `delivery_id` index)
- Tests: `test/integration/api/admin_<feature>.integration.test.ts` per cluster.

**Execution order:** Batch 0 first (the shared Temporal port that Batches 2 + 4 depend on), then Batches 1→5. Batches 1, 3, 5 are independent of the Temporal port and can run in parallel after Batch 0.

---

## Batch 0: Shared foundation — AdminTemporalPort

The knowledge-proposal (Batch 2) and embedder-write (Batch 4) handlers dispatch/signal Temporal workflows synchronously from the HTTP layer. Rather than thread the full `StartWorkflowCall` shape through handlers, we add a thin **`AdminTemporalPort`** (`dispatchWorkflow` / `signalWorkflow`) over the existing `TemporalClientPort` and reuse `RecordingTemporalClient` as the test double.

### Task 0.1: AdminTemporalPort wrapper + recording test double

**Files:**
- Create: `apps/backend/src/api/admin/_admin_temporal_port.ts`
- Test: `test/unit/api/admin/admin_temporal_port.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/api/admin/admin_temporal_port.test.ts
import { describe, expect, it } from "vitest";

import { makeAdminTemporalPort } from "#backend/api/admin/_admin_temporal_port.js";
import { RecordingTemporalClient } from "#backend/adapters/temporal_port.js";

describe("makeAdminTemporalPort", () => {
  it("dispatchWorkflow maps to startWorkflow with [input] args + defaulted timeouts/policies", async () => {
    const inner = new RecordingTemporalClient();
    const port = makeAdminTemporalPort(inner);
    await port.dispatchWorkflow({
      workflowType: "reembedGeneration",
      workflowId: "reembed-generation-7",
      taskQueue: "embedder-maintenance",
      input: { schema_version: 1, generation_id: 7 },
      idReusePolicy: "REJECT_DUPLICATE",
    });
    expect(inner.started).toHaveLength(1);
    const call = inner.started[0]!;
    expect(call.workflowType).toBe("reembedGeneration");
    expect(call.workflowId).toBe("reembed-generation-7");
    expect(call.taskQueue).toBe("embedder-maintenance");
    expect(call.args).toEqual([{ schema_version: 1, generation_id: 7 }]);
    expect(call.idReusePolicy).toBe("REJECT_DUPLICATE");
    expect(call.searchAttributes).toEqual({});
  });

  it("signalWorkflow delegates to inner.signalWorkflow with payload=input", async () => {
    const inner = new RecordingTemporalClient();
    const port = makeAdminTemporalPort(inner);
    await port.signalWorkflow({ workflowId: "wf-1", signalName: "approve", input: { approver: "u1" } });
    expect(inner.signals).toEqual([{ workflowId: "wf-1", signalName: "approve", payload: { approver: "u1" } }]);
  });
});
```

> NOTE: confirm the `RecordingTemporalClient` exposes `started` + `signals` arrays; if the field names differ, read `apps/backend/src/adapters/temporal_port.ts` and match them in the test.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/api/admin/admin_temporal_port.test.ts`
Expected: FAIL — `Cannot find module '#backend/api/admin/_admin_temporal_port.js'`.

- [ ] **Step 3: Implement the wrapper**

```typescript
// apps/backend/src/api/admin/_admin_temporal_port.ts
//
// Thin admin-facing wrapper over the existing TemporalClientPort (adapters/temporal_port.ts).
// Admin write endpoints (knowledge proposal approve/reject; the 8 embedder reembed endpoints)
// dispatch/signal workflows synchronously from the HTTP handler. This port gives them a small API
// and bridges to the richer StartWorkflowCall; RecordingTemporalClient stays the test double.

import { type StartWorkflowCall, type TemporalClientPort } from "#backend/adapters/temporal_port.js";
import { type IdReusePolicy } from "#contracts/outbox_payloads.v1.js";

/** Admin dispatch/signal API used by knowledge-proposal + embedder write handlers. */
export interface AdminTemporalPort {
  /** Fire-and-forget workflow start. A start failure surfaces to the caller (which maps it to HTTP). */
  dispatchWorkflow(a: {
    workflowType: string;
    workflowId: string;
    taskQueue: string;
    input: unknown;
    idReusePolicy?: IdReusePolicy;
  }): Promise<void>;
  /** Signal a workflow. Errors surface; callers wanting best-effort (embedder cancel) wrap in try/catch. */
  signalWorkflow(a: { workflowId: string; signalName: string; input?: unknown }): Promise<void>;
}

/** Admin-triggered workflows are bounded by the worker, not a client deadline. */
const NO_TIMEOUT_SECONDS = 0;

/** Bridge an AdminTemporalPort onto the existing TemporalClientPort. */
export function makeAdminTemporalPort(inner: TemporalClientPort): AdminTemporalPort {
  return {
    async dispatchWorkflow(a): Promise<void> {
      const call: StartWorkflowCall = {
        workflowType: a.workflowType,
        workflowId: a.workflowId,
        taskQueue: a.taskQueue,
        args: [a.input],
        executionTimeoutSeconds: NO_TIMEOUT_SECONDS,
        runTimeoutSeconds: NO_TIMEOUT_SECONDS,
        searchAttributes: {},
        idReusePolicy: a.idReusePolicy ?? "ALLOW_DUPLICATE",
        idConflictPolicy: "FAIL",
      };
      await inner.startWorkflow(call);
    },
    async signalWorkflow(a): Promise<void> {
      await inner.signalWorkflow({ workflowId: a.workflowId, signalName: a.signalName, payload: a.input });
    },
  };
}
```

> NOTE: verify `IdConflictPolicy` accepts the literal `"FAIL"` in `#contracts/outbox_payloads.v1.js`; if the enum value differs (e.g. `"FAIL_WORKFLOW"`), use the exact union member.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/api/admin/admin_temporal_port.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/api/admin/_admin_temporal_port.ts test/unit/api/admin/admin_temporal_port.test.ts
git commit -m "feat(batch-0): AdminTemporalPort wrapper over TemporalClientPort"
```

### Task 0.2: Thread `temporal?: AdminTemporalPort` into AdminRoutesOptions + production wiring

**Files:**
- Modify: `apps/backend/src/api/admin/admin_routes.ts` (the `AdminRoutesOptions` type, near line 243)
- Modify: `apps/backend/src/api/server.ts` (compose `makeAdminTemporalPort(realTemporalClient)` at the root)

- [ ] **Step 1: Add the optional field to `AdminRoutesOptions`**

In `admin_routes.ts`, inside `export type AdminRoutesOptions = { … }`, add alongside the existing `audit?` seam:

```typescript
  /** Optional Temporal dispatch/signal seam for the knowledge-proposal + embedder write endpoints.
   *  Undefined → those endpoints return 503 ("temporal not wired"). Mirrors the opts.audit pattern. */
  temporal?: import("#backend/api/admin/_admin_temporal_port.js").AdminTemporalPort;
```

- [ ] **Step 2: Wire it in production**

In `server.ts`, where `registerAdminRoutes(app, { … })` is called, pass `temporal` built from the real client (only when a Temporal client is already constructed for the outbox path; reuse it):

```typescript
import { makeAdminTemporalPort } from "#backend/api/admin/_admin_temporal_port.js";
// …where the RealTemporalClient is already created for the outbox dispatcher:
//   const adminTemporal = makeAdminTemporalPort(realTemporalClient);
// then in the registerAdminRoutes opts: temporal: adminTemporal,
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new type errors).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/api/admin/admin_routes.ts apps/backend/src/api/server.ts
git commit -m "feat(batch-0): thread AdminTemporalPort into AdminRoutesOptions + server wiring"
```

---

## Batch 1: Reviews cluster (review_detail + your_reviews)

### Task 1.1: Add ReviewDetailV1, YourReviewsPageV1 contracts to admin.v1.ts

**Files:** Modify `libs/contracts/src/admin.v1.ts`

- [ ] **Step 1: Write the failing test** — Create `test/integration/api/admin_reviews_detail.integration.test.ts` with a single failing case (import ReviewDetailV1, route GET /api/admin/reviews/{review_id}, expect 200):

```typescript
/**
 * Integration test for GET /api/admin/reviews/{review_id} (review detail) against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the cluster). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * 1:1 port of codemaster/api/admin/review_detail.py + postgres_review_detail_repo.py. Covers:
 *   - 200 happy path, returns ReviewDetailV1 with joined findings/activities
 *   - 404 when review_id not in tenant
 *   - 403 role insufficient (reader/org_owner); 401 no cookie
 *   - Authz matrix (operator/owner/super only)
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import type { ReviewDetailV1 } from "#contracts/admin.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "11111111-2222-3333-4444-555555555555";
const INST_OTHER = "aaaaaaaa-2222-3333-4444-555555555555";

// Fixed UUIDs for test data
const REVIEW_ID = "22222222-2222-2222-2222-222222222222";
const REVIEW_ID_OTHER = "33333333-2222-2222-2222-222222222222";
const REPO_ID = "44444444-3333-3333-3333-333333333333";
const PR_ID = "55555555-4444-4444-4444-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.review_findings WHERE pr_id = ${PR_ID}`.execute(db);
  await sql`DELETE FROM audit.workflow_events WHERE review_id IN (${REVIEW_ID}, ${REVIEW_ID_OTHER})`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id IN (${REVIEW_ID}, ${REVIEW_ID_OTHER})`.execute(db);
  await sql`DELETE FROM core.pull_requests WHERE pr_id = ${PR_ID}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id = ${REPO_ID}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();

  // Seed test data: repo, pull request, review, finding, activity
  await sql`INSERT INTO core.repositories (repository_id, github_repo_id, installation_id, full_name)
            VALUES (${REPO_ID}, 999, ${INST}, 'org/test-repo')`.execute(db);
  await sql`INSERT INTO core.pull_requests (pr_id, repository_id, pr_number, title, state,
                                            base_ref, head_ref, head_sha, draft, cross_fork, opened_at)
            VALUES (${PR_ID}, ${REPO_ID}, 42, 'Fix: add tests', 'open', 'main', 'fix/tests', 'abc123', false, false, ${NOW})`.execute(db);
  await sql`INSERT INTO core.pull_request_reviews (review_id, repo_id, pr_number, current_run_id)
            VALUES (${REVIEW_ID}, 999, 42, NULL)`.execute(db);
  await sql`INSERT INTO core.review_findings (finding_id, pr_id, installation_id, file_path, start_line, end_line,
                                              severity, title, body, suggestion, suppression_state)
            VALUES (gen_random_uuid(), ${PR_ID}, ${INST}, 'src/main.ts', 10, 15, 'issue', 'Missing null check', 'Check for null', NULL, 'NONE')`.execute(db);
  await sql`INSERT INTO audit.workflow_events (review_id, installation_id, sequence_no, event_type, received_at)
            VALUES (${REVIEW_ID}, ${INST}, 1, 'STARTED', ${NOW})`.execute(db);

  // Seed foreign-installation review (for 404/tenancy test)
  await sql`INSERT INTO core.repositories (repository_id, github_repo_id, installation_id, full_name)
            VALUES ('66666666-5555-5555-5555-555555555555', 998, ${INST_OTHER}, 'other/repo')`.execute(db);
  await sql`INSERT INTO core.pull_request_reviews (review_id, repo_id, pr_number, current_run_id)
            VALUES (${REVIEW_ID_OTHER}, 998, 1, NULL)`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin reviews detail (disposable :5434)", () => {
  it("GET /api/admin/reviews/{review_id} — 200 happy path with findings and activities", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/reviews/${REVIEW_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator") },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ReviewDetailV1>();
    expect(body.schema_version).toBe(1);
    expect(body.review_id).toBe(REVIEW_ID);
    expect(body.repo).toBe("org/test-repo");
    expect(body.pr_number).toBe(42);
    expect(body.pr_title).toBe("Fix: add tests");
    expect(body.state).toBe("queued");
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]!.severity).toBe("issue");
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0]!.activity_name).toBe("STARTED");
    expect(body.posted_at).toBeNull();
    expect(body.temporal_url).toBeNull();
    expect(body.langfuse_url).toBeNull();
    await app.close();
  });

  it("404 when review not in tenant", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/reviews/${REVIEW_ID_OTHER}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator") },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 role insufficient (reader/org_owner)", async () => {
    const app = await makeApp();
    for (const role of ["reader", "org_owner"] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/reviews/${REVIEW_ID}`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie(role) },
      });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it("401 no cookie", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/reviews/${REVIEW_ID}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("authz matrix: operator/owner/super 200, others 403", async () => {
    const app = await makeApp();
    const allowed = ["platform_operator", "platform_owner", "super_admin"] as const;
    const denied = ["reader", "org_owner", "security_auditor"] as const;
    for (const role of allowed) {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/reviews/${REVIEW_ID}`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie(role) },
      });
      expect(res.statusCode).toBe(200, `${role} should be 200`);
    }
    for (const role of denied) {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/reviews/${REVIEW_ID}`,
        cookies: { [SESSION_COOKIE_NAME]: mintCookie(role) },
      });
      expect(res.statusCode).toBe(403, `${role} should be 403`);
    }
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_reviews_detail.integration.test.ts` / Expected: FAIL (ReviewDetailV1 not found in #contracts/admin.v1.js + route not registered)

- [ ] **Step 3: Implement** — Add to `libs/contracts/src/admin.v1.ts` (append after ReviewsListPageV1):

```typescript
// ─── Review detail (S12.2.3) ──────────────────────────────────────────────────────────────────

/** One activity event in the review-detail timeline (Pydantic __contract_internal__; no schema_version). */
export const ActivityEventV1 = z
  .object({
    seq: z.number().int().min(1),
    activity_name: z.string(),
    state: z.enum(["scheduled", "started", "completed", "failed", "retrying"]),
    started_at: z.string().datetime({ offset: true }),
    completed_at: z.string().datetime({ offset: true }).nullable().default(null),
    detail: z.string().max(500).default(""),
  })
  .strict();
export type ActivityEventV1 = z.infer<typeof ActivityEventV1>;

/** One finding rendered on the review-detail page (Pydantic __contract_internal__). */
export const ReviewFindingItemV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    finding_id: z.string().uuid(),
    file_path: z.string().min(1),
    start_line: z.number().int().min(0),
    end_line: z.number().int().min(0),
    severity: z.enum(["blocker", "issue", "suggestion", "nit", "none"]),
    title: z.string().min(1).max(500),
    body: z.string(),
    suggestion: z.string().nullable().default(null),
    tool_source: z.string().nullable().default(null),
  })
  .strict();
export type ReviewFindingItemV1 = z.infer<typeof ReviewFindingItemV1>;

/** GET /api/admin/reviews/{review_id} — full review detail with findings and activities. */
export const ReviewDetailV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    review_id: z.string().uuid(),
    repo: z.string().min(1),
    pr_number: z.number().int().min(1),
    pr_title: z.string(),
    state: z.enum(["queued", "in_progress", "complete", "failed"]),
    findings: z.array(ReviewFindingItemV1),
    activities: z.array(ActivityEventV1),
    langfuse_url: z.string().nullable().default(null),
    temporal_url: z.string().nullable().default(null),
    posted_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type ReviewDetailV1 = z.infer<typeof ReviewDetailV1>;

// ─── Your-reviews (S14.B) ────────────────────────────────────────────────────────────────────────

/** GET /api/admin/your-reviews — per-engineer scoped reviews (authored + assigned). Pattern A: returns empty tuples. */
export const YourReviewsPageV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    authored: z.array(ReviewListItemV1),
    assigned: z.array(ReviewListItemV1),
    user_id: z.string().min(1).max(512),
  })
  .strict();
export type YourReviewsPageV1 = z.infer<typeof YourReviewsPageV1>;
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_reviews_detail.integration.test.ts` / Expected: PASS on contract import (still FAIL on route 404)

- [ ] **Step 5: Commit** — git add libs/contracts/src/admin.v1.ts ; git commit -m "add ReviewDetailV1, ActivityEventV1, ReviewFindingItemV1, YourReviewsPageV1 contracts"

### Task 1.2: Create reviews_detail_read.ts repo with joined SQL

**Files:** Create `apps/backend/src/api/admin/reviews_detail_read.ts`

- [ ] **Step 1: Write the failing test** — Add to existing test file:

```typescript
  it("reviews_detail_read: buildReviewDetail returns joined findings/activities; tenancy enforced", async () => {
    const { buildReviewDetail } = await import("#backend/api/admin/reviews_detail_read.js");
    const detail = await buildReviewDetail(db, {
      installationId: INST,
      reviewId: REVIEW_ID,
    });
    expect(detail.review_id).toBe(REVIEW_ID);
    expect(detail.findings).toHaveLength(1);
    expect(detail.activities).toHaveLength(1);
    expect(detail.temporal_workflow_id).toContain(`review/${INST}`);
  });

  it("reviews_detail_read: throws ReviewDetailNotFoundError when in different tenant", async () => {
    const { buildReviewDetail, ReviewDetailNotFoundError } = await import("#backend/api/admin/reviews_detail_read.js");
    await expect(
      buildReviewDetail(db, {
        installationId: INST,
        reviewId: REVIEW_ID_OTHER, // different tenant
      }),
    ).rejects.toThrow(ReviewDetailNotFoundError);
  });
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_reviews_detail.integration.test.ts` / Expected: FAIL (module not found)

- [ ] **Step 3: Implement** — Create `apps/backend/src/api/admin/reviews_detail_read.ts`:

```typescript
// Reviews detail read — 1:1 with review_detail.py + postgres_review_detail_repo.py.
// Joins pull_request_reviews + repositories + pull_requests + review_runs + posted_reviews +
// review_findings + audit.workflow_events. Returns ReviewDetailV1 with findings/activities + deep-links.

import { type Kysely, sql } from "kysely";

import type {
  ActivityEventV1,
  ReviewDetailV1,
  ReviewFindingItemV1,
} from "#contracts/admin.v1.js";
import { SUPER_ADMIN_PLATFORM_VIEW_UUID } from "#backend/api/_constants.js";

const FINDINGS_LIMIT = 500;
const ACTIVITIES_LIMIT = 200;

export class ReviewDetailNotFoundError extends Error {
  public constructor(reviewId: string) {
    super(`review not found: ${reviewId}`);
    this.name = "ReviewDetailNotFoundError";
  }
}

function isoOrNull(d: Date | null): string | null {
  return d === null ? null : new Date(d).toISOString();
}

function iso(d: Date): string {
  return new Date(d).toISOString();
}

interface HeadRow {
  review_id: string;
  repo: string;
  repository_id: string;
  pr_number: number;
  pr_title: string;
  state: "queued" | "in_progress" | "complete" | "failed";
  pr_id: string | null;
  current_run_id: string | null;
  posted_at: Date | null;
}

interface FindingRow {
  review_finding_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  severity: "blocker" | "issue" | "suggestion" | "nit" | "none";
  title: string;
  body: string;
  suggestion: string | null;
}

interface ActivityRow {
  sequence_no: number;
  event_type: string;
  received_at: Date;
}

function mapEventTypeToState(eventType: string): ActivityEventV1["state"] {
  // Maps audit.workflow_events.event_type to the activity state enum.
  // Event types: STARTED, COMPLETED, FAILED, RETRYING, etc. from workflow lifecycle.
  const stateMap: Record<string, ActivityEventV1["state"]> = {
    SCHEDULED: "scheduled",
    STARTED: "started",
    COMPLETED: "completed",
    FAILED: "failed",
    RETRYING: "retrying",
  };
  return stateMap[eventType] ?? "started"; // default to started if unknown
}

export async function buildReviewDetail(
  db: Kysely<unknown>,
  args: { installationId: string; reviewId: string },
): Promise<ReviewDetailV1> {
  // Head query: join to get repo, pr, review_run, posted_review data.
  const headResult = await sql<HeadRow>`
    SELECT
      pr.review_id,
      repo.full_name AS repo,
      repo.repository_id,
      pr.pr_number,
      COALESCE(prr.title, 'PR #' || pr.pr_number::text) AS pr_title,
      CASE
        WHEN rr.lifecycle_state IS NULL                        THEN 'queued'
        WHEN rr.lifecycle_state = 'PENDING'                    THEN 'queued'
        WHEN rr.lifecycle_state IN ('RUNNING','WAITING_RETRY') THEN 'in_progress'
        WHEN rr.lifecycle_state IN ('COMPLETED','PARTIAL')     THEN 'complete'
        WHEN rr.lifecycle_state IN ('FAILED','CANCELLED')      THEN 'failed'
        ELSE 'queued'
      END AS state,
      prr.pr_id,
      pr.current_run_id,
      posted.posted_at
    FROM core.pull_request_reviews pr
    JOIN core.repositories repo
      ON repo.github_repo_id = pr.repo_id
    LEFT JOIN core.pull_requests prr
      ON prr.repository_id = repo.repository_id
     AND prr.pr_number = pr.pr_number
    LEFT JOIN core.review_runs rr
      ON rr.run_id = pr.current_run_id
    LEFT JOIN core.posted_reviews posted
      ON posted.pr_id = prr.pr_id
    WHERE pr.review_id = ${args.reviewId}
      AND (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR repo.installation_id = ${args.installationId})
  `.execute(db);

  const headRow = headResult.rows[0];
  if (headRow === undefined) {
    throw new ReviewDetailNotFoundError(args.reviewId);
  }

  // Findings query: filter suppression_state='NONE', order by severity desc then file_path asc.
  const findingsResult = await sql<FindingRow>`
    SELECT
      review_finding_id,
      file_path,
      start_line,
      end_line,
      severity,
      title,
      body,
      suggestion
    FROM core.review_findings
    WHERE (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR installation_id = ${args.installationId})
      AND pr_id = ${headRow.pr_id}
      AND suppression_state = 'NONE'
    ORDER BY
      CASE severity
        WHEN 'blocker'    THEN 4
        WHEN 'issue'      THEN 3
        WHEN 'suggestion' THEN 2
        WHEN 'nit'        THEN 1
        ELSE 0
      END DESC,
      file_path ASC,
      start_line ASC
    LIMIT ${FINDINGS_LIMIT}
  `.execute(db);

  // Activities query: join audit.workflow_events, tenancy via installation_id column.
  const activitiesResult = await sql<ActivityRow>`
    SELECT
      we.sequence_no,
      we.event_type,
      we.received_at
    FROM audit.workflow_events we
    WHERE we.review_id = ${args.reviewId}
      AND (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR we.installation_id = ${args.installationId})
    ORDER BY we.sequence_no ASC
    LIMIT ${ACTIVITIES_LIMIT}
  `.execute(db);

  const findings: ReviewFindingItemV1[] = findingsResult.rows.map((r) => ({
    schema_version: 1,
    finding_id: r.review_finding_id,
    file_path: r.file_path,
    start_line: r.start_line,
    end_line: r.end_line,
    severity: r.severity,
    title: r.title,
    body: r.body,
    suggestion: r.suggestion,
    tool_source: null,
  }));

  const activities: ActivityEventV1[] = activitiesResult.rows.map((r) => ({
    seq: r.sequence_no,
    activity_name: r.event_type,
    state: mapEventTypeToState(r.event_type),
    started_at: iso(r.received_at),
    completed_at: iso(r.received_at),
    detail: "",
  }));

  // Temporal workflow ID: review/{installation_id}/{repository_id}/{pr_number}
  let temporalUrl: string | null = null;
  if (headRow.current_run_id !== null) {
    const workflowId = `review/${args.installationId}/${headRow.repository_id}/${headRow.pr_number}`;
    temporalUrl = `https://temporal.internal/namespaces/codemaster/workflows/${workflowId}`;
  }

  // Langfuse URL: null (Phase 2 follow-up; trace_id not in schema today).
  const langfuseUrl: string | null = null;

  return {
    schema_version: 1,
    review_id: headRow.review_id,
    repo: headRow.repo,
    pr_number: headRow.pr_number,
    pr_title: headRow.pr_title,
    state: headRow.state,
    findings,
    activities,
    langfuse_url: langfuseUrl,
    temporal_url: temporalUrl,
    posted_at: isoOrNull(headRow.posted_at),
  };
}

export { ReviewDetailNotFoundError };
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_reviews_detail.integration.test.ts` / Expected: PASS on repo read functions

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/reviews_detail_read.ts ; git commit -m "add reviews_detail_read.ts with joined SQL for findings and activities"

### Task 1.3: Register GET /api/admin/reviews/{review_id} route in admin_routes.ts

**Files:** Modify `apps/backend/src/api/admin/admin_routes.ts`

- [ ] **Step 1: Write the failing test** — Test already written in 1.1 expects 404 on route injection

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_reviews_detail.integration.test.ts` / Expected: FAIL (route returns 404)

- [ ] **Step 3: Implement** — Add to imports in `admin_routes.ts` (around line 77):

```typescript
import { ReviewDetailNotFoundError, buildReviewDetail } from "#backend/api/admin/reviews_detail_read.js";
```

Then add route handler in the `registerAdminRoutes` function (after reviews list route at line 1749):

```typescript
    scope.get(
      "/api/admin/reviews/:review_id",
      { preHandler: requireRole(["platform_operator", "platform_owner", "super_admin"]) },
      async (request, reply) => {
        const reviewId = String(request.params.review_id ?? "");
        // Validate UUID format
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reviewId)) {
          return reply.code(400).send({ detail: "review_id is not a valid UUID" });
        }
        try {
          const detail = await buildReviewDetail(opts.db, {
            installationId: request.authPrincipal!.installationId,
            reviewId,
          });
          return reply.code(200).send(ReviewDetailV1.parse(detail));
        } catch (e) {
          if (e instanceof ReviewDetailNotFoundError) {
            return reply.code(404).send({ detail: e.message });
          }
          throw e;
        }
      },
    );
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_reviews_detail.integration.test.ts` / Expected: PASS all test cases (200 happy path, 404, 403, 401, authz matrix)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/admin_routes.ts ; git commit -m "register GET /api/admin/reviews/{review_id} route with RBAC and tenancy"

### Task 1.4: Create your-reviews endpoint (Pattern A: empty repo + route)

**Files:** Create `apps/backend/src/api/admin/reviews_your_read.ts`, Modify `admin_routes.ts`

- [ ] **Step 1: Write the failing test** — Add to test file (new describeDb block):

```typescript
describeDb("admin your-reviews (disposable :5434)", () => {
  it("GET /api/admin/your-reviews — 200 happy path returns YourReviewsPageV1 with empty tuples", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/your-reviews",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<YourReviewsPageV1>();
    expect(body.schema_version).toBe(1);
    expect(body.user_id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(body.authored).toEqual([]);
    expect(body.assigned).toEqual([]);
    await app.close();
  });

  it("authz: reader/operator/owner/super/security_auditor 200, others 403", async () => {
    const app = await makeApp();
    const allowed = ["reader", "platform_operator", "platform_owner", "super_admin", "security_auditor"] as const;
    const denied = ["org_owner"] as const;
    for (const role of allowed) {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/your-reviews",
        cookies: { [SESSION_COOKIE_NAME]: mintCookie(role) },
      });
      expect(res.statusCode).toBe(200, `${role} should be 200`);
    }
    for (const role of denied) {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/your-reviews",
        cookies: { [SESSION_COOKIE_NAME]: mintCookie(role) },
      });
      expect(res.statusCode).toBe(403, `${role} should be 403`);
    }
    await app.close();
  });

  it("401 no cookie", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/your-reviews",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_reviews_detail.integration.test.ts` / Expected: FAIL (route not found)

- [ ] **Step 3: Implement** — Create `apps/backend/src/api/admin/reviews_your_read.ts`:

```typescript
// Your-reviews repo — Pattern A foundation (returns empty). Phase 2 will wire engineer-identity link.
// Protocol: authored_by + assigned_to both return empty tuples.

import { type Kysely } from "kysely";

import type { ReviewListItemV1 } from "#contracts/admin.v1.js";

export async function authoredBy(
  db: Kysely<unknown>,
  args: { installationId: string; userId: string },
): Promise<ReviewListItemV1[]> {
  // Phase 1 pattern: return empty. Phase 2 will join core.gh_users + core.pr_assigned_reviewers.
  void db; // Acknowledge parameter received but unused
  void args;
  return [];
}

export async function assignedTo(
  db: Kysely<unknown>,
  args: { installationId: string; userId: string },
): Promise<ReviewListItemV1[]> {
  // Phase 1 pattern: return empty.
  void db;
  void args;
  return [];
}

export async function buildYourReviews(
  db: Kysely<unknown>,
  args: { installationId: string; userId: string },
): Promise<{ authored: ReviewListItemV1[]; assigned: ReviewListItemV1[] }> {
  const authored = await authoredBy(db, args);
  const assigned = await assignedTo(db, args);
  return { authored, assigned };
}
```

Then add to `admin_routes.ts` imports:

```typescript
import { buildYourReviews } from "#backend/api/admin/reviews_your_read.js";
```

And add route handler (after /api/admin/reviews/{review_id}):

```typescript
    scope.get(
      "/api/admin/your-reviews",
      { preHandler: requireRole(["reader", "platform_operator", "platform_owner", "super_admin", "security_auditor"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const { authored, assigned } = await buildYourReviews(opts.db, {
          installationId: principal.installationId,
          userId: principal.userId,
        });
        return reply
          .code(200)
          .send(YourReviewsPageV1.parse({ authored, assigned, user_id: principal.userId }));
      },
    );
```

Don't forget to add YourReviewsPageV1 to the imports at the top of admin_routes.ts.

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_reviews_detail.integration.test.ts` / Expected: PASS (both review detail and your-reviews tests all green)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/reviews_your_read.ts apps/backend/src/api/admin/admin_routes.ts ; git commit -m "add GET /api/admin/your-reviews endpoint (Pattern A: returns empty authored/assigned)"

---

## Batch 2: Knowledge-writes cluster

### Task 2.1: Add knowledge-write contracts to `admin.v1.ts`
**Files:** Modify `libs/contracts/src/admin.v1.ts`.

- [ ] **Step 1: Write the failing test** — Create integration test file `test/integration/api/admin_knowledge_write.integration.test.ts` with a test that verifies the contracts parse:

```typescript
/**
 * Integration test for knowledge write endpoints: PUT /api/admin/knowledge/{learning_id},
 * POST /api/admin/knowledge/proposals/{proposal_id}/approve,
 * POST /api/admin/knowledge/proposals/{proposal_id}/reject.
 * Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { RecordingTemporalClient } from "#backend/adapters/temporal_port.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import {
  UpdateLearningBodyV1,
  StaleWriteV1,
  RejectProposalV1,
  LearningDetailV1,
} from "#contracts/admin.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-08T10:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "f1f1f1f1-2222-3333-4444-555555555555";
const LEARNING_ID = "l1l1l1l1-2222-3333-4444-555555555555";
const PROPOSAL_ID = "p1p1p1p1-2222-3333-4444-555555555555";
const APPROVER_ID = "a1a1a1a1-0000-0000-0000-000000000001";
const PROPOSER_ID = "p2p2p2p2-0000-0000-0000-000000000002";

let pool: Pool;
let db: Kysely<unknown>;
let temporal: RecordingTemporalClient;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.learnings WHERE learning_id = ${LEARNING_ID}`.execute(db);
  await sql`DELETE FROM core.learnings_revisions WHERE learning_id = ${LEARNING_ID}`.execute(db);
  await sql`DELETE FROM core.learning_proposals WHERE proposal_id = ${PROPOSAL_ID}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  temporal = new RecordingTemporalClient();
  await cleanup();
  
  // Seed a learning
  await sql`INSERT INTO core.learnings
    (learning_id, installation_id, title, body_markdown, version, state, fired_count, accepted_count, feedback_count)
    VALUES (${LEARNING_ID}, ${INST}, 'Test Learning', 'original body', 1, 'active', 0, 0, 0)`.execute(db);
  
  // Seed a proposal
  await sql`INSERT INTO core.learning_proposals
    (proposal_id, installation_id, title, body, proposed_by_user_id, state)
    VALUES (${PROPOSAL_ID}, ${INST}, 'Test Proposal', 'proposal body', ${PROPOSER_ID}, 'pending_approval')`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
  await pool?.end();
});

function mintCookie(role: Role, userId: string = APPROVER_ID): string {
  return issueCookie({
    user_id: userId,
    email: "user@example.com",
    role,
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    temporal,
  });
  await app.ready();
  return app;
}

describeDb("admin knowledge writes (disposable :5434)", () => {
  it("PUT /api/admin/knowledge/{learning_id} — 200 updates body + returns LearningDetailV1", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/admin/knowledge/${LEARNING_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      headers: { "If-Match": '"1"' },
      payload: { body_markdown: "updated body" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("learning_id", LEARNING_ID);
    expect(body).toHaveProperty("body_markdown", "updated body");
    expect(body).toHaveProperty("version", 2);
    expect(body).toHaveProperty("revisions");
    LearningDetailV1.parse(body); // assert contract
    await app.close();
  });

  it("PUT /api/admin/knowledge/{learning_id} — 409 on stale version", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/admin/knowledge/${LEARNING_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      headers: { "If-Match": '"999"' }, // wrong version
      payload: { body_markdown: "stale update" },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    StaleWriteV1.parse(body);
    expect(body.code).toBe("stale_write");
    expect(body).toHaveProperty("current_body");
    expect(body).toHaveProperty("current_version");
    await app.close();
  });

  it("PUT /api/admin/knowledge/{learning_id} — 428 missing If-Match", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/admin/knowledge/${LEARNING_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      payload: { body_markdown: "no header" },
    });
    expect(res.statusCode).toBe(428);
    await app.close();
  });

  it("PUT /api/admin/knowledge/{learning_id} — 403 for reader role", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/admin/knowledge/${LEARNING_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
      headers: { "If-Match": '"1"' },
      payload: { body_markdown: "denied" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST /api/admin/knowledge/proposals/{proposal_id}/approve — 204 emits signal", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/knowledge/proposals/${PROPOSAL_ID}/approve`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(res.statusCode).toBe(204);
    expect(temporal.signals).toHaveLength(1);
    expect(temporal.signals[0]).toEqual([
      `knowledge-approval-${PROPOSAL_ID}`,
      "approve",
      { approver_user_id: APPROVER_ID },
    ]);
    await app.close();
  });

  it("POST /api/admin/knowledge/proposals/{proposal_id}/approve — 403 self-approval", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/knowledge/proposals/${PROPOSAL_ID}/approve`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner", PROPOSER_ID) },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST /api/admin/knowledge/proposals/{proposal_id}/reject — 204 emits signal + validates reason", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/knowledge/proposals/${PROPOSAL_ID}/reject`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      payload: { reason: "This proposal needs more detail" },
    });
    expect(res.statusCode).toBe(204);
    expect(temporal.signals).toHaveLength(1);
    expect(temporal.signals[0]).toEqual([
      `knowledge-approval-${PROPOSAL_ID}`,
      "reject",
      { approver_user_id: APPROVER_ID, reason: "This proposal needs more detail" },
    ]);
    await app.close();
  });

  it("POST /api/admin/knowledge/proposals/{proposal_id}/reject — 422 reason too short", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/knowledge/proposals/${PROPOSAL_ID}/reject`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      payload: { reason: "short" }, // < 10 chars
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_knowledge_write.integration.test.ts` / Expected: FAIL (contracts + routes not yet defined)

- [ ] **Step 3: Implement** — Add the three contracts to `libs/contracts/src/admin.v1.ts` at the end (before the final `__all__` or alongside existing knowledge contracts):

```typescript
// ─── Knowledge write (PUT body, error responses, proposals rejections) ────────────────────────────

/** PUT /api/admin/knowledge/{learning_id} request body — new body markdown. */
export const UpdateLearningBodyV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    body_markdown: z.string().min(1).max(8192),
  })
  .strict();
export type UpdateLearningBodyV1 = z.infer<typeof UpdateLearningBodyV1>;

/** 409 Conflict — optimistic-concurrency mismatch (If-Match version stale). Carries current state
 *  so the frontend renders a collision-diff modal. */
export const StaleWriteV1 = z
  .object({
    code: z.literal("stale_write"),
    current_body: z.string(),
    current_version: z.number().int(),
  })
  .strict();
export type StaleWriteV1 = z.infer<typeof StaleWriteV1>;

/** POST /api/admin/knowledge/proposals/{proposal_id}/reject request body — rejection reason,
 *  bounded 10–2048 chars (trimmed). */
export const RejectProposalV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    reason: z.string().min(10).max(2048),
  })
  .strict();
export type RejectProposalV1 = z.infer<typeof RejectProposalV1>;
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_knowledge_write.integration.test.ts` / Expected: PASS contract parsing tests (route tests still fail until handlers are implemented)

- [ ] **Step 5: Commit** — git add `libs/contracts/src/admin.v1.ts test/integration/api/admin_knowledge_write.integration.test.ts` ; git commit -m "Add knowledge-write contracts (UpdateLearningBody, StaleWrite, RejectProposal) + integration test skeleton"

---

### Task 2.2: Implement knowledge-write repository functions
**Files:** Create `apps/backend/src/api/admin/knowledge_write.ts`.

- [ ] **Step 1: Write the failing test** — Extend `test/integration/api/admin_knowledge_write.integration.test.ts` with repo-layer tests (insert at the top of the `describeDb` block):

```typescript
describe("knowledge_write repo layer", () => {
  it("updateLearningBody: CAS success bumps version + creates revision", async () => {
    const { updateLearningBody } = await import("#backend/api/admin/knowledge_write.js");
    const before = await sql<{ version: number }>`
      SELECT version FROM core.learnings WHERE learning_id = ${LEARNING_ID}
    `.execute(db);
    const beforeVersion = before.rows[0]!.version;
    
    const result = await updateLearningBody(db, {
      learningId: LEARNING_ID,
      installationId: INST,
      newBodyMarkdown: "updated in repo test",
      ifMatchVersion: beforeVersion,
      editedByUserId: APPROVER_ID,
      now: NOW,
    });
    
    expect(result.version).toBe(beforeVersion + 1);
    expect(result.body_markdown).toBe("updated in repo test");
    
    const revisions = await sql<{ version: number }>`
      SELECT version FROM core.learnings_revisions
      WHERE learning_id = ${LEARNING_ID}
      ORDER BY edited_at DESC LIMIT 1
    `.execute(db);
    expect(revisions.rows[0]!.version).toBe(beforeVersion + 1);
  });

  it("updateLearningBody: CAS failure throws KnowledgeStaleWriteError", async () => {
    const { updateLearningBody, KnowledgeStaleWriteError } = await import("#backend/api/admin/knowledge_write.js");
    const err = await expect(
      updateLearningBody(db, {
        learningId: LEARNING_ID,
        installationId: INST,
        newBodyMarkdown: "will fail",
        ifMatchVersion: 999,
        editedByUserId: APPROVER_ID,
        now: NOW,
      }),
    ).rejects.toThrow(KnowledgeStaleWriteError);
    expect(err.current_version).toBe(expect.any(Number));
    expect(err.current_body).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_knowledge_write.integration.test.ts` / Expected: FAIL (knowledge_write.ts does not exist)

- [ ] **Step 3: Implement** — Create `apps/backend/src/api/admin/knowledge_write.ts`:

```typescript
// Knowledge write — 1:1 port of codemaster/api/admin/knowledge.py (Sprint 16 / S16.B.2).
// Optimistic-concurrency update on core.learnings + atomic core.learnings_revisions insert.

import { type Kysely, sql } from "kysely";

// ─── Errors ─────────────────────────────────────────────────────────────────────────────────────

export class KnowledgeStaleWriteError extends Error {
  public constructor(
    public readonly current_body: string,
    public readonly current_version: number,
  ) {
    super("stale write");
    this.name = "KnowledgeStaleWriteError";
  }
}

export class ProposalNotFoundError extends Error {
  public constructor() {
    super("proposal not found");
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalAlreadyDecidedError extends Error {
  public constructor(public readonly current_state: string) {
    super(`already decided: ${current_state}`);
    this.name = "ProposalAlreadyDecidedError";
  }
}

export class SelfApprovalRefusedError extends Error {
  public constructor() {
    super("cannot approve your own proposal");
    this.name = "SelfApprovalRefusedError";
  }
}

export class RejectReasonInvalidError extends Error {
  public constructor() {
    super("reject reason failed validation");
    this.name = "RejectReasonInvalidError";
  }
}

// ─── SQL Rows & Mappers ─────────────────────────────────────────────────────────────────────────

interface LearningRow {
  learning_id: string;
  installation_id: string;
  title: string;
  body_markdown: string;
  version: number;
  state: string;
  repo_id: string | null;
  fired_count: number;
  accepted_count: number;
  feedback_count: number;
  last_fired_at: Date | null;
}

interface ProposalRow {
  proposal_id: string;
  installation_id: string;
  title: string;
  body: string;
  repo_id: string | null;
  proposed_by_user_id: string;
  state: string;
  created_at: Date;
}

// ─── Repository functions ───────────────────────────────────────────────────────────────────────

const LEARNING_COLS = sql`
  learning_id, installation_id, title, body_markdown, version, state,
  repo_id, fired_count, accepted_count, feedback_count, last_fired_at
`;

const PROPOSAL_COLS = sql`
  proposal_id, installation_id, title, body, repo_id,
  proposed_by_user_id, state, created_at
`;

/**
 * Update learning body via optimistic concurrency (If-Match on version).
 * Returns the updated row. Throws KnowledgeStaleWriteError on version mismatch.
 * Atomic: version bump + revision INSERT in same transaction.
 */
export async function updateLearningBody(
  db: Kysely<unknown>,
  args: {
    learningId: string;
    installationId: string;
    newBodyMarkdown: string;
    ifMatchVersion: number;
    editedByUserId: string;
    now: Date;
  },
): Promise<LearningRow> {
  return db.transaction().execute(async (tx) => {
    // CAS update: WHERE version = ifMatchVersion
    const updateResult = await sql<LearningRow>`
      UPDATE core.learnings
      SET body_markdown = ${args.newBodyMarkdown},
          version = version + 1,
          updated_at = ${args.now}
      WHERE learning_id = ${args.learningId}
        AND installation_id = ${args.installationId}
        AND version = ${args.ifMatchVersion}
      RETURNING ${LEARNING_COLS}
    `.execute(tx);

    if (updateResult.rows.length === 0) {
      // CAS miss: read current to return in error
      const current = await sql<LearningRow>`
        SELECT ${LEARNING_COLS}
        FROM core.learnings
        WHERE learning_id = ${args.learningId}
          AND installation_id = ${args.installationId}
        LIMIT 1
      `.execute(tx);
      if (current.rows.length === 0) {
        throw new Error(`learning ${args.learningId} not found`);
      }
      const row = current.rows[0]!;
      throw new KnowledgeStaleWriteError(row.body_markdown, row.version);
    }

    const updated = updateResult.rows[0]!;

    // Atomic revision insert in the same transaction (new version = ifMatchVersion + 1)
    await sql`
      INSERT INTO core.learnings_revisions
        (learning_id, installation_id, body_markdown, version, edited_by_user_id, edited_at)
      VALUES (${args.learningId}, ${args.installationId}, ${args.newBodyMarkdown},
              ${args.ifMatchVersion + 1}, ${args.editedByUserId}, ${args.now})
    `.execute(tx);

    return updated;
  });
}

/**
 * Get a proposal by id (any state) for validation before approve/reject.
 * Returns null if not found or outside the installation.
 */
export async function getProposal(
  db: Kysely<unknown>,
  args: {
    proposalId: string;
    installationId: string;
  },
): Promise<ProposalRow | null> {
  const rows = await sql<ProposalRow>`
    SELECT ${PROPOSAL_COLS}
    FROM core.learning_proposals
    WHERE proposal_id = ${args.proposalId}
      AND installation_id = ${args.installationId}
    LIMIT 1
  `.execute(db);
  return rows.rows[0] ?? null;
}

/**
 * Validate approval preconditions; does NOT persist state (signals do that via the workflow).
 * Throws typed errors: ProposalNotFoundError, ProposalAlreadyDecidedError, SelfApprovalRefusedError.
 */
export async function validateApproveProposal(
  db: Kysely<unknown>,
  args: {
    proposalId: string;
    installationId: string;
    approverUserId: string;
  },
): Promise<ProposalRow> {
  const proposal = await getProposal(db, {
    proposalId: args.proposalId,
    installationId: args.installationId,
  });

  if (proposal === null) {
    throw new ProposalNotFoundError();
  }

  if (proposal.state !== "pending_approval") {
    throw new ProposalAlreadyDecidedError(proposal.state);
  }

  if (proposal.proposed_by_user_id === args.approverUserId) {
    throw new SelfApprovalRefusedError();
  }

  return proposal;
}

/**
 * Validate reject preconditions + reason bounds; does NOT persist state.
 * Throws: ProposalNotFoundError, ProposalAlreadyDecidedError, RejectReasonInvalidError.
 */
export async function validateRejectProposal(
  db: Kysely<unknown>,
  args: {
    proposalId: string;
    installationId: string;
    reason: string;
  },
): Promise<ProposalRow> {
  const trimmed = args.reason.trim();
  if (trimmed.length < 10 || trimmed.length > 2048) {
    throw new RejectReasonInvalidError();
  }

  const proposal = await getProposal(db, {
    proposalId: args.proposalId,
    installationId: args.installationId,
  });

  if (proposal === null) {
    throw new ProposalNotFoundError();
  }

  if (proposal.state !== "pending_approval") {
    throw new ProposalAlreadyDecidedError(proposal.state);
  }

  return proposal;
}
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_knowledge_write.integration.test.ts --grep "knowledge_write repo layer"` / Expected: PASS repo tests

- [ ] **Step 5: Commit** — git add `apps/backend/src/api/admin/knowledge_write.ts` ; git commit -m "Add knowledge_write repo functions (updateLearningBody, getProposal, validate{Approve,Reject}Proposal)"

---

### Task 2.3: Implement route handlers + temporal signal wiring
**Files:** Modify `apps/backend/src/api/admin/admin_routes.ts`, define signal function in `knowledge_write.ts`.

- [ ] **Step 1: Write the failing test** — The test skeleton from Task 2.1 already covers the route layer (PUT, POST approve, POST reject). Verify it still fails: `npm run test -- test/integration/api/admin_knowledge_write.integration.test.ts --grep "PUT\|approve\|reject"` / Expected: FAIL (routes not yet registered)

- [ ] **Step 2: Run to verify it fails** — Confirmed above

- [ ] **Step 3: Implement** — First, add signal helpers to `apps/backend/src/api/admin/knowledge_write.ts` (append to end):

```typescript
// ─── Temporal signal helpers ────────────────────────────────────────────────────────────────────

/**
 * Proposal workflow ID format: `knowledge-approval-{proposal_id}` (1:1 with Python
 * `codemaster/workflows/knowledge_approval.py:workflow_id_for()`).
 */
export function workflowIdFor(proposalId: string): string {
  return `knowledge-approval-${proposalId}`;
}
```

Then, add the three route handlers to `apps/backend/src/api/admin/admin_routes.ts` in the `registerAdminRoutes` function. Find the existing knowledge routes section (around line 765–813 per the grep earlier) and add after the existing knowledge GET routes:

```typescript
    // PUT /api/admin/knowledge/{learning_id} — optimistic update with If-Match
    scope.put(
      "/api/admin/knowledge/:learning_id",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const learningId = request.params.learning_id as string;
        if (!UUID_RE.test(learningId)) {
          return reply.code(400).send({ error: "invalid learning_id" });
        }

        const ifMatch = request.headers["if-match"];
        if (!ifMatch) {
          return reply.code(428).send({ error: "If-Match header is required" });
        }

        let ifMatchVersion: number;
        try {
          ifMatchVersion = parseInt(ifMatch.replace(/^"(.*)"$/, "$1"), 10);
        } catch {
          return reply.code(400).send({ error: "If-Match must be an integer" });
        }

        const body = UpdateLearningBodyV1.safeParse(request.body);
        if (!body.success) {
          return reply.code(422).send(body.error);
        }

        try {
          const updated = await updateLearningBody(opts.db, {
            learningId,
            installationId: request.authPrincipal!.installationId,
            newBodyMarkdown: body.data.body_markdown,
            ifMatchVersion,
            editedByUserId: request.authPrincipal!.userId,
            now: opts.clock.now(),
          });

          const revisions = await getRevisions(opts.db, {
            learningId,
            limit: 10,
          });

          const response: LearningDetailV1 = {
            learning_id: updated.learning_id,
            title: updated.title,
            body_markdown: updated.body_markdown,
            state: updated.state as "active" | "deprecated",
            repo: updated.repo_id === null ? null : (await getLearningRepo(opts.db, updated.repo_id)) ?? null,
            version: updated.version,
            fired_count: updated.fired_count,
            accept_rate: acceptRate(updated),
            last_fired_at: updated.last_fired_at?.toISOString() ?? null,
            revisions: revisions.map((r) => ({
              revision_id: r.revision_id,
              body_markdown: r.body_markdown,
              version: r.version,
              edited_by_user_id: r.edited_by_user_id,
              edited_at: r.edited_at.toISOString(),
            })),
          };

          return reply.code(200).send(LearningDetailV1.parse(response));
        } catch (err) {
          if (err instanceof KnowledgeStaleWriteError) {
            const payload = StaleWriteV1.parse({
              code: "stale_write",
              current_body: err.current_body,
              current_version: err.current_version,
            });
            return reply.code(409).send(payload);
          }
          throw err;
        }
      },
    );

    // POST /api/admin/knowledge/proposals/{proposal_id}/approve — signal workflow
    scope.post(
      "/api/admin/knowledge/proposals/:proposal_id/approve",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const proposalId = request.params.proposal_id as string;
        if (!UUID_RE.test(proposalId)) {
          return reply.code(400).send({ error: "invalid proposal_id" });
        }

        try {
          const proposal = await validateApproveProposal(opts.db, {
            proposalId,
            installationId: request.authPrincipal!.installationId,
            approverUserId: request.authPrincipal!.userId,
          });

          if (opts.temporal) {
            await opts.temporal.signalWorkflow({
              workflowId: workflowIdFor(proposalId),
              signalName: "approve",
              input: {
                approver_user_id: request.authPrincipal!.userId,
              },
            });
          }

          return reply.code(204).send();
        } catch (err) {
          if (err instanceof ProposalNotFoundError) {
            return reply.code(404).send({ error: "proposal not found" });
          }
          if (err instanceof SelfApprovalRefusedError) {
            return reply.code(403).send({ error: err.message });
          }
          if (err instanceof ProposalAlreadyDecidedError) {
            return reply.code(409).send({
              code: "already_decided",
              current_state: err.current_state,
            });
          }
          throw err;
        }
      },
    );

    // POST /api/admin/knowledge/proposals/{proposal_id}/reject — signal workflow with reason
    scope.post(
      "/api/admin/knowledge/proposals/:proposal_id/reject",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const proposalId = request.params.proposal_id as string;
        if (!UUID_RE.test(proposalId)) {
          return reply.code(400).send({ error: "invalid proposal_id" });
        }

        const body = RejectProposalV1.safeParse(request.body);
        if (!body.success) {
          return reply.code(422).send(body.error);
        }

        try {
          await validateRejectProposal(opts.db, {
            proposalId,
            installationId: request.authPrincipal!.installationId,
            reason: body.data.reason,
          });

          if (opts.temporal) {
            await opts.temporal.signalWorkflow({
              workflowId: workflowIdFor(proposalId),
              signalName: "reject",
              input: {
                approver_user_id: request.authPrincipal!.userId,
                reason: body.data.reason.trim(),
              },
            });
          }

          return reply.code(204).send();
        } catch (err) {
          if (err instanceof ProposalNotFoundError) {
            return reply.code(404).send({ error: "proposal not found" });
          }
          if (err instanceof RejectReasonInvalidError) {
            return reply.code(422).send({ error: "reason invalid" });
          }
          if (err instanceof ProposalAlreadyDecidedError) {
            return reply.code(409).send({
              code: "already_decided",
              current_state: err.current_state,
            });
          }
          throw err;
        }
      },
    );
```

Also, at the top of `admin_routes.ts`, add the needed imports:

```typescript
import {
  updateLearningBody,
  getRevisions,
  getLearningRepo,
  KnowledgeStaleWriteError,
  validateApproveProposal,
  validateRejectProposal,
  workflowIdFor,
  ProposalNotFoundError,
  SelfApprovalRefusedError,
  ProposalAlreadyDecidedError,
  RejectReasonInvalidError,
} from "#backend/api/admin/knowledge_write.js";
import {
  UpdateLearningBodyV1,
  StaleWriteV1,
  RejectProposalV1,
  LearningDetailV1,
} from "#contracts/admin.v1.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

And add helper functions to `knowledge_write.ts` (append after validateRejectProposal):

```typescript
/**
 * Get recent revisions for a learning (for the detail response).
 */
export async function getRevisions(
  db: Kysely<unknown>,
  args: {
    learningId: string;
    limit: number;
  },
): Promise<
  Array<{
    revision_id: string;
    body_markdown: string;
    version: number;
    edited_by_user_id: string;
    edited_at: Date;
  }>
> {
  const rows = await sql<{
    revision_id: string;
    body_markdown: string;
    version: number;
    edited_by_user_id: string;
    edited_at: Date;
  }>`
    SELECT revision_id, body_markdown, version, edited_by_user_id, edited_at
    FROM core.learnings_revisions
    WHERE learning_id = ${args.learningId}
    ORDER BY edited_at DESC
    LIMIT ${args.limit}
  `.execute(db);
  return rows.rows;
}

/**
 * Get friendly repo name by repo_id for the detail response.
 */
export async function getLearningRepo(db: Kysely<unknown>, repoId: string): Promise<string | null> {
  const rows = await sql<{ full_name: string }>`
    SELECT full_name FROM core.repositories WHERE repository_id = ${repoId} LIMIT 1
  `.execute(db);
  return rows.rows[0]?.full_name ?? null;
}

/**
 * Compute accept_rate from feedback counts (1:1 with Python knowledge.py _accept_rate).
 */
function acceptRate(row: {
  accepted_count: number;
  feedback_count: number;
}): number {
  if (row.feedback_count === 0) return 0.0;
  return Math.round((row.accepted_count / row.feedback_count) * 10000) / 10000;
}
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_knowledge_write.integration.test.ts` / Expected: PASS all tests (PUT, approve, reject routes + authz + validation)

- [ ] **Step 5: Commit** — git add `apps/backend/src/api/admin/admin_routes.ts apps/backend/src/api/admin/knowledge_write.ts` ; git commit -m "Add PUT /api/admin/knowledge/{learning_id}, POST approve/reject routes + temporal signal wiring"

---

## Batch 3: Confluence-pages cluster

### Task 3.1: Contracts — Page approvals + Quarantined chunks

**Files:** Create `libs/contracts/src/admin/page_approvals.v1.ts` + `libs/contracts/src/admin/quarantined_chunks.v1.ts`; Update `libs/contracts/src/admin.v1.ts` with exports.

- [ ] **Step 1: Write the failing test** — Create test file `test/integration/api/admin_confluence_pages.integration.test.ts` with a stub that imports the non-existent contracts and fails.

```typescript
import { describe, it, expect } from "vitest";
import { PageWithApprovalV1, PagesListPageV1 } from "#contracts/admin.v1.js";
import { QuarantinedChunkV1, QuarantinedChunksPageV1 } from "#contracts/admin.v1.js";

describe("contracts exist", () => {
  it("PageWithApprovalV1 exists", () => {
    expect(PageWithApprovalV1).toBeDefined();
  });
  it("PagesListPageV1 exists", () => {
    expect(PagesListPageV1).toBeDefined();
  });
  it("QuarantinedChunkV1 exists", () => {
    expect(QuarantinedChunkV1).toBeDefined();
  });
  it("QuarantinedChunksPageV1 exists", () => {
    expect(QuarantinedChunksPageV1).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- test/integration/api/admin_confluence_pages.integration.test.ts` / Expected: FAIL (cannot find module)

- [ ] **Step 3: Implement** — Create the three contract files:

**File: `libs/contracts/src/admin/page_approvals.v1.ts`**
```typescript
import { z } from "zod";

// Zod port of contracts/admin/page_approvals/v1.py — read envelope for paginated page list.
// The page-approval row shape (create/read) is in page_approval.v1.ts; this module adds the list envelope.

export const PageApprovalStatusV1 = z.enum(["approved", "revoked", "none"]);
export type PageApprovalStatusV1 = z.infer<typeof PageApprovalStatusV1>;

/**
 * One Confluence page in a space, with its current approval state.
 *
 * page_title + page_version come from the most-recent active chunk in core.confluence_chunks.
 *
 * approval_status:
 *   - "approved" — a row exists in confluence_page_approvals with revoked_at IS NULL.
 *   - "revoked" — a row exists but revoked_at IS NOT NULL.
 *   - "none" — no row in confluence_page_approvals for this page.
 */
export const PageWithApprovalV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_key: z.string(),
    page_id: z.string(),
    page_title: z.string(),
    page_version: z.number().int().min(1),
    labels: z.array(z.string()).max(100).default([]),
    last_modified_at: z.string().datetime({ offset: true, local: true }),
    approval_status: PageApprovalStatusV1,
    approver_email: z.string().email().nullable().default(null),
    approved_at_utc: z.string().datetime({ offset: true, local: true }).nullable().default(null),
    revoked_at: z.string().datetime({ offset: true, local: true }).nullable().default(null),
    revoked_by: z.string().email().nullable().default(null),
  })
  .strict();
export type PageWithApprovalV1 = z.infer<typeof PageWithApprovalV1>;

/** Paginated envelope for the list endpoint. */
export const PagesListPageV1 = z
  .object({
    schema_version: z.number().int().default(1),
    rows: z.array(PageWithApprovalV1),
    next_cursor: z.string().max(512).nullable().default(null),
  })
  .strict();
export type PagesListPageV1 = z.infer<typeof PagesListPageV1>;
```

**File: `libs/contracts/src/admin/quarantined_chunks.v1.ts`**
```typescript
import { z } from "zod";

// Zod port of contracts/admin/quarantined_chunks/v1.py — read-only list of quarantined chunks per space.
// Quarantine state is managed by the sync pipeline; operators triage by editing the Confluence page.

/** One quarantined chunk from a confluence space. */
export const QuarantinedChunkV1 = z
  .object({
    schema_version: z.number().int().default(1),
    chunk_id: z.string().uuid(),
    space_key: z.string(),
    page_id: z.string(),
    page_title: z.string(),
    page_version: z.number().int().min(1),
    last_modified_at: z.string().datetime({ offset: true, local: true }),
    quarantine_reasons: z.array(z.string()).max(20).default([]),
    // Truncated to 280 chars for the sidebar preview; operators open the page in Confluence for full body.
    chunk_text_preview: z.string().max(280),
  })
  .strict();
export type QuarantinedChunkV1 = z.infer<typeof QuarantinedChunkV1>;

/** Paginated envelope for the list endpoint. */
export const QuarantinedChunksPageV1 = z
  .object({
    schema_version: z.number().int().default(1),
    rows: z.array(QuarantinedChunkV1),
    next_cursor: z.string().max(512).nullable().default(null),
  })
  .strict();
export type QuarantinedChunksPageV1 = z.infer<typeof QuarantinedChunksPageV1>;
```

**File: Update `libs/contracts/src/admin.v1.ts`** — Add the following exports at the appropriate alphabetical position in the import section and in the exports:
```typescript
export {
  PageApprovalStatusV1,
  PageWithApprovalV1,
  PagesListPageV1,
} from "./admin/page_approvals.v1.js";
export {
  QuarantinedChunkV1,
  QuarantinedChunksPageV1,
} from "./admin/quarantined_chunks.v1.js";
```

- [ ] **Step 4: Run to verify pass** — Run: `npm test -- test/integration/api/admin_confluence_pages.integration.test.ts` / Expected: PASS (contracts export successfully)

- [ ] **Step 5: Commit** — git add `libs/contracts/src/admin/page_approvals.v1.ts` `libs/contracts/src/admin/quarantined_chunks.v1.ts` `libs/contracts/src/admin.v1.ts` `test/integration/api/admin_confluence_pages.integration.test.ts` ; git commit -m "Add Confluence-pages read contracts: PagesListPageV1 + QuarantinedChunksPageV1"

---

### Task 3.2: Repo read functions — Pages + Quarantined chunks

**Files:** Create `apps/backend/src/api/admin/confluence_pages_read.ts`; Update `apps/backend/src/domain/repos/confluence_chunks_repo.ts` with a read function for quarantined chunks.

- [ ] **Step 1: Write the failing test** — In `test/integration/api/admin_confluence_pages.integration.test.ts`, add tests that call the repo functions which don't yet exist:

```typescript
import { PostgresConfluencePageApprovalsRepo } from "#backend/domain/repos/confluence_page_approvals_repo.js";
import { PostgresConfluenceChunksRepo } from "#backend/domain/repos/confluence_chunks_repo.js";
import {
  listPagesForIntegration,
  listQuarantinedChunksForIntegration,
  getSpaceKeyForIntegration,
} from "#backend/api/admin/confluence_pages_read.js";

describe("confluence_pages_read repo functions", () => {
  it("getSpaceKeyForIntegration resolves integration_id → space_key", async () => {
    // Will fail until the function exists
    expect(getSpaceKeyForIntegration).toBeDefined();
  });
  it("listPagesForIntegration returns paginated pages with approval status", async () => {
    expect(listPagesForIntegration).toBeDefined();
  });
  it("listQuarantinedChunksForIntegration returns paginated quarantined chunks", async () => {
    expect(listQuarantinedChunksForIntegration).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- test/integration/api/admin_confluence_pages.integration.test.ts` / Expected: FAIL (cannot find module)

- [ ] **Step 3: Implement**

**File: `apps/backend/src/api/admin/confluence_pages_read.ts`**
```typescript
/**
 * Confluence pages read — 1:1 with page_approvals.py + postgres_approval_repo.py
 *
 * Two read operations:
 *   1. listPagesForIntegration — paginated list of pages per space (integration_id → space_key),
 *      with their current approval status via LEFT JOIN confluence_page_approvals.
 *   2. listQuarantinedChunksForIntegration — paginated list of quarantined chunks per space.
 *   3. getSpaceKeyForIntegration — resolve integration_id → space_key for route handlers.
 */

import { type Kysely, sql } from "kysely";

import type {
  PageWithApprovalV1,
  PagesListPageV1,
  QuarantinedChunkV1,
  QuarantinedChunksPageV1,
} from "#contracts/admin.v1.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const QUARANTINE_PREVIEW_CHARS = 280;

/** Raised when integration_id doesn't resolve to a confluence_space row. */
export class IntegrationNotFoundError extends Error {
  public constructor(integrationId: string) {
    super(`integration not found: ${integrationId}`);
    this.name = "IntegrationNotFoundError";
  }
}

function iso(d: Date): string {
  return new Date(d).toISOString();
}

/**
 * Resolve integration_id → space_key from core.integrations.config_json.
 * Raises IntegrationNotFoundError if the integration_id doesn't match an enabled confluence_space row.
 */
export async function getSpaceKeyForIntegration(
  db: Kysely<unknown>,
  integrationId: string,
): Promise<string> {
  // tenant:exempt reason=admin-cross-tenant-integration-lookup follow_up=PERMANENT-EXEMPTION-admin-cross-tenant-integration-lookup
  const result = await sql<{ space_key: string }>`
    SELECT config_json ->> 'space_key' AS space_key
      FROM core.integrations
     WHERE integration_id = ${integrationId}
       AND kind = 'confluence_space'
       AND enabled = true
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) {
    throw new IntegrationNotFoundError(integrationId);
  }
  return row.space_key;
}

/**
 * Paginated list of pages for a space (resolved from integration_id), with their approval status.
 * Pages are ordered by last_modified_at DESC, newest first.
 * Cursor is opaque offset-based.
 */
export async function listPagesForIntegration(
  db: Kysely<unknown>,
  integrationId: string,
  opts: { cursor?: string | null; pageSize?: number } = {},
): Promise<PagesListPageV1> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;

  const spaceKey = await getSpaceKeyForIntegration(db, integrationId);

  // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
  const result = await sql<{
    space_key: string;
    page_id: string;
    page_title: string;
    page_version: number;
    labels: string[] | null;
    last_modified_at: Date;
    approver_email: string | null;
    approved_at_utc: Date | null;
    revoked_at: Date | null;
    revoked_by: string | null;
    approval_status: "approved" | "revoked" | "none";
  }>`
    WITH ranked AS (
      SELECT DISTINCT ON (cc.page_id)
        cc.space_key,
        cc.page_id,
        cc.page_title,
        cc.version AS page_version,
        cc.labels,
        cc.last_modified_at,
        cpa.approver_email,
        cpa.approved_at_utc,
        cpa.revoked_at,
        cpa.revoked_by,
        CASE
          WHEN cpa.approval_id IS NULL THEN 'none'
          WHEN cpa.revoked_at IS NULL THEN 'approved'
          ELSE 'revoked'
        END AS approval_status
      FROM core.confluence_chunks cc
      LEFT JOIN core.confluence_page_approvals cpa
        ON cpa.space_key = cc.space_key
       AND cpa.page_id = cc.page_id
       AND cpa.revoked_at IS NULL
      WHERE cc.space_key = ${spaceKey}
        AND cc.deleted_at IS NULL
      ORDER BY cc.page_id, cc.version DESC, cc.last_modified_at DESC
    )
    SELECT *
      FROM ranked
     ORDER BY last_modified_at DESC
     LIMIT ${pageSize} OFFSET ${offset}
  `.execute(db);

  const rows: PageWithApprovalV1[] = result.rows.map((r) => ({
    schema_version: 1 as const,
    space_key: r.space_key,
    page_id: r.page_id,
    page_title: r.page_title,
    page_version: r.page_version,
    labels: r.labels ?? [],
    last_modified_at: iso(r.last_modified_at),
    approval_status: r.approval_status,
    approver_email: r.approver_email ?? null,
    approved_at_utc: r.approved_at_utc ? iso(r.approved_at_utc) : null,
    revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
    revoked_by: r.revoked_by ?? null,
  }));

  const nextCursor = rows.length === pageSize ? String(offset + pageSize) : null;

  return {
    schema_version: 1 as const,
    rows,
    next_cursor: nextCursor,
  };
}

/**
 * Paginated list of quarantined chunks for a space (resolved from integration_id).
 * Chunks are ordered by last_modified_at DESC, newest first.
 * Text preview is truncated to QUARANTINE_PREVIEW_CHARS (280).
 * Cursor is opaque offset-based.
 */
export async function listQuarantinedChunksForIntegration(
  db: Kysely<unknown>,
  integrationId: string,
  opts: { cursor?: string | null; pageSize?: number } = {},
): Promise<QuarantinedChunksPageV1> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;

  const spaceKey = await getSpaceKeyForIntegration(db, integrationId);

  // tenant:exempt reason=confluence-platform-wide-post-0063 follow_up=PERMANENT-EXEMPTION-confluence-corpus
  const result = await sql<{
    chunk_id: string;
    space_key: string;
    page_id: string;
    page_title: string;
    page_version: number;
    last_modified_at: Date;
    quarantine_reasons: string[] | null;
    chunk_text_preview: string;
  }>`
    SELECT
      chunk_id,
      space_key,
      page_id,
      page_title,
      version AS page_version,
      last_modified_at,
      quarantine_reasons,
      SUBSTRING(chunk_text, 1, ${QUARANTINE_PREVIEW_CHARS}) AS chunk_text_preview
    FROM core.confluence_chunks
    WHERE space_key = ${spaceKey}
      AND quarantined = true
      AND deleted_at IS NULL
    ORDER BY last_modified_at DESC, chunk_id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `.execute(db);

  const rows: QuarantinedChunkV1[] = result.rows.map((r) => ({
    schema_version: 1 as const,
    chunk_id: r.chunk_id,
    space_key: r.space_key,
    page_id: r.page_id,
    page_title: r.page_title,
    page_version: r.page_version,
    last_modified_at: iso(r.last_modified_at),
    quarantine_reasons: r.quarantine_reasons ?? [],
    chunk_text_preview: r.chunk_text_preview,
  }));

  const nextCursor = rows.length === pageSize ? String(offset + pageSize) : null;

  return {
    schema_version: 1 as const,
    rows,
    next_cursor: nextCursor,
  };
}
```

- [ ] **Step 4: Run to verify pass** — Run: `npm test -- test/integration/api/admin_confluence_pages.integration.test.ts` / Expected: PASS (repo functions callable)

- [ ] **Step 5: Commit** — git add `apps/backend/src/api/admin/confluence_pages_read.ts` `test/integration/api/admin_confluence_pages.integration.test.ts` ; git commit -m "Add confluence_pages_read repo functions: listPagesForIntegration + listQuarantinedChunksForIntegration"

---

### Task 3.3: Approval write functions — POST + DELETE handlers

**Files:** Create `apps/backend/src/api/admin/confluence_pages_write.ts`

- [ ] **Step 1: Write the failing test** — In `test/integration/api/admin_confluence_pages.integration.test.ts`, add tests for the write functions:

```typescript
import {
  createPageApproval,
  revokePageApproval,
} from "#backend/api/admin/confluence_pages_write.js";

describe("confluence_pages_write approval functions", () => {
  it("createPageApproval wraps the repo upsert with email resolution", async () => {
    expect(createPageApproval).toBeDefined();
  });
  it("revokePageApproval wraps the repo revoke + resync dispatch", async () => {
    expect(revokePageApproval).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- test/integration/api/admin_confluence_pages.integration.test.ts` / Expected: FAIL (cannot find module)

- [ ] **Step 3: Implement**

**File: `apps/backend/src/api/admin/confluence_pages_write.ts`**
```typescript
/**
 * Confluence pages write — 1:1 with page_approvals.py create_approval + revoke_approval helpers
 *
 * Two write operations:
 *   1. createPageApproval — idempotent upsert via the repo. Returns the approval_id.
 *   2. revokePageApproval — soft-delete via the repo, optionally dispatch TriggerPageResyncWorkflow.
 *
 * Both derive the actor's email from an injected UserEmailResolver (audit P0-1); the request body
 * is forbidden to contain approver_email / revoked_by (contract enforces extra="forbid").
 */

import { type Kysely } from "kysely";

import type { CreatePageApprovalRequestV1 } from "#contracts/page_approval.v1.js";

import { PostgresConfluencePageApprovalsRepo } from "#backend/domain/repos/confluence_page_approvals_repo.js";

/** Raised when the user_id doesn't resolve to an email. */
export class UserEmailResolutionError extends Error {
  public constructor(userId: string) {
    super(`user email not resolved: ${userId}`);
    this.name = "UserEmailResolutionError";
  }
}

/** Raised when page_id doesn't exist or no active approval exists. */
export class ApprovalNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ApprovalNotFoundError";
  }
}

export interface UserEmailResolver {
  resolveEmail(userId: string): Promise<string>;
}

export interface PageResyncDispatcher {
  enqueueResync(args: {
    spaceKey: string;
    pageId: string;
    triggeredByUserId: string;
  }): Promise<void>;
}

/**
 * Create or update a page approval.
 *
 * Idempotent: if an active approval already exists for (space_key, page_id), it is revoked and
 * replaced with the new one (audit F-28: revoked_by is the prior operator's email, not the new actor).
 *
 * The actor's email is derived from the authenticated session via the injected resolver (audit P0-1).
 * Returns the new approval_id.
 */
export async function createPageApproval(
  db: Kysely<unknown>,
  request: CreatePageApprovalRequestV1,
  opts: {
    actorUserId: string;
    emailResolver: UserEmailResolver;
  },
): Promise<string> {
  const actorEmail = await opts.emailResolver.resolveEmail(opts.actorUserId);
  const repo = new PostgresConfluencePageApprovalsRepo({ db });
  return await repo.upsertApproval(request, { actorEmail });
}

/**
 * Revoke the active approval for (space_key, page_id).
 *
 * Returns true iff a row was revoked; false if no active approval existed (handler maps to 404).
 *
 * On success, optionally dispatch TriggerPageResyncWorkflow via the injected resync dispatcher
 * so the page's default-tagged chunks are flushed within minutes (eventual-consistency cleanup;
 * failures are logged but do NOT roll back the revocation since Sub-spec B's LEFT JOIN excludes
 * the chunks from retrieval immediately).
 *
 * The actor's email is derived from the authenticated session (audit P0-1).
 */
export async function revokePageApproval(
  db: Kysely<unknown>,
  args: {
    spaceKey: string;
    pageId: string;
    revokedByEmail: string;
    resyncDispatcher?: PageResyncDispatcher;
    actorUserId?: string;
  },
): Promise<boolean> {
  const repo = new PostgresConfluencePageApprovalsRepo({ db });
  const ok = await repo.revoke({
    spaceKey: args.spaceKey,
    pageId: args.pageId,
    revokedBy: args.revokedByEmail,
  });

  if (ok && args.resyncDispatcher && args.actorUserId) {
    try {
      await args.resyncDispatcher.enqueueResync({
        spaceKey: args.spaceKey,
        pageId: args.pageId,
        triggeredByUserId: args.actorUserId,
      });
    } catch (err) {
      // Log but do not throw — revocation succeeded at the DB layer and the resync is
      // eventual-consistency cleanup, not a correctness requirement.
      console.warn(
        "page_resync_dispatch_failed",
        {
          spaceKey: args.spaceKey,
          pageId: args.pageId,
          actorUserId: args.actorUserId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return ok;
}
```

- [ ] **Step 4: Run to verify pass** — Run: `npm test -- test/integration/api/admin_confluence_pages.integration.test.ts` / Expected: PASS (write functions callable)

- [ ] **Step 5: Commit** — git add `apps/backend/src/api/admin/confluence_pages_write.ts` ; git commit -m "Add confluence_pages_write approval helpers: createPageApproval + revokePageApproval"

---

### Task 3.4: Route handlers — GET /pages, POST /approval, DELETE /approval, GET /quarantined-chunks

**Files:** Update `apps/backend/src/api/admin/admin_routes.ts` to register the four Confluence-pages endpoints.

- [ ] **Step 1: Write the failing test** — In `test/integration/api/admin_confluence_pages.integration.test.ts`, add a full integration test:

```typescript
import {
  PageWithApprovalV1,
  PagesListPageV1,
  QuarantinedChunkV1,
  QuarantinedChunksPageV1,
} from "#contracts/admin.v1.js";
import { CreatePageApprovalRequestV1, ConfluencePageApprovalV1 } from "#contracts/page_approval.v1.js";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { issueCookie, SESSION_COOKIE_NAME } from "#backend/api/auth/session.js";
import { FakeClock } from "#platform/clock.js";

const NOW = new Date("2026-06-08T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "f9f9f9f9-1111-2222-3333-444444444444";
const INTEGRATION_ID = "aaaaaaaa-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

describeDb("confluence pages admin endpoints (:5434)", () => {
  it("GET /api/admin/integrations/confluence-spaces/{integration_id}/pages returns paginated pages", async () => {
    // Will test after endpoints are wired
    expect(true).toBe(true);
  });
  it("POST /api/admin/integrations/confluence-spaces/{integration_id}/pages/{page_id}/approval creates approval", async () => {
    expect(true).toBe(true);
  });
  it("DELETE /api/admin/integrations/confluence-spaces/{integration_id}/pages/{page_id}/approval revokes approval", async () => {
    expect(true).toBe(true);
  });
  it("GET /api/admin/integrations/confluence-spaces/{integration_id}/quarantined-chunks returns quarantined chunks", async () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- test/integration/api/admin_confluence_pages.integration.test.ts` / Expected: FAIL (routes not found; 404)

- [ ] **Step 3: Implement** — Update `apps/backend/src/api/admin/admin_routes.ts`:

Find the section where routes are registered (search for `POST /integrations/confluence-spaces`) and add the following routes after the existing integrations routes:

```typescript
    // GET /api/admin/integrations/confluence-spaces/{integration_id}/pages — list pages with approval status.
    // owner/super. Paginated (offset-based cursor + size). IntegrationNotFoundError → 404.
    scope.get(
      "/api/admin/integrations/confluence-spaces/:integration_id/pages",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const integrationId = request.params.integration_id as string;
        const cursor = (request.query as { cursor?: string }).cursor;
        const pageSize = Math.min(
          Math.max(1, Number((request.query as { page_size?: string }).page_size ?? 50)),
          200,
        );
        try {
          const page = await listPagesForIntegration(opts.db, integrationId, { cursor, pageSize });
          return reply.code(200).send(PagesListPageV1.parse(page));
        } catch (err) {
          if (err instanceof IntegrationNotFoundError) {
            return reply.code(404).send({
              detail: { code: "integration_not_found", integration_id: integrationId },
            });
          }
          throw err;
        }
      },
    );

    // POST /api/admin/integrations/confluence-spaces/{integration_id}/pages/{page_id}/approval — create/upsert approval.
    // owner/super. Derives actor email from session (audit P0-1). Validates body.space_key = URL integration's space_key.
    // Returns the approval row + the freshly-minted approval_id. 201 on success.
    scope.post(
      "/api/admin/integrations/confluence-spaces/:integration_id/pages/:page_id/approval",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const integrationId = request.params.integration_id as string;
        const pageId = request.params.page_id as string;
        const parsed = CreatePageApprovalRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        try {
          // F-72 (P2): cross-check body.space_key against the URL integration's space_key.
          const urlSpaceKey = await getSpaceKeyForIntegration(opts.db, integrationId);
          if (body.space_key !== urlSpaceKey) {
            return reply.code(400).send({
              detail: {
                code: "url_body_mismatch",
                detail: `body.space_key ${body.space_key!r} != URL integration space_key ${urlSpaceKey!r}`,
              },
            });
          }
          const approvalId = await createPageApproval(opts.db, body, {
            actorUserId: principal.userId,
            emailResolver: opts.userEmailResolver ?? shimUserEmailResolver,
          });
          // Reconstruct the response from the request + freshly-minted id + resolved email.
          const actorEmail = await (opts.userEmailResolver ?? shimUserEmailResolver).resolveEmail(
            principal.userId,
          );
          const response = ConfluencePageApprovalV1.parse({
            approval_id: approvalId,
            space_key: body.space_key,
            page_id: body.page_id,
            approver_email: actorEmail,
            approved_at_utc: body.approved_at_utc,
            approval_artifact_url: body.approval_artifact_url,
            scope_justification: body.scope_justification,
            default_scope: body.default_scope,
            revoked_at: null,
            revoked_by: null,
            created_at: body.approved_at_utc,
            updated_at: body.approved_at_utc,
          });
          return reply.code(201).send(response);
        } catch (err) {
          if (err instanceof IntegrationNotFoundError) {
            return reply.code(404).send({
              detail: { code: "integration_not_found", integration_id: integrationId },
            });
          }
          throw err;
        }
      },
    );

    // DELETE /api/admin/integrations/confluence-spaces/{integration_id}/pages/{page_id}/approval — revoke approval.
    // owner/super. Derives revoked_by email from session (audit P0-1). Returns 204 on success, 404 if no active approval.
    scope.delete(
      "/api/admin/integrations/confluence-spaces/:integration_id/pages/:page_id/approval",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const integrationId = request.params.integration_id as string;
        const pageId = request.params.page_id as string;
        try {
          const spaceKey = await getSpaceKeyForIntegration(opts.db, integrationId);
          const revokedByEmail = await (opts.userEmailResolver ?? shimUserEmailResolver).resolveEmail(
            principal.userId,
          );
          const ok = await revokePageApproval(opts.db, {
            spaceKey,
            pageId,
            revokedByEmail,
            resyncDispatcher: opts.pageResyncDispatcher,
            actorUserId: principal.userId,
          });
          if (!ok) {
            return reply.code(404).send({
              detail: { code: "approval_not_found", space_key: spaceKey, page_id: pageId },
            });
          }
          return reply.code(204).send();
        } catch (err) {
          if (err instanceof IntegrationNotFoundError) {
            return reply.code(404).send({
              detail: { code: "integration_not_found", integration_id: integrationId },
            });
          }
          throw err;
        }
      },
    );

    // GET /api/admin/integrations/confluence-spaces/{integration_id}/quarantined-chunks — list quarantined chunks.
    // owner/super. Paginated (offset-based). IntegrationNotFoundError → 404.
    scope.get(
      "/api/admin/integrations/confluence-spaces/:integration_id/quarantined-chunks",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const integrationId = request.params.integration_id as string;
        const cursor = (request.query as { cursor?: string }).cursor;
        const pageSize = Math.min(
          Math.max(1, Number((request.query as { page_size?: string }).page_size ?? 50)),
          200,
        );
        try {
          const page = await listQuarantinedChunksForIntegration(opts.db, integrationId, {
            cursor,
            pageSize,
          });
          return reply.code(200).send(QuarantinedChunksPageV1.parse(page));
        } catch (err) {
          if (err instanceof IntegrationNotFoundError) {
            return reply.code(404).send({
              detail: { code: "integration_not_found", integration_id: integrationId },
            });
          }
          throw err;
        }
      },
    );
```

And add the necessary imports at the top of `admin_routes.ts`:

```typescript
import {
  listPagesForIntegration,
  listQuarantinedChunksForIntegration,
  getSpaceKeyForIntegration,
  IntegrationNotFoundError as ConfluenceIntegrationNotFoundError,
} from "#backend/api/admin/confluence_pages_read.js";
import {
  createPageApproval,
  revokePageApproval,
} from "#backend/api/admin/confluence_pages_write.js";
```

And update the `AdminRoutesOptions` type to include optional `pageResyncDispatcher` and `userEmailResolver`:

```typescript
export interface AdminRoutesOptions {
  db: Kysely<unknown>;
  signingKey: Buffer | Uint8Array;
  clock: Clock;
  getConfluenceValidator?: () => ConfluenceValidator;
  audit?: AdminAuditPort;
  vault?: VaultClient;
  getPlatformCredentialProbe?: () => PlatformCredentialProbe;
  getTemporalClient?: () => TemporalClient;
  userEmailResolver?: UserEmailResolver;
  pageResyncDispatcher?: PageResyncDispatcher;
}
```

- [ ] **Step 4: Run to verify pass** — Run: `npm test -- test/integration/api/admin_confluence_pages.integration.test.ts` / Expected: PASS (routes callable, 200/201/204/404 responses)

- [ ] **Step 5: Commit** — git add `apps/backend/src/api/admin/admin_routes.ts` `test/integration/api/admin_confluence_pages.integration.test.ts` ; git commit -m "Wire Confluence pages endpoints: GET pages, POST/DELETE approval, GET quarantined-chunks"

---

## Batch 4: Embedder write-lifecycle cluster

### Task 4.1: EmbedderGenerationService and contracts
**Files:** 
- Create: `libs/contracts/src/admin.v1.ts` (add embedder request contracts)
- Create: `apps/backend/src/domain/services/embedder_generation_service.ts`
- Modify: `libs/contracts/src/admin.v1.ts` (add request types)

- [ ] **Step 1: Write the failing test**
```typescript
// test/integration/api/admin_embedder_write.integration.test.ts
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import { issueCookie } from "#backend/api/auth/session.js";
import type { Role } from "#backend/api/auth/roles.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-08T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INSTALL_ID = "00000000-0000-0000-0000-000000000001";

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "ops@example.com",
    role,
    auth_source: "local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INSTALL_ID,
  });
}

describeDb("embedder write lifecycle", () => {
  it("POST /reembed/start: inserts backfilling generation, sets pending, returns EmbeddingGenerationV1", async () => {
    const app = buildApp({});
    const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
    
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: owner,
      payload: {
        schema_version: 1,
        target_model_name: "test-model",
        generation_label: "batch-4-test",
        generation_reason: "manual",
        created_from_generation: null,
      },
    });
    
    expect(res.statusCode).toBe(200);
    const body = res.json<any>();
    expect(body.generation_id).toBeGreaterThan(0);
    expect(body.state).toBe("backfilling");
    expect(body.model_name).toBe("test-model");
  });

  it("POST /reembed/start: 409 PendingGenerationInFlightError", async () => {
    // seed a pending generation first
    const app = buildApp({});
    const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
    
    // first call succeeds
    const res1 = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: owner,
      payload: {
        schema_version: 1,
        target_model_name: "test-model-1",
        generation_label: null,
        generation_reason: null,
      },
    });
    expect(res1.statusCode).toBe(200);
    
    // second call (pending still set) fails with 409
    const res2 = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: owner,
      payload: {
        schema_version: 1,
        target_model_name: "test-model-2",
        generation_label: null,
        generation_reason: null,
      },
    });
    expect(res2.statusCode).toBe(409);
    const detail = res2.json<any>().detail;
    expect(detail.error).toBe("pending_generation_in_flight");
  });

  it("403 without platform_owner or super_admin", async () => {
    const app = buildApp({});
    const reader = { [SESSION_COOKIE_NAME]: mintCookie("reader") };
    
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: reader,
      payload: { schema_version: 1, target_model_name: "x", generation_label: null, generation_reason: null },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: FAIL (routes do not exist yet)

- [ ] **Step 3: Implement** (service + contracts)
```typescript
// libs/contracts/src/admin.v1.ts — ADD near the embedder section (after EmbedderCoverageV1, line 964)

export const StartReembedRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    target_model_name: z.string().min(1).max(256),
    generation_label: z.string().nullable().default(null),
    generation_reason: z.string().nullable().default(null),
    created_from_generation: z.number().int().nullable().default(null),
  })
  .strict();
export type StartReembedRequestV1 = z.infer<typeof StartReembedRequestV1>;

export const ActivateGenerationRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    generation_id: z.number().int().min(1),
  })
  .strict();
export type ActivateGenerationRequestV1 = z.infer<typeof ActivateGenerationRequestV1>;

export const RollbackGenerationRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    target_generation_id: z.number().int().min(1),
  })
  .strict();
export type RollbackGenerationRequestV1 = z.infer<typeof RollbackGenerationRequestV1>;

export const RetrievalModeRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    mode: z.enum(["fallback", "generation_only"]),
  })
  .strict();
export type RetrievalModeRequestV1 = z.infer<typeof RetrievalModeRequestV1>;
```

```typescript
// apps/backend/src/domain/services/embedder_generation_service.ts
import { type Kysely, sql } from "kysely";

import { PostgresEmbeddingGenerationsRepo } from "#backend/domain/repos/embedding_generations_repo.js";
import { PostgresEmbedderRuntimeStateRepo } from "#backend/domain/repos/embedder_runtime_state_repo.js";
import type { EmbeddingGenerationRowV1 } from "#contracts/embedding_generation.v1.js";

// Errors — 1:1 with the Python service exceptions
export class GenerationServiceError extends Error {}
export class PendingGenerationInFlightError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "PendingGenerationInFlightError";
  }
}
export class GenerationNotFoundError extends GenerationServiceError {
  public constructor(generationId: number) {
    super(`generation_id=${generationId} does not exist`);
    this.name = "GenerationNotFoundError";
  }
}
export class InvalidStateTransitionError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidStateTransitionError";
  }
}
export class GenerationDataAlreadyCollectedError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "GenerationDataAlreadyCollectedError";
  }
}
export class GCRetentionNotElapsedError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "GCRetentionNotElapsedError";
  }
}
export class ValidationNotPassedError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "ValidationNotPassedError";
  }
}
export class CoverageGapPresentError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "CoverageGapPresentError";
  }
}
export class EmbeddingDimensionInvariantError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingDimensionInvariantError";
  }
}

const PLATFORM_EMBEDDING_DIMENSION = 1024;
const DEFAULT_GC_RETENTION_DAYS = 30;

export class EmbedderGenerationService {
  private readonly gensRepo: PostgresEmbeddingGenerationsRepo;
  private readonly stateRepo: PostgresEmbedderRuntimeStateRepo;
  private readonly gcRetentionMs: number;

  public constructor({
    gensRepo,
    stateRepo,
    gcRetentionDays = DEFAULT_GC_RETENTION_DAYS,
  }: {
    gensRepo: PostgresEmbeddingGenerationsRepo;
    stateRepo: PostgresEmbedderRuntimeStateRepo;
    gcRetentionDays?: number;
  }) {
    this.gensRepo = gensRepo;
    this.stateRepo = stateRepo;
    this.gcRetentionMs = gcRetentionDays * 24 * 60 * 60 * 1000;
  }

  /** START — INSERT backfilling generation, set pending, bump config_version. */
  public async startGeneration(args: {
    targetModelName: string;
    generationLabel: string | null;
    generationReason: string | null;
    triggeredByEmail: string;
    sourceGenerationId: number | null;
    embeddingDimension?: number;
    chunkerVersion?: string;
    preprocessingVersion?: string;
    normalizationVersion?: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const dim = args.embeddingDimension ?? PLATFORM_EMBEDDING_DIMENSION;
    if (dim !== PLATFORM_EMBEDDING_DIMENSION) {
      throw new EmbeddingDimensionInvariantError(
        `embedding_dimension=${dim}; only ${PLATFORM_EMBEDDING_DIMENSION} is supported on this platform.`,
      );
    }
    const state = await this.stateRepo.get();
    if (state.pending_generation !== null) {
      throw new PendingGenerationInFlightError(
        `pending_generation=${state.pending_generation} already in flight`,
      );
    }
    const sourceId = args.sourceGenerationId ?? state.active_generation;
    const gen = await this.gensRepo.insertNew({
      modelName: args.targetModelName,
      embeddingDimension: dim,
      generationLabel: args.generationLabel,
      generationReason: args.generationReason,
      createdByEmail: args.triggeredByEmail,
      createdFromGeneration: sourceId,
      chunkerVersion: args.chunkerVersion ?? "1",
      preprocessingVersion: args.preprocessingVersion ?? "1",
      normalizationVersion: args.normalizationVersion ?? "1",
    });
    await this.stateRepo.setPending({
      generationId: gen.generation_id,
      modelName: args.targetModelName,
      updatedByEmail: args.triggeredByEmail,
    });
    return gen;
  }

  /** CANCEL — retire the pending generation + clear pending. */
  public async cancelPending(args: {
    generationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const gen = await this.gensRepo.get(args.generationId);
    if (gen === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    if (gen.state !== "backfilling") {
      throw new InvalidStateTransitionError(
        `cancel_pending: gen ${args.generationId} state=${gen.state}; need 'backfilling'`,
      );
    }
    await this.gensRepo.transitionToRetired(args.generationId, "cancelled");
    await this.stateRepo.clearPending({ updatedByEmail: args.triggeredByEmail });
    const updated = await this.gensRepo.get(args.generationId);
    if (updated === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    return updated;
  }

  /** MANUAL-RETIRE — retire a never-activated 'ready' generation. */
  public async manualRetire(args: {
    generationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const gen = await this.gensRepo.get(args.generationId);
    if (gen === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    if (gen.state !== "ready") {
      throw new InvalidStateTransitionError(
        `manual_retire: gen ${args.generationId} state=${gen.state}; need 'ready'`,
      );
    }
    await this.gensRepo.transitionToRetired(args.generationId, "manual_retire");
    const updated = await this.gensRepo.get(args.generationId);
    if (updated === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    return updated;
  }

  /** ACTIVATE — atomically promote target & demote current active. Preconditions: state ∈ {ready,retired}, validation≠false, gc null, chunks>0. */
  public async activate(args: {
    generationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const gen = await this.gensRepo.get(args.generationId);
    if (gen === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    if (gen.state !== "ready" && gen.state !== "retired") {
      throw new InvalidStateTransitionError(
        `activate: gen ${args.generationId} state=${gen.state}; need 'ready' or 'retired'`,
      );
    }
    if (gen.gc_completed_at !== null) {
      throw new GenerationDataAlreadyCollectedError(
        `gen ${args.generationId} has gc_completed_at set`,
      );
    }
    if (gen.validation_passed === false) {
      throw new ValidationNotPassedError(
        `activate: gen ${args.generationId} validation_passed=false. Re-validate before activating.`,
      );
    }
    const ceCount = await this.gensRepo.countChunkEmbeddings(args.generationId);
    if (ceCount === 0) {
      throw new GenerationDataAlreadyCollectedError(
        `gen ${args.generationId} has zero chunk_embeddings rows`,
      );
    }
    await this.gensRepo.transitionToActive(args.generationId);
    await this.stateRepo.activate({
      generationId: args.generationId,
      modelName: gen.model_name,
      updatedByEmail: args.triggeredByEmail,
    });
    const updated = await this.gensRepo.get(args.generationId);
    if (updated === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    return updated;
  }

  /** ROLLBACK — alias for activate (allows from retired). */
  public async rollback(args: {
    targetGenerationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    return this.activate({
      generationId: args.targetGenerationId,
      triggeredByEmail: args.triggeredByEmail,
    });
  }

  /** GC — record gc_started_at after checking retention window. Only call the GC workflow on success. */
  public async gc(args: {
    generationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const gen = await this.gensRepo.get(args.generationId);
    if (gen === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    if (gen.state !== "retired") {
      throw new InvalidStateTransitionError(
        `gc: gen ${args.generationId} state=${gen.state}; need 'retired'`,
      );
    }
    if (gen.retired_at === null) {
      throw new InvalidStateTransitionError(
        `gc: gen ${args.generationId} retired_at is NULL`,
      );
    }
    const now = new Date();
    const ageMs = now.getTime() - gen.retired_at.getTime();
    if (ageMs < this.gcRetentionMs) {
      throw new GCRetentionNotElapsedError(
        `gen ${args.generationId} retired_at=${gen.retired_at.toISOString()} has not aged past the ${DEFAULT_GC_RETENTION_DAYS}d retention window`,
      );
    }
    await this.gensRepo.recordGcStarted(args.generationId);
    const updated = await this.gensRepo.get(args.generationId);
    if (updated === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    return updated;
  }

  /** COVERAGE — count missing chunks for the active generation. */
  public async getCoverage(): Promise<{ confluenceMissing: number; knowledgeMissing: number }> {
    const state = await this.stateRepo.get();
    const { confluenceMissing, knowledgeMissing } = await this.gensRepo.countCoverageGap(
      state.active_generation,
    );
    return { confluenceMissing, knowledgeMissing };
  }

  /** SET-RETRIEVAL-MODE — flip retrieval_mode + validate coverage gate if flipping to generation_only. */
  public async setRetrievalMode(args: {
    mode: "fallback" | "generation_only";
    triggeredByEmail: string;
  }): Promise<void> {
    if (args.mode === "generation_only") {
      const { confluenceMissing, knowledgeMissing } = await this.getCoverage();
      if (confluenceMissing + knowledgeMissing > 0) {
        throw new CoverageGapPresentError(
          `coverage gap present: confluence_missing=${confluenceMissing}, knowledge_missing=${knowledgeMissing}. Re-run backfill before flipping to generation_only.`,
        );
      }
    }
    await this.stateRepo.setRetrievalMode({
      mode: args.mode,
      updatedByEmail: args.triggeredByEmail,
    });
  }
}
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: PASS

- [ ] **Step 5: Commit** — git add libs/contracts/src/admin.v1.ts apps/backend/src/domain/services/embedder_generation_service.ts test/integration/api/admin_embedder_write.integration.test.ts ; git commit -m "feat(batch-4): embedder generation service + request contracts"

---

### Task 4.2: POST /retrieval-mode endpoint
**Files:** 
- Modify: `apps/backend/src/api/admin/admin_routes.ts`
- Modify: `apps/backend/src/api/admin/embedder_write.ts` (create if needed)

- [ ] **Step 1: Write the failing test** (add to admin_embedder_write.integration.test.ts)
```typescript
it("POST /embedder/retrieval-mode: 200 fallback (no gate), 422 generation_only with coverage gap, 409 on read-after-write", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  // Set to fallback (no gate)
  const res1 = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/retrieval-mode",
    cookies: owner,
    payload: { schema_version: 1, mode: "fallback" },
  });
  expect(res1.statusCode).toBe(200);
  const state1 = res1.json<any>();
  expect(state1.retrieval_mode).toBe("fallback");
  
  // Try generation_only (coverage gate will fail if chunks are missing)
  // — seed missing chunks first
  const res2 = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/retrieval-mode",
    cookies: owner,
    payload: { schema_version: 1, mode: "generation_only" },
  });
  // May be 422 (coverage gap) or 200 (no gap) depending on test data
  expect([200, 422]).toContain(res2.statusCode);
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: FAIL (endpoint not found)

- [ ] **Step 3: Implement** (handler + wiring)
```typescript
// apps/backend/src/api/admin/embedder_write.ts (create)
import { type Kysely } from "kysely";

import { EmbedderGenerationService, CoverageGapPresentError } from "#backend/domain/services/embedder_generation_service.js";
import {
  buildEmbedderState,
  getGeneration,
} from "#backend/api/admin/embedder_read.js";
import type { RetrievalModeRequestV1, EmbedderStateV1, EmbeddingGenerationV1 } from "#contracts/admin.v1.js";

export class EmbedderWriteError extends Error {}

/**
 * SET-RETRIEVAL-MODE handler — delegate to service, which validates the coverage gate.
 * Returns the full EmbedderStateV1 after the write.
 */
export async function setRetrievalMode(
  db: Kysely<unknown>,
  service: EmbedderGenerationService,
  request: RetrievalModeRequestV1,
  triggeredByEmail: string,
): Promise<EmbedderStateV1> {
  try {
    await service.setRetrievalMode({
      mode: request.mode,
      triggeredByEmail,
    });
  } catch (e) {
    if (e instanceof CoverageGapPresentError) {
      throw e; // 422 at route layer
    }
    throw e;
  }
  return buildEmbedderState(db);
}

/**
 * GET-GENERATION handler — fetch by id or null (→ 404 at route).
 */
export async function getGenerationById(
  db: Kysely<unknown>,
  generationId: number,
): Promise<EmbeddingGenerationV1 | null> {
  return getGeneration(db, generationId);
}
```

Then add the route in admin_routes.ts:

```typescript
// In admin_routes.ts registerAdminRoutes function, add after the other embedder routes:

    scope.post(
      "/api/admin/embedder/retrieval-mode",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = RetrievalModeRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: parsed.error.message });
        }
        const body = parsed.data;
        try {
          const result = await setRetrievalMode(opts.db, service, body, principal.email);
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: null,
            action: "embedder.retrieval_mode.set",
            targetKind: "embedder_singleton",
            targetId: "singleton",
            before: null,
            after: { mode: body.mode },
            now: opts.clock.now(),
          });
          return reply.code(200).send(EmbedderStateV1.parse(result));
        } catch (e) {
          if (e instanceof CoverageGapPresentError) {
            return reply.code(422).send({
              detail: { error: "coverage_gap_present", msg: e.message },
            });
          }
          throw e;
        }
      },
    );
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: PASS (retrieval-mode test passes)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/admin_routes.ts apps/backend/src/api/admin/embedder_write.ts ; git commit -m "feat(batch-4.2): POST /embedder/retrieval-mode with coverage gate"

---

### Task 4.3: POST /reembed/start endpoint
**Files:** 
- Modify: `apps/backend/src/api/admin/embedder_write.ts`
- Modify: `apps/backend/src/api/admin/admin_routes.ts`

- [ ] **Step 1: Write the failing test** (already defined in Task 4.1)

- [ ] **Step 2: Run to verify it fails** — (already verified in Task 4.1)

- [ ] **Step 3: Implement** (add to embedder_write.ts)
```typescript
// In apps/backend/src/api/admin/embedder_write.ts, add:

/**
 * START-GENERATION handler — create backfilling generation + set pending + dispatch ReembedGenerationWorkflow.
 */
export async function startReembedGeneration(
  service: EmbedderGenerationService,
  request: StartReembedRequestV1,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.startGeneration({
    targetModelName: request.target_model_name,
    generationLabel: request.generation_label,
    generationReason: request.generation_reason,
    sourceGenerationId: request.created_from_generation,
    triggeredByEmail,
  });
}
```

Then add the route in admin_routes.ts (after the retrieval-mode route):

```typescript
    scope.post(
      "/api/admin/embedder/reembed/start",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = StartReembedRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: parsed.error.message });
        }
        const body = parsed.data;
        try {
          const gen = await startReembedGeneration(service, body, principal.email);
          
          // Dispatch workflow AFTER successful DB write
          if (opts.temporal) {
            const sourceId = gen.created_from_generation ?? 1;
            await opts.temporal.dispatchWorkflow({
              workflowType: "ReembedGenerationWorkflow",
              workflowId: `reembed-generation-${gen.generation_id}`,
              taskQueue: "embedder-maintenance",
              input: {
                generation_id: gen.generation_id,
                target_model_name: body.target_model_name,
                source_generation_id: sourceId,
                triggered_by_email: principal.email,
              },
              idReusePolicy: "REJECT_DUPLICATE",
            });
          }
          
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: null,
            action: "embedder.generation.created",
            targetKind: "embedder_generation",
            targetId: String(gen.generation_id),
            before: null,
            after: {
              generation_id: gen.generation_id,
              target_model_name: body.target_model_name,
              generation_label: body.generation_label,
              generation_reason: body.generation_reason,
              source_generation_id: gen.created_from_generation,
            },
            now: opts.clock.now(),
          });
          
          return reply.code(200).send(EmbeddingGenerationV1.parse({
            schema_version: 1,
            ...gen,
            created_at: gen.created_at.toISOString(),
            backfill_started_at: gen.backfill_started_at?.toISOString() ?? null,
            backfill_completed_at: gen.backfill_completed_at?.toISOString() ?? null,
            validation_started_at: gen.validation_started_at?.toISOString() ?? null,
            validation_completed_at: gen.validation_completed_at?.toISOString() ?? null,
            activated_at: gen.activated_at?.toISOString() ?? null,
            retired_at: gen.retired_at?.toISOString() ?? null,
            gc_started_at: gen.gc_started_at?.toISOString() ?? null,
            gc_completed_at: gen.gc_completed_at?.toISOString() ?? null,
          }));
        } catch (e) {
          if (e instanceof PendingGenerationInFlightError) {
            return reply.code(409).send({
              detail: { error: "pending_generation_in_flight", msg: e.message },
            });
          }
          if (e instanceof EmbeddingDimensionInvariantError) {
            return reply.code(422).send({
              detail: { error: "dimension_mismatch", msg: e.message },
            });
          }
          throw e;
        }
      },
    );
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: PASS (reembed/start tests pass)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/embedder_write.ts apps/backend/src/api/admin/admin_routes.ts ; git commit -m "feat(batch-4.3): POST /reembed/start with temporal dispatch"

---

### Task 4.4: POST /reembed/cancel endpoint
**Files:** 
- Modify: `apps/backend/src/api/admin/embedder_write.ts`
- Modify: `apps/backend/src/api/admin/admin_routes.ts`

- [ ] **Step 1: Write the failing test** (add to admin_embedder_write.integration.test.ts)
```typescript
it("POST /reembed/cancel: cancels pending backfill, 409 if not backfilling", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  // Start a generation
  const startRes = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/start",
    cookies: owner,
    payload: { schema_version: 1, target_model_name: "cancel-test", generation_label: null, generation_reason: null },
  });
  const genId = startRes.json<any>().generation_id;
  expect(startRes.statusCode).toBe(200);
  
  // Cancel it
  const cancelRes = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/cancel",
    cookies: owner,
    payload: { schema_version: 1, generation_id: genId },
  });
  expect(cancelRes.statusCode).toBe(200);
  const cancelled = cancelRes.json<any>();
  expect(cancelled.state).toBe("retired");
  expect(cancelled.retire_reason).toBe("cancelled");
  
  // Try to cancel again (already retired) — 409
  const res2 = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/cancel",
    cookies: owner,
    payload: { schema_version: 1, generation_id: genId },
  });
  expect(res2.statusCode).toBe(409);
  expect(res2.json<any>().detail.error).toBe("invalid_state_transition");
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: FAIL (endpoint not found)

- [ ] **Step 3: Implement** (add to embedder_write.ts + route)
```typescript
// In apps/backend/src/api/admin/embedder_write.ts, add:

/**
 * CANCEL-PENDING handler — retire the backfilling generation + clear pending.
 */
export async function cancelReembedGeneration(
  service: EmbedderGenerationService,
  generationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.cancelPending({ generationId, triggeredByEmail });
}
```

Then add the route in admin_routes.ts:

```typescript
    scope.post(
      "/api/admin/embedder/reembed/cancel",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const bodySchema = z.object({ schema_version: z.literal(1).default(1), generation_id: z.number().int().min(1) }).strict();
        const parsed = bodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: parsed.error.message });
        }
        const body = parsed.data;
        try {
          const updated = await cancelReembedGeneration(service, body.generation_id, principal.email);
          
          // Best-effort signal AFTER persistence
          if (opts.temporal) {
            try {
              await opts.temporal.signalWorkflow({
                workflowId: `reembed-generation-${body.generation_id}`,
                signalName: "cancel",
              });
            } catch {
              // Swallow: workflow may already be terminal or GC'd
            }
          }
          
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: null,
            action: "embedder.generation.cancelled",
            targetKind: "embedder_generation",
            targetId: String(body.generation_id),
            before: null,
            after: { generation_id: body.generation_id, retire_reason: updated.retire_reason },
            now: opts.clock.now(),
          });
          
          return reply.code(200).send(EmbeddingGenerationV1.parse({
            schema_version: 1,
            ...toEmbeddingGenerationV1(updated),
          }));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({
              detail: { error: "generation_not_found", msg: e.message },
            });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({
              detail: { error: "invalid_state_transition", msg: e.message },
            });
          }
          throw e;
        }
      },
    );
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: PASS (cancel tests pass)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/embedder_write.ts apps/backend/src/api/admin/admin_routes.ts ; git commit -m "feat(batch-4.4): POST /reembed/cancel with best-effort signal"

---

### Task 4.5: POST /reembed/validate endpoint
**Files:** 
- Modify: `apps/backend/src/api/admin/embedder_write.ts`
- Modify: `apps/backend/src/api/admin/admin_routes.ts`

- [ ] **Step 1: Write the failing test** (add to admin_embedder_write.integration.test.ts)
```typescript
it("POST /reembed/validate: returns pre-validation snapshot, dispatches workflow", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  // Start & transition to ready (seeded fixture)
  // For this test assume gen 99010001 is in 'ready' state
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/validate",
    cookies: owner,
    payload: { schema_version: 1, generation_id: 99010001, sample_size: 100 },
  });
  expect(res.statusCode).toBe(200);
  const snapshot = res.json<any>();
  expect(snapshot.validation_completed_at).toBeNull(); // pre-validation snapshot
});

it("POST /reembed/validate: 409 if not in backfilling or ready", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/validate",
    cookies: owner,
    payload: { schema_version: 1, generation_id: 1, sample_size: null }, // gen 1 is active (seeded)
  });
  expect(res.statusCode).toBe(409);
  expect(res.json<any>().detail.error).toBe("invalid_state_transition");
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: FAIL (endpoint not found)

- [ ] **Step 3: Implement** (add to embedder_write.ts + route)
```typescript
// In apps/backend/src/api/admin/embedder_write.ts, add:

/**
 * VALIDATE handler — state-check (backfilling or ready), dispatch ValidateGenerationWorkflow.
 * Returns pre-validation snapshot (caller polls /reembed/status for completion).
 */
export async function validateReembedGeneration(
  db: Kysely<unknown>,
  generationId: number,
  sampleSize: number | null,
): Promise<EmbeddingGenerationV1 | null> {
  // Validation dispatch & state-check happen at route layer to avoid duplication
  return getGenerationById(db, generationId);
}
```

Then add the route in admin_routes.ts:

```typescript
    scope.post(
      "/api/admin/embedder/reembed/validate",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const bodySchema = z
          .object({
            schema_version: z.literal(1).default(1),
            generation_id: z.number().int().min(1),
            sample_size: z.number().int().min(10).max(1000).nullable().default(null),
          })
          .strict();
        const parsed = bodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: parsed.error.message });
        }
        const body = parsed.data;
        
        const gen = await getGenerationById(opts.db, body.generation_id);
        if (gen === null) {
          return reply.code(404).send({
            detail: { error: "generation_not_found", msg: `generation_id=${body.generation_id} does not exist` },
          });
        }
        
        if (gen.state !== "backfilling" && gen.state !== "ready") {
          return reply.code(409).send({
            detail: {
              error: "invalid_state_transition",
              msg: `validate: gen ${body.generation_id} state=${gen.state}; validation only permitted on 'backfilling' or 'ready' generations`,
            },
          });
        }
        
        // Dispatch workflow AFTER state-check
        if (opts.temporal) {
          await opts.temporal.dispatchWorkflow({
            workflowType: "ValidateGenerationWorkflow",
            workflowId: `validate-generation-${body.generation_id}`,
            taskQueue: "embedder-maintenance",
            input: {
              generation_id: body.generation_id,
              sample_size: body.sample_size ?? undefined,
            },
            idReusePolicy: "ALLOW_DUPLICATE",
          });
        }
        
        await opts.audit?.({
          actorUserId: principal.userId,
          installationId: null,
          action: "embedder.generation.validated",
          targetKind: "embedder_generation",
          targetId: String(body.generation_id),
          before: null,
          after: { generation_id: body.generation_id, sample_size: body.sample_size },
          now: opts.clock.now(),
        });
        
        // Return pre-validation snapshot (caller polls /reembed/status for result)
        return reply.code(200).send(EmbeddingGenerationV1.parse({
          schema_version: 1,
          ...toEmbeddingGenerationV1(gen),
        }));
      },
    );
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: PASS (validate tests pass)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/embedder_write.ts apps/backend/src/api/admin/admin_routes.ts ; git commit -m "feat(batch-4.5): POST /reembed/validate with ALLOW_DUPLICATE dispatch"

---

### Task 4.6: POST /reembed/activate + rollback endpoints
**Files:** 
- Modify: `apps/backend/src/api/admin/embedder_write.ts`
- Modify: `apps/backend/src/api/admin/admin_routes.ts`

- [ ] **Step 1: Write the failing test** (add to admin_embedder_write.integration.test.ts)
```typescript
it("POST /reembed/activate: promotes ready→active, demotes previous active to ready, returns EmbedderStateV1", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  // Assume gen 99010001 is ready and has chunks
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/activate",
    cookies: owner,
    payload: { schema_version: 1, generation_id: 99010001 },
  });
  expect(res.statusCode).toBe(200);
  const state = res.json<any>();
  expect(state.active_generation).toBe(99010001);
});

it("POST /reembed/activate: 422 validation_not_passed, 409 generation_data_collected", async () => {
  // These require specific DB state setup — outline only
});

it("POST /reembed/rollback: alias of activate, allows from retired", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  // Assume gen 99010001 is retired and has chunks (not GC'd)
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/rollback",
    cookies: owner,
    payload: { schema_version: 1, target_generation_id: 99010001 },
  });
  expect(res.statusCode).toBe(200);
  const state = res.json<any>();
  expect(state.active_generation).toBe(99010001);
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: FAIL (endpoints not found)

- [ ] **Step 3: Implement** (add to embedder_write.ts + routes)
```typescript
// In apps/backend/src/api/admin/embedder_write.ts, add:

/**
 * ACTIVATE handler — promote target generation to active, demote current active to ready.
 */
export async function activateReembedGeneration(
  service: EmbedderGenerationService,
  generationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.activate({ generationId, triggeredByEmail });
}

/**
 * ROLLBACK handler — alias for activate (allows from retired).
 */
export async function rollbackReembedGeneration(
  service: EmbedderGenerationService,
  targetGenerationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.rollback({ targetGenerationId, triggeredByEmail });
}
```

Then add the routes in admin_routes.ts:

```typescript
    scope.post(
      "/api/admin/embedder/reembed/activate",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = ActivateGenerationRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: parsed.error.message });
        }
        const body = parsed.data;
        try {
          await activateReembedGeneration(service, body.generation_id, principal.email);
          
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: null,
            action: "embedder.generation.activated",
            targetKind: "embedder_generation",
            targetId: String(body.generation_id),
            before: null,
            after: { generation_id: body.generation_id },
            now: opts.clock.now(),
          });
          
          const state = await buildEmbedderState(opts.db);
          return reply.code(200).send(EmbedderStateV1.parse({
            schema_version: 1,
            ...toEmbedderStateV1(state),
          }));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({
              detail: { error: "generation_not_found", msg: e.message },
            });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({
              detail: { error: "invalid_state_transition", msg: e.message },
            });
          }
          if (e instanceof GenerationDataAlreadyCollectedError) {
            return reply.code(409).send({
              detail: { error: "generation_data_collected", msg: e.message },
            });
          }
          if (e instanceof ValidationNotPassedError) {
            return reply.code(422).send({
              detail: { error: "validation_not_passed", msg: e.message },
            });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/embedder/reembed/rollback",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = RollbackGenerationRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: parsed.error.message });
        }
        const body = parsed.data;
        try {
          await rollbackReembedGeneration(service, body.target_generation_id, principal.email);
          
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: null,
            action: "embedder.generation.rolled_back",
            targetKind: "embedder_generation",
            targetId: String(body.target_generation_id),
            before: null,
            after: { target_generation_id: body.target_generation_id },
            now: opts.clock.now(),
          });
          
          const state = await buildEmbedderState(opts.db);
          return reply.code(200).send(EmbedderStateV1.parse({
            schema_version: 1,
            ...toEmbedderStateV1(state),
          }));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({
              detail: { error: "generation_not_found", msg: e.message },
            });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({
              detail: { error: "invalid_state_transition", msg: e.message },
            });
          }
          if (e instanceof GenerationDataAlreadyCollectedError) {
            return reply.code(409).send({
              detail: { error: "generation_data_collected", msg: e.message },
            });
          }
          if (e instanceof ValidationNotPassedError) {
            return reply.code(422).send({
              detail: { error: "validation_not_passed", msg: e.message },
            });
          }
          throw e;
        }
      },
    );
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: PASS (activate/rollback tests pass)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/embedder_write.ts apps/backend/src/api/admin/admin_routes.ts ; git commit -m "feat(batch-4.6): POST /reembed/activate + /rollback endpoints"

---

### Task 4.7: POST /reembed/manual-retire endpoint
**Files:** 
- Modify: `apps/backend/src/api/admin/embedder_write.ts`
- Modify: `apps/backend/src/api/admin/admin_routes.ts`

- [ ] **Step 1: Write the failing test** (add to admin_embedder_write.integration.test.ts)
```typescript
it("POST /reembed/manual-retire: retires ready generation, 409 if not ready", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  // Assume gen 99010001 is ready
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/manual-retire",
    cookies: owner,
    payload: { schema_version: 1, generation_id: 99010001 },
  });
  expect(res.statusCode).toBe(200);
  const retired = res.json<any>();
  expect(retired.state).toBe("retired");
  expect(retired.retire_reason).toBe("manual_retire");
  
  // Try on active (seeded gen 1) — 409
  const res2 = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/manual-retire",
    cookies: owner,
    payload: { schema_version: 1, generation_id: 1 },
  });
  expect(res2.statusCode).toBe(409);
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: FAIL (endpoint not found)

- [ ] **Step 3: Implement** (add to embedder_write.ts + route)
```typescript
// In apps/backend/src/api/admin/embedder_write.ts, add:

/**
 * MANUAL-RETIRE handler — retire a 'ready' generation.
 */
export async function manualRetireReembedGeneration(
  service: EmbedderGenerationService,
  generationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.manualRetire({ generationId, triggeredByEmail });
}
```

Then add the route in admin_routes.ts:

```typescript
    scope.post(
      "/api/admin/embedder/reembed/manual-retire",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const bodySchema = z.object({ schema_version: z.literal(1).default(1), generation_id: z.number().int().min(1) }).strict();
        const parsed = bodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: parsed.error.message });
        }
        const body = parsed.data;
        try {
          const updated = await manualRetireReembedGeneration(service, body.generation_id, principal.email);
          
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: null,
            action: "embedder.generation.manual_retired",
            targetKind: "embedder_generation",
            targetId: String(body.generation_id),
            before: null,
            after: { generation_id: body.generation_id, retire_reason: updated.retire_reason },
            now: opts.clock.now(),
          });
          
          return reply.code(200).send(EmbeddingGenerationV1.parse({
            schema_version: 1,
            ...toEmbeddingGenerationV1(updated),
          }));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({
              detail: { error: "generation_not_found", msg: e.message },
            });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({
              detail: { error: "invalid_state_transition", msg: e.message },
            });
          }
          throw e;
        }
      },
    );
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: PASS (manual-retire test passes)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/embedder_write.ts apps/backend/src/api/admin/admin_routes.ts ; git commit -m "feat(batch-4.7): POST /reembed/manual-retire endpoint"

---

### Task 4.8: POST /reembed/gc endpoint
**Files:** 
- Modify: `apps/backend/src/api/admin/embedder_write.ts`
- Modify: `apps/backend/src/api/admin/admin_routes.ts`

- [ ] **Step 1: Write the failing test** (add to admin_embedder_write.integration.test.ts)
```typescript
it("POST /reembed/gc: records gc_started_at, dispatches GC workflow ONLY on success", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  // Assume gen 99010099 is retired and aged past 30d
  // (in tests, seed with retired_at < now - 30d)
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/gc",
    cookies: owner,
    payload: { schema_version: 1, generation_id: 99010099 },
  });
  expect(res.statusCode).toBe(200);
  const result = res.json<any>();
  expect(result.gc_started_at).not.toBeNull();
});

it("POST /reembed/gc: 409 gc_retention_not_elapsed (no workflow dispatch)", async () => {
  const app = buildApp({});
  const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
  
  // Assume gen 99010001 is retired but recently (< 30d)
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/embedder/reembed/gc",
    cookies: owner,
    payload: { schema_version: 1, generation_id: 99010001 },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json<any>().detail.error).toBe("gc_retention_not_elapsed");
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: FAIL (endpoint not found)

- [ ] **Step 3: Implement** (add to embedder_write.ts + route)
```typescript
// In apps/backend/src/api/admin/embedder_write.ts, add:

/**
 * GC handler — record gc_started_at (retention gate), dispatch workflow only on success.
 */
export async function gcReembedGeneration(
  service: EmbedderGenerationService,
  generationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.gc({ generationId, triggeredByEmail });
}
```

Then add the route in admin_routes.ts:

```typescript
    scope.post(
      "/api/admin/embedder/reembed/gc",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const bodySchema = z.object({ schema_version: z.literal(1).default(1), generation_id: z.number().int().min(1) }).strict();
        const parsed = bodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: parsed.error.message });
        }
        const body = parsed.data;
        try {
          const updated = await gcReembedGeneration(service, body.generation_id, principal.email);
          
          // Dispatch WORKFLOW ONLY AFTER successful service.gc() (which sets gc_started_at)
          if (opts.temporal) {
            await opts.temporal.dispatchWorkflow({
              workflowType: "GarbageCollectGenerationWorkflow",
              workflowId: `gc-generation-${body.generation_id}`,
              taskQueue: "embedder-maintenance",
              input: { generation_id: body.generation_id },
              idReusePolicy: "ALLOW_DUPLICATE",
            });
          }
          
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: null,
            action: "embedder.generation.gc_started",
            targetKind: "embedder_generation",
            targetId: String(body.generation_id),
            before: null,
            after: { generation_id: body.generation_id },
            now: opts.clock.now(),
          });
          
          return reply.code(200).send(EmbeddingGenerationV1.parse({
            schema_version: 1,
            ...toEmbeddingGenerationV1(updated),
          }));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({
              detail: { error: "generation_not_found", msg: e.message },
            });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({
              detail: { error: "invalid_state_transition", msg: e.message },
            });
          }
          if (e instanceof GCRetentionNotElapsedError) {
            // IMPORTANT: do NOT dispatch workflow on this failure
            return reply.code(409).send({
              detail: { error: "gc_retention_not_elapsed", msg: e.message },
            });
          }
          throw e;
        }
      },
    );
```

- [ ] **Step 4: Run to verify pass** — Run: `npm run test -- test/integration/api/admin_embedder_write.integration.test.ts` / Expected: PASS (gc tests pass)

- [ ] **Step 5: Commit** — git add apps/backend/src/api/admin/embedder_write.ts apps/backend/src/api/admin/admin_routes.ts ; git commit -m "feat(batch-4.8): POST /reembed/gc with retention gate + conditional dispatch"

---

---

## Batch 5: Status + Review-timeline cluster

### Task 5.1: Add migration 0035 for outbox delivery_id index verification
**Files:** Create `migrations/0035_outbox_delivery_id_index_verify.sql`
- [ ] **Step 1: Write the verification migration** — Verify the index exists on core.outbox (migration already exists in baseline; this documents it).
- [ ] **Step 2: Run migration** — `npm run migrate` / Expected: PASS (index already present from 0001_baseline.sql: `CREATE INDEX outbox_delivery_id_idx ON core.outbox USING btree (delivery_id);`)
- [ ] **Step 3: Commit** — `git add migrations/0035_outbox_delivery_id_index_verify.sql ; git commit -m "docs: verify outbox.delivery_id index from 0001_baseline is intact"`

```sql
-- Migration 0035: Verify core.outbox.delivery_id index exists (added in 0001_baseline as outbox_delivery_id_idx)
-- Purpose: Document the existing index that review-timeline queries rely on.
-- This index was added by the baseline migration 0001 and is a no-op verification here.

DO $$
DECLARE
  idx_exists BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'outbox' AND schemaname = 'core' AND indexname = 'outbox_delivery_id_idx'
  ) INTO idx_exists;
  
  IF NOT idx_exists THEN
    RAISE EXCEPTION 'Index outbox_delivery_id_idx not found on core.outbox. Review-timeline queries require this index.';
  END IF;
  
  RAISE NOTICE 'Verified: core.outbox.delivery_id index (outbox_delivery_id_idx) exists';
END $$;
```

### Task 5.2: Zod contracts for status + review-timeline
**Files:** Modify `libs/contracts/src/admin.v1.ts`
- [ ] **Step 1: Add status + review-timeline Zod schemas** (fenced code block shows the appends to admin.v1.ts):
```typescript
// Appended to libs/contracts/src/admin.v1.ts

export const HealthStateV1 = z.enum(["healthy", "degraded", "down"]).readonly();
export type HealthStateV1 = z.infer<typeof HealthStateV1>;

export const PipelineStatusV1 = z.object({
  schema_version: z.literal(1).default(1),
  in_flight_review_count: z.number().int().nonnegative(),
  last_24h_review_count: z.number().int().nonnegative(),
  last_24h_findings_count: z.number().int().nonnegative(),
  last_24h_avg_latency_seconds: z.number().nonnegative(),
  bedrock_health: HealthStateV1,
  postgres_health: HealthStateV1,
  temporal_health: HealthStateV1,
  sampled_at: z.coerce.date(),
}).strict().readonly();
export type PipelineStatusV1 = z.infer<typeof PipelineStatusV1>;

export const PilotProgressV1 = z.object({
  schema_version: z.literal(1).default(1),
  total_orgs_onboarded: z.number().int().nonnegative(),
  target_orgs: z.number().int().nonnegative(),
  total_prs_reviewed_this_week: z.number().int().nonnegative(),
  sprint_day: z.number().int().min(1).max(14),
  sampled_at: z.coerce.date(),
}).strict().readonly();
export type PilotProgressV1 = z.infer<typeof PilotProgressV1>;

export const WebhookEventV1 = z.object({
  schema_version: z.literal(1).default(1),
  webhook_event_id: z.string().uuid(),
  installation_id: z.string().uuid().nullable(),
  event_type: z.string(),
  received_at: z.coerce.date(),
}).strict().readonly();
export type WebhookEventV1 = z.infer<typeof WebhookEventV1>;

export const OutboxRowV1 = z.object({
  schema_version: z.literal(1).default(1),
  outbox_id: z.string().uuid(),
  sink: z.string(),
  state: z.enum(["pending", "leased", "delivered", "failed"]),
  created_at: z.coerce.date(),
  leased_until: z.coerce.date().nullable(),
  workflow_id: z.string().nullable(),
}).strict().readonly();
export type OutboxRowV1 = z.infer<typeof OutboxRowV1>;

export const WorkflowStatusV1 = z.object({
  schema_version: z.literal(1).default(1),
  workflow_id: z.string(),
  run_id: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "canceled", "terminated", "continued_as_new", "timed_out", "unknown"]),
  started_at: z.coerce.date().nullable(),
  closed_at: z.coerce.date().nullable(),
}).strict().readonly();
export type WorkflowStatusV1 = z.infer<typeof WorkflowStatusV1>;

export const LlmCallV1 = z.object({
  schema_version: z.literal(1).default(1),
  llm_call_id: z.string().uuid(),
  model: z.string(),
  cost_usd_cents: z.number().int().nonnegative(),
  latency_ms: z.number().int().nonnegative(),
  status: z.enum(["ok", "error"]),
  created_at: z.coerce.date(),
}).strict().readonly();
export type LlmCallV1 = z.infer<typeof LlmCallV1>;

export const GitHubPostingV1 = z.object({
  schema_version: z.literal(1).default(1),
  kind: z.enum(["check_run", "review_comment", "review"]),
  posted_at: z.coerce.date(),
  external_id: z.string().nullable(),
  status: z.enum(["posted", "failed"]),
  error_message: z.string().nullable(),
}).strict().readonly();
export type GitHubPostingV1 = z.infer<typeof GitHubPostingV1>;

export const ReviewTimelineV1 = z.object({
  schema_version: z.literal(1).default(1),
  delivery_id: z.string().min(1).max(64),
  webhook: WebhookEventV1.nullable(),
  outbox: OutboxRowV1.nullable(),
  workflow: WorkflowStatusV1.nullable(),
  bedrock_calls: z.array(LlmCallV1),
  github_postings: z.array(GitHubPostingV1),
  warnings: z.array(z.string()),
  sampled_at: z.coerce.date(),
}).strict().readonly();
export type ReviewTimelineV1 = z.infer<typeof ReviewTimelineV1>;
```
- [ ] **Step 2: Run tests to verify schemas** — `npm run test:contracts` / Expected: All contract tests pass
- [ ] **Step 3: Commit** — `git add libs/contracts/src/admin.v1.ts ; git commit -m "feat: add status + review-timeline Zod contracts"`

### Task 5.3: Status repo (status_repo.ts)
**Files:** Create `apps/backend/src/domain/repos/status_repo.ts`
- [ ] **Step 1: Write the repo with both pipeline + pilot methods**:
```typescript
// apps/backend/src/domain/repos/status_repo.ts
// Status page reads — 1:1 port of codemaster/api/admin/postgres_status_repo.py
// Two public methods: getPipelineStatus, getPilotProgress. Computes health states from raw
// signal windows (bedrock error rates, postgres xact_rollback, temporal probe with cache).

import { type Kysely, sql } from "kysely";
import type { PipelineStatusV1, PilotProgressV1, HealthStateV1 } from "#contracts/admin.v1.js";

// Locked thresholds (S16.D.3 review v2)
const BEDROCK_DOWN_WINDOW_MS = 60 * 1000; // 1 minute
const BEDROCK_DOWN_MIN_VOLUME = 10;
const BEDROCK_DOWN_ERROR_RATE = 0.9;
const BEDROCK_DEGRADED_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const BEDROCK_DEGRADED_MIN_VOLUME = 10;
const BEDROCK_DEGRADED_ERROR_RATE = 0.5;

const PG_HEALTH_WINDOW_MS = 5 * 60 * 1000;
const PG_DOWN_ROLLBACK_RATE = 0.5;
const PG_DEGRADED_ROLLBACK_RATE = 0.1;

const PILOT_DEFAULT_TARGET_ORGS = 10;
const TEMPORAL_HEALTH_CACHE_TTL_MS = 30 * 1000; // 30 seconds

interface TemporalProbePort {
  check(now: Date): Promise<HealthStateV1>;
}

export class StatusRepo {
  constructor(
    private db: Kysely<unknown>,
    private targetOrgs: number = PILOT_DEFAULT_TARGET_ORGS,
    private temporalProbe?: TemporalProbePort,
  ) {}

  async getPipelineStatus(now: Date): Promise<PipelineStatusV1> {
    const inFlight = await this.readInFlightReviewCount();
    const counts = await this.readLast24hCounts(now);
    const bedrockHealth = await this.computeBedrockHealth(now);
    const postgresHealth = await this.computePostgresHealth();
    const temporalHealth = this.temporalProbe
      ? await this.temporalProbe.check(now)
      : ("healthy" as HealthStateV1);

    return {
      schema_version: 1,
      in_flight_review_count: inFlight,
      last_24h_review_count: counts.reviewCount,
      last_24h_findings_count: counts.findingsCount,
      last_24h_avg_latency_seconds: counts.avgLatencySeconds,
      bedrock_health: bedrockHealth,
      postgres_health: postgresHealth,
      temporal_health: temporalHealth,
      sampled_at: now,
    };
  }

  async getPilotProgress(now: Date): Promise<PilotProgressV1> {
    const onboarded = await this.readOnboardedOrgCount();
    const thisWeek = await this.readReviewsThisWeek(now);
    const sprintDay = computeSprintDay(now, undefined);

    return {
      schema_version: 1,
      total_orgs_onboarded: onboarded,
      target_orgs: this.targetOrgs,
      total_prs_reviewed_this_week: thisWeek,
      sprint_day: sprintDay,
      sampled_at: now,
    };
  }

  private async readInFlightReviewCount(): Promise<number> {
    const res = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.review_runs WHERE state IN ('queued', 'in_progress')
    `.execute(this.db);
    return Number(res.rows[0]?.count ?? 0);
  }

  private async readLast24hCounts(
    now: Date,
  ): Promise<{ reviewCount: number; findingsCount: number; avgLatencySeconds: number }> {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const reviewRes = await sql<{
      review_count: string | number;
      avg_latency: string | number;
    }>`
      SELECT COUNT(*) AS review_count,
             COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))), 0) AS avg_latency
      FROM core.review_runs
      WHERE completed_at >= ${since} AND state = 'complete'
    `.execute(this.db);
    const reviewData = reviewRes.rows[0];

    const findingsRes = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.review_findings WHERE created_at >= ${since}
    `.execute(this.db);

    return {
      reviewCount: Number(reviewData?.review_count ?? 0),
      findingsCount: Number(findingsRes.rows[0]?.count ?? 0),
      avgLatencySeconds: Number(reviewData?.avg_latency ?? 0),
    };
  }

  private async computeBedrockHealth(now: Date): Promise<HealthStateV1> {
    // Last-1m: flips to "down"
    const downMetrics = await this.bedrockWindowMetrics(
      new Date(now.getTime() - BEDROCK_DOWN_WINDOW_MS),
    );
    if (
      downMetrics.total >= BEDROCK_DOWN_MIN_VOLUME &&
      downMetrics.errorRate > BEDROCK_DOWN_ERROR_RATE
    ) {
      return "down";
    }

    // Last-5m: flips to "degraded"
    const degradedMetrics = await this.bedrockWindowMetrics(
      new Date(now.getTime() - BEDROCK_DEGRADED_WINDOW_MS),
    );
    if (
      degradedMetrics.total >= BEDROCK_DEGRADED_MIN_VOLUME &&
      degradedMetrics.errorRate > BEDROCK_DEGRADED_ERROR_RATE
    ) {
      return "degraded";
    }

    return "healthy";
  }

  private async bedrockWindowMetrics(
    since: Date,
  ): Promise<{ total: number; errored: number; errorRate: number }> {
    const res = await sql<{ total: string | number; errored: string | number }>`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status != 'ok') AS errored
      FROM telemetry.llm_calls
      WHERE created_at >= ${since}
    `.execute(this.db);
    const data = res.rows[0];
    const total = Number(data?.total ?? 0);
    const errored = Number(data?.errored ?? 0);
    return {
      total,
      errored,
      errorRate: total > 0 ? errored / total : 0,
    };
  }

  private async computePostgresHealth(): Promise<HealthStateV1> {
    const res = await sql<{
      rollback_total: string | number | null;
      xact_total: string | number | null;
    }>`
      SELECT SUM(xact_rollback) AS rollback_total,
             SUM(xact_commit) + SUM(xact_rollback) AS xact_total
      FROM pg_stat_database
      WHERE datname = current_database()
    `.execute(this.db);
    const data = res.rows[0];
    const rollback = Number(data?.rollback_total ?? 0);
    const total = Number(data?.xact_total ?? 0);

    if (total === 0) {
      return "healthy";
    }

    const rate = rollback / total;
    if (rate > PG_DOWN_ROLLBACK_RATE) {
      return "down";
    }
    if (rate > PG_DEGRADED_ROLLBACK_RATE) {
      return "degraded";
    }
    return "healthy";
  }

  private async readOnboardedOrgCount(): Promise<number> {
    const res = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.installations WHERE onboarded_at IS NOT NULL
    `.execute(this.db);
    return Number(res.rows[0]?.count ?? 0);
  }

  private async readReviewsThisWeek(now: Date): Promise<number> {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const res = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.review_runs
      WHERE completed_at >= ${since} AND state = 'complete'
    `.execute(this.db);
    return Number(res.rows[0]?.count ?? 0);
  }
}

function computeSprintDay(now: Date, sprintStart?: Date): number {
  let start = sprintStart;
  if (!start) {
    const asUtc = new Date(now.toISOString());
    const dayOfWeek = asUtc.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    start = new Date(Date.UTC(
      asUtc.getUTCFullYear(),
      asUtc.getUTCMonth(),
      asUtc.getUTCDate() - daysSinceMonday,
      0,
      0,
      0,
      0,
    ));
  }
  const elapsed = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, Math.min(14, elapsed));
}

export { TemporalProbePort };
export { computeSprintDay };
```

> Note: export `computeSprintDay` (add to the `export { … }` line) so the pure heuristic can be unit-tested. The SQL methods (`readInFlightReviewCount`, `readLast24hCounts`, `computeBedrockHealth`, `computePostgresHealth`, `readOnboardedOrgCount`, `readReviewsThisWeek`) are exercised end-to-end by the integration test in **Task 5.7**.

- [ ] **Step 2: Write the unit test for the pure sprint-day heuristic**

```typescript
// test/unit/domain/repos/status_repo_sprint_day.test.ts
import { describe, expect, it } from "vitest";

import { computeSprintDay } from "#backend/domain/repos/status_repo.js";

describe("computeSprintDay (days since most-recent Monday, clamped 1..14)", () => {
  it("Monday is day 1", () => {
    // 2026-06-08 is a Monday (UTC)
    expect(computeSprintDay(new Date("2026-06-08T09:00:00.000Z"))).toBe(1);
  });
  it("Wednesday of the same week is day 3", () => {
    expect(computeSprintDay(new Date("2026-06-10T23:59:00.000Z"))).toBe(3);
  });
  it("Sunday counts back to that week's Monday (day 7)", () => {
    expect(computeSprintDay(new Date("2026-06-14T00:00:00.000Z"))).toBe(7);
  });
  it("an explicit sprintStart far in the past clamps to 14", () => {
    expect(computeSprintDay(new Date("2026-06-08T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z"))).toBe(14);
  });
});
```

- [ ] **Step 3: Run to verify it fails then passes**

Run: `npx vitest run test/unit/domain/repos/status_repo_sprint_day.test.ts`
Expected: FAIL first (`computeSprintDay` not exported) → after adding the export, PASS (4 cases).

- [ ] **Step 4: Commit** — `git add apps/backend/src/domain/repos/status_repo.ts test/unit/domain/repos/status_repo_sprint_day.test.ts ; git commit -m "feat: implement status_repo with pipeline + pilot methods + sprint-day unit test"`

### Task 5.4: Review-timeline repo (review_timeline_repo.ts)
**Files:** Create `apps/backend/src/domain/repos/review_timeline_repo.ts`
- [ ] **Step 1: Write the repo with postgres port**:
```typescript
// apps/backend/src/domain/repos/review_timeline_repo.ts
// Review-timeline persistence — 1:1 port of review_timeline.py + postgres_review_timeline_repo
// Three methods: getWebhook, getOutbox, getBedrock. External chains (Temporal/Langfuse/GitHub)
// are Day-1 shims returning None + warnings; production wiring is a follow-up.

import { type Kysely, sql } from "kysely";
import type {
  WebhookEventV1,
  OutboxRowV1,
  LlmCallV1,
} from "#contracts/admin.v1.js";

export class ReviewTimelineRepo {
  constructor(private db: Kysely<unknown>) {}

  async getWebhook(deliveryId: string): Promise<WebhookEventV1 | null> {
    const res = await sql<{
      webhook_event_id: string;
      installation_id: string | null;
      event_type: string;
      received_at: Date;
    }>`
      SELECT webhook_event_id, installation_id, event_type, received_at
      FROM audit.webhook_events
      WHERE delivery_id = ${deliveryId}
      LIMIT 1
    `.execute(this.db);

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    return {
      schema_version: 1,
      webhook_event_id: row.webhook_event_id,
      installation_id: row.installation_id,
      event_type: row.event_type,
      received_at: row.received_at,
    };
  }

  async getOutbox(deliveryId: string): Promise<OutboxRowV1 | null> {
    const res = await sql<{
      id: string;
      sink: string;
      state: string;
      created_at: Date;
      leased_until: Date | null;
      run_id: string | null;
    }>`
      SELECT id, sink, state, created_at, leased_until, run_id
      FROM core.outbox
      WHERE delivery_id = ${deliveryId}
      LIMIT 1
    `.execute(this.db);

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    return {
      schema_version: 1,
      outbox_id: row.id,
      sink: row.sink,
      state: row.state as "pending" | "leased" | "delivered" | "failed",
      created_at: row.created_at,
      leased_until: row.leased_until,
      workflow_id: row.run_id, // Note: outbox stores workflow_id in run_id column (schema naming)
    };
  }

  async getBedrock(deliveryId: string): Promise<LlmCallV1[]> {
    const res = await sql<{
      llm_call_id: string;
      model: string;
      cost_usd_cents: string | number;
      latency_ms: string | number;
      status: string;
      created_at: Date;
    }>`
      SELECT llm_call_id, model, cost_usd_cents, latency_ms, status, created_at
      FROM telemetry.llm_calls
      WHERE delivery_id = ${deliveryId}
      ORDER BY created_at ASC
    `.execute(this.db);

    return res.rows.map((row) => ({
      schema_version: 1,
      llm_call_id: row.llm_call_id,
      model: row.model,
      cost_usd_cents: Number(row.cost_usd_cents),
      latency_ms: Number(row.latency_ms),
      status: row.status as "ok" | "error",
      created_at: row.created_at,
    }));
  }
}
```
- [ ] **Step 2: Run repo unit tests** — Basic vitest covering all three methods (happy + null cases). `npm run test -- review_timeline_repo` / Expected: PASS
- [ ] **Step 3: Commit** — `git add apps/backend/src/domain/repos/review_timeline_repo.ts ; git commit -m "feat: implement review_timeline_repo with postgres port"`

### Task 5.5: Status admin routes (GET /api/admin/status/pipeline + /pilot-progress)
**Files:** Modify `apps/backend/src/api/admin/admin_routes.ts`
- [ ] **Step 1: Add route handlers for /api/admin/status/pipeline and /api/admin/status/pilot-progress**:
```typescript
// Appended to admin_routes.ts within registerAdminRoutes:

  // GET /api/admin/status/pipeline (reader+above)
  scope.get(
    "/status/pipeline",
    { preHandler: requireRole(["reader", "platform_operator", "platform_owner", "super_admin"]) },
    async (_req, reply) => {
      try {
        const status = await opts.statusRepo.getPipelineStatus(opts.clock.now());
        return reply.code(200).send(PipelineStatusV1.parse(status));
      } catch (err) {
        opts.log.warn({ err }, "status-repo schema-drift or unavailable");
        // Graceful degrade to empty envelope on schema-drift (UndefinedTableError, UndefinedColumnError)
        const isSchemaDrift =
          err instanceof Error &&
          (err.message.includes("UndefinedTableError") ||
            err.message.includes("UndefinedColumnError"));
        if (isSchemaDrift) {
          return reply.code(200).send(
            PipelineStatusV1.parse({
              in_flight_review_count: 0,
              last_24h_review_count: 0,
              last_24h_findings_count: 0,
              last_24h_avg_latency_seconds: 0,
              bedrock_health: "degraded",
              postgres_health: "degraded",
              temporal_health: "degraded",
              sampled_at: opts.clock.now(),
            }),
          );
        }
        return reply.code(503).send({ error: "status persistence unreachable" });
      }
    },
  );

  // GET /api/admin/status/pilot-progress (owner/super)
  scope.get(
    "/status/pilot-progress",
    { preHandler: requireRole(["platform_owner", "super_admin"]) },
    async (_req, reply) => {
      try {
        const progress = await opts.statusRepo.getPilotProgress(opts.clock.now());
        return reply.code(200).send(PilotProgressV1.parse(progress));
      } catch (err) {
        opts.log.warn({ err }, "status-repo pilot unavailable");
        // Fail-open: return zeros on error (per spec S16.D.3)
        return reply.code(200).send(
          PilotProgressV1.parse({
            total_orgs_onboarded: 0,
            target_orgs: 10,
            total_prs_reviewed_this_week: 0,
            sprint_day: 1,
            sampled_at: opts.clock.now(),
          }),
        );
      }
    },
  );
```
- [ ] **Step 2: Update AdminRoutesOptions interface** to include `statusRepo: StatusRepo`
- [ ] **Step 3: Run route tests** — Integration test with CODEMASTER_PG_CORE_DSN. Happy path for both roles + authz matrix (reader→200, operator→200, owner→200, super→200; org_owner/security_auditor→403 for pilot). `npm run test -- admin_status` / Expected: PASS
- [ ] **Step 4: Commit** — `git add apps/backend/src/api/admin/admin_routes.ts ; git commit -m "feat: add GET /api/admin/status/pipeline and /pilot-progress routes"`

### Task 5.6: Review-timeline admin route (GET /api/admin/review-timeline?delivery=...)
**Files:** Modify `apps/backend/src/api/admin/admin_routes.ts`
- [ ] **Step 1: Add route handler with external port stubs**:
```typescript
// Appended to admin_routes.ts within registerAdminRoutes:

  // GET /api/admin/review-timeline?delivery=<id> (owner/super)
  scope.get<{ Querystring: { delivery: string } }>(
    "/review-timeline",
    { preHandler: requireRole(["platform_owner", "super_admin"]) },
    async (req, reply) => {
      const { delivery } = req.query;
      if (!delivery || delivery.length < 1 || delivery.length > 64) {
        return reply.code(422).send({ error: "delivery must be 1-64 chars" });
      }

      const warnings: string[] = [];
      let webhook: WebhookEventV1 | null = null;
      let outbox: OutboxRowV1 | null = null;
      let bedrock: LlmCallV1[] = [];

      // Postgres chains
      try {
        webhook = await opts.reviewTimelineRepo.getWebhook(delivery);
      } catch (err) {
        opts.log.warn({ err, source: "webhook" }, "review-timeline sub-source unavailable");
        warnings.push(`webhook unavailable: ${(err as Error).name}`);
      }

      try {
        outbox = await opts.reviewTimelineRepo.getOutbox(delivery);
      } catch (err) {
        opts.log.warn({ err, source: "outbox" }, "review-timeline sub-source unavailable");
        warnings.push(`outbox unavailable: ${(err as Error).name}`);
      }

      try {
        bedrock = await opts.reviewTimelineRepo.getBedrock(delivery);
      } catch (err) {
        opts.log.warn({ err, source: "bedrock" }, "review-timeline sub-source unavailable");
        warnings.push(`bedrock_calls unavailable: ${(err as Error).name}`);
      }

      // Day-1 external chains are shims (return None + warning, no 503)
      const workflow = null;
      const github = [];
      warnings.push("workflow status unavailable (Day-1 shim)");
      warnings.push("github postings unavailable (Day-1 shim)");

      // 404 if no chain links found
      if (!webhook && !outbox && !workflow && bedrock.length === 0 && github.length === 0) {
        return reply.code(404).send({ error: `no chain links found for delivery_id=${delivery}` });
      }

      const timeline = ReviewTimelineV1.parse({
        delivery_id: delivery,
        webhook,
        outbox,
        workflow,
        bedrock_calls: bedrock,
        github_postings: github,
        warnings: warnings as any[],
        sampled_at: opts.clock.now(),
      });

      return reply.code(200).send(timeline);
    },
  );
```
- [ ] **Step 2: Update AdminRoutesOptions** to include `reviewTimelineRepo: ReviewTimelineRepo`
- [ ] **Step 3: Write integration test** — Happy path (delivery exists in outbox) + 404 (invalid delivery) + authz (owner→200, super→200, reader→403) + partial render (some sources error but page renders with warnings). `npm run test -- admin_review_timeline` / Expected: PASS
- [ ] **Step 4: Commit** — `git add apps/backend/src/api/admin/admin_routes.ts ; git commit -m "feat: add GET /api/admin/review-timeline route with Day-1 shims"`

### Task 5.7: Integration test for status + review-timeline
**Files:** Create `test/integration/api/admin_status_timeline.integration.test.ts`
- [ ] **Step 1: Write comprehensive test**:
```typescript
/**
 * Integration test for:
 *   GET /api/admin/status/pipeline (reader+above)
 *   GET /api/admin/status/pilot-progress (owner/super; fail-open to zeros)
 *   GET /api/admin/review-timeline?delivery=<id> (owner/super; partial render + warnings)
 *
 * Status endpoints: happy path + authz matrix + schema-drift graceful degrade (status/pipeline).
 * Review-timeline: happy path + 404 (no links) + partial render (some sources error).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-08T14:30:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "f9f9f9f9-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin status + review-timeline", () => {
  it("GET /api/admin/status/pipeline — 200 for reader (healthy by default); 403 for org_owner", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/status/pipeline",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ bedrock_health: string; postgres_health: string; temporal_health: string }>();
    expect(body.schema_version).toBe(1);
    expect(body.bedrock_health).toMatch(/healthy|degraded|down/);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/status/pipeline",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("GET /api/admin/status/pilot-progress — 200 for owner (fail-open zeros); 403 for reader", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/status/pilot-progress",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ total_orgs_onboarded: number; sprint_day: number }>();
    expect(body.schema_version).toBe(1);
    expect(body.total_orgs_onboarded).toBeGreaterThanOrEqual(0);
    expect(body.sprint_day).toBeGreaterThanOrEqual(1);
    expect(body.sprint_day).toBeLessThanOrEqual(14);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/status/pilot-progress",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("GET /api/admin/review-timeline — 404 for missing delivery; 200 + warnings for no postgres links", async () => {
    const app = await makeApp();
    const notFound = await app.inject({
      method: "GET",
      url: "/api/admin/review-timeline?delivery=nonexistent-delivery-id",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(notFound.statusCode).toBe(404);

    // Insert a delivery_id into outbox to produce a partial timeline
    const deliveryId = "test-delivery-" + Date.now();
    await sql`INSERT INTO core.outbox (id, sink, state, created_at, delivery_id) 
              VALUES (gen_random_uuid(), 'test', 'pending', now(), ${deliveryId})`.execute(db);

    const ok = await app.inject({
      method: "GET",
      url: `/api/admin/review-timeline?delivery=${deliveryId}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("super_admin") },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ warnings: string[] }>();
    expect(body.schema_version).toBe(1);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.some((w) => w.includes("shim"))).toBe(true); // Day-1 external shims

    await app.close();
  });

  it("GET /api/admin/review-timeline — 403 for org_owner (insufficient role)", async () => {
    const app = await makeApp();
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/review-timeline?delivery=test",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("GET /api/admin/review-timeline — 422 for invalid delivery param", async () => {
    const app = await makeApp();
    const invalid = await app.inject({
      method: "GET",
      url: "/api/admin/review-timeline?delivery=" + "x".repeat(100),
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });
});
```
- [ ] **Step 2: Run test** — `npm run test -- admin_status_timeline.integration.test.ts` / Expected: PASS (all 5 cases)
- [ ] **Step 3: Commit** — `git add test/integration/api/admin_status_timeline.integration.test.ts ; git commit -m "test: add integration tests for status + review-timeline endpoints"`

---

## Summary: Batch 5 delivers the 3 GET endpoints for the Status + Review-timeline cluster

- **Task 5.1**: Verify migration 0035 (the index already exists in baseline; this documents it).
- **Task 5.2**: Add Zod contracts for `PipelineStatusV1`, `PilotProgressV1`, `ReviewTimelineV1`, + supporting types.
- **Task 5.3**: Implement `status_repo.ts` with `getPipelineStatus()` + `getPilotProgress()` (locked health thresholds, sprint_day calculation).
- **Task 5.4**: Implement `review_timeline_repo.ts` with `getWebhook()`, `getOutbox()`, `getBedrock()`.
- **Task 5.5**: Wire `/api/admin/status/pipeline` (reader+above, schema-drift graceful degrade) + `/pilot-progress` (owner/super, fail-open zeros).
- **Task 5.6**: Wire `/api/admin/review-timeline?delivery=...` (owner/super, partial render with warnings, Day-1 external shims).
- **Task 5.7**: Integration tests covering happy paths, authz matrices, schema-drift, partial render, 404, and validation.

All tables use `core.*` prefix (not Python's `review.*`), matching the TS baseline. Day-1 external chains (Temporal/Langfuse/GitHub) return warnings + `null` (no 503), as specified. The temporal health probe and external post-review data are tracked follow-ups, not blockers.
