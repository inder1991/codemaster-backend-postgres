# Flexible Embedding Dimension (Greenfield) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedding dimension a **deploy-time configurable** value (default 1024) on a greenfield/empty corpus, so an operator can run any embedder model (≤2000-dim) instead of the hardcoded 1024 invariant — with **no re-embed and no blue/green** (there is no live corpus yet).

**Architecture:** One source of truth — `EMBEDDING_DIM`, computed from `CODEMASTER_EMBEDDING_DIMENSION` (default 1024) at module load. The **same env** sizes the empty pgvector columns via a new JS migration `0007`. The embedding *contract* drops its hardcoded `1024` bound; the dimension is enforced at the runtime write paths against `EMBEDDING_DIM`. Changing the dimension *after* ingesting is the deferred day-2 re-embed plan (see Appendix).

**Tech Stack:** TypeScript (Node ≥22, ESM), Kysely + `pg` (Postgres 16 + **pgvector**, HNSW indexes), Zod contracts, Vitest, `node-pg-migrate` (plain numbered migrations).

**Hard constraint baked in:** pgvector HNSW/ivfflat indexes on the `vector` type cap at **2000 dimensions**. So this plan supports `1..2000`. A native >2000 model (e.g. qwen3-embedding-8B @ 4096) must either Matryoshka-truncate its output to ≤2000 (most models support this via the API) or wait for the `halfvec` day-2 follow-up. This is validated loudly, not silently.

---

## Working agreements
- **TDD, red→green→commit.** One task ≈ one commit.
- **Gates before commit:** `npm run lint && npm run typecheck && npm test` (+ `npm run test:integration` for the migration task).
- **Migrations up-only;** never edit `0001_baseline.sql`; the new `0007` is additive and resizes EMPTY columns (instant).
- **Greenfield assumption is load-bearing:** the resize is only safe on empty tables. The migration asserts emptiness and fails loud otherwise (so it can never run against a populated corpus).

## File structure (touch-points, all verified)
- `apps/backend/src/adapters/embeddings_port.ts:148` — `EMBEDDING_DIM` becomes env-derived (the single source) + new exported pure `resolveEmbeddingDim(env)`.
- `apps/backend/src/adapters/embedder_cache.ts:49` — `PLATFORM_EMBEDDING_DIMENSION` derives from `EMBEDDING_DIM`.
- `apps/backend/src/api/admin/platform_credentials_write.ts:39` — `CORPUS_DIMENSION` derives from `EMBEDDING_DIM`.
- `libs/contracts/src/confluence_sync.v1.ts:179` — `embedding: z.array(z.number()).min(1024).max(1024)` → `.min(1)` (dimension-agnostic; runtime enforces the real width).
- `migrations/0007_configurable_embedding_dimension.cjs` — **new** JS migration: resize the 4 empty vector columns + recreate the 3 HNSW indexes to `CODEMASTER_EMBEDDING_DIMENSION`; add `active_embedding_dimension` to `core.embedder_runtime_state`; update the seed generation's `embedding_dimension`.
- `apps/backend/src/schema_preflight.ts:19` — append `"0007_configurable_embedding_dimension"` to `EXPECTED_MIGRATIONS`.
- `apps/backend/src/adapters/embeddings_port.ts` (`RecordingEmbeddingsClient`) — dev/test stub emits `EMBEDDING_DIM`-length vectors.
- `docs/RUN-LOCAL.md` (or the deploy runbook) — document the env + the "pick before ingest" rule + the day-2 pointer.

---

## Task 1: `EMBEDDING_DIM` becomes deploy-configurable (single source of truth)

**Files:**
- Modify: `apps/backend/src/adapters/embeddings_port.ts:148`
- Test: `test/unit/embeddings/embedding_dim.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { resolveEmbeddingDim } from "#backend/adapters/embeddings_port.js";

describe("resolveEmbeddingDim", () => {
  it("defaults to 1024 when unset or empty", () => {
    expect(resolveEmbeddingDim({})).toBe(1024);
    expect(resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "" })).toBe(1024);
  });
  it("reads a valid configured dimension", () => {
    expect(resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "768" })).toBe(768);
    expect(resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "2000" })).toBe(2000);
  });
  it("rejects non-integers, <1, and >2000 (the pgvector HNSW cap) loudly", () => {
    expect(() => resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "1024.5" })).toThrow(/integer/);
    expect(() => resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "0" })).toThrow(/1\.\.2000/);
    expect(() => resolveEmbeddingDim({ CODEMASTER_EMBEDDING_DIMENSION: "4096" })).toThrow(/2000/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- embedding_dim`
Expected: FAIL — `resolveEmbeddingDim` is not exported.

- [ ] **Step 3: Implement**

In `apps/backend/src/adapters/embeddings_port.ts`, replace `export const EMBEDDING_DIM = 1024;` (line ~148) with:

```typescript
/** pgvector HNSW/ivfflat indexes on the `vector` type cap at 2000 dims. */
export const MAX_HNSW_VECTOR_DIM = 2000;

/** Pure: resolve the deploy-time embedding dimension from env (default 1024). */
export function resolveEmbeddingDim(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEMASTER_EMBEDDING_DIMENSION;
  if (raw === undefined || raw.trim() === "") return 1024;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HNSW_VECTOR_DIM) {
    throw new Error(
      `CODEMASTER_EMBEDDING_DIMENSION must be an integer in 1..${MAX_HNSW_VECTOR_DIM} ` +
        `(pgvector caps HNSW vector indexes at ${MAX_HNSW_VECTOR_DIM}; for a larger native dim, ` +
        `Matryoshka-truncate the model output or use the halfvec day-2 path). Got: ${raw}`,
    );
  }
  return n;
}

/** Embedding dimensionality of the configured platform model (default 1024). The pgvector column
 *  width (migration 0007) and CODEMASTER_EMBEDDING_DIMENSION MUST agree — both read the same env. */
export const EMBEDDING_DIM = resolveEmbeddingDim();
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- embedding_dim && npm run typecheck`
Expected: PASS (consumers of `EMBEDDING_DIM` still compile — it is still a `number`).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/adapters/embeddings_port.ts test/unit/embeddings/embedding_dim.test.ts
git commit -m "feat(embeddings): make EMBEDDING_DIM deploy-configurable via CODEMASTER_EMBEDDING_DIMENSION (<=2000)"
```

---

## Task 2: collapse the duplicate 1024 constants onto `EMBEDDING_DIM`

**Files:**
- Modify: `apps/backend/src/adapters/embedder_cache.ts:49`
- Modify: `apps/backend/src/api/admin/platform_credentials_write.ts:39`
- Test: `test/unit/adapters/embedder_cache_dim.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { PLATFORM_EMBEDDING_DIMENSION } from "#backend/adapters/embedder_cache.js";
import { EMBEDDING_DIM } from "#backend/adapters/embeddings_port.js";

describe("dimension constants are a single source of truth", () => {
  it("PLATFORM_EMBEDDING_DIMENSION equals EMBEDDING_DIM", () => {
    expect(PLATFORM_EMBEDDING_DIMENSION).toBe(EMBEDDING_DIM);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (still hardcoded 1024 — fails only if env≠1024 in CI; assert identity regardless)

Run: `npm test -- embedder_cache_dim`
Expected: FAIL — `PLATFORM_EMBEDDING_DIMENSION` is a literal `1024`, not the imported constant (the test pins the *identity*, which the literal breaks the moment env≠1024; it also documents intent).

- [ ] **Step 3: Implement**

In `apps/backend/src/adapters/embedder_cache.ts`, replace `export const PLATFORM_EMBEDDING_DIMENSION = 1024;` (line ~49) with:

```typescript
import { EMBEDDING_DIM } from "#backend/adapters/embeddings_port.js";
/** The active generation's embedding_dimension MUST equal this (= the configured EMBEDDING_DIM). */
export const PLATFORM_EMBEDDING_DIMENSION = EMBEDDING_DIM;
```

In `apps/backend/src/api/admin/platform_credentials_write.ts`, replace `const CORPUS_DIMENSION = 1024; // v4 §4.4 Qwen invariant` (line ~39) with:

```typescript
import { EMBEDDING_DIM } from "#backend/adapters/embeddings_port.js";
const CORPUS_DIMENSION = EMBEDDING_DIM; // configured platform dimension (was hardcoded 1024)
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- embedder_cache_dim && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/adapters/embedder_cache.ts apps/backend/src/api/admin/platform_credentials_write.ts test/unit/adapters/embedder_cache_dim.test.ts
git commit -m "refactor(embeddings): PLATFORM_EMBEDDING_DIMENSION + CORPUS_DIMENSION derive from EMBEDDING_DIM"
```

---

## Task 3: relax the embedding contract to be dimension-agnostic

**Files:**
- Modify: `libs/contracts/src/confluence_sync.v1.ts:179`
- Test: `test/unit/contracts/embedded_chunk_dim.test.ts`

- [ ] **Step 1: Write the failing test** (an N-dim embedding must parse; runtime — not the contract — enforces the exact width)

```typescript
import { describe, it, expect } from "vitest";
import { EmbeddedChunkV1 } from "#contracts/confluence_sync.v1.js";

describe("EmbeddedChunkV1.embedding is dimension-agnostic", () => {
  const base = { chunk_id: "c1", page_id: "p1", space_key: "S", content_sha256: "x".repeat(64), seq: 0 };
  it("accepts a 768-dim vector", () => {
    expect(EmbeddedChunkV1.safeParse({ ...base, embedding: Array(768).fill(0.1) }).success).toBe(true);
  });
  it("accepts a 2000-dim vector", () => {
    expect(EmbeddedChunkV1.safeParse({ ...base, embedding: Array(2000).fill(0.1) }).success).toBe(true);
  });
  it("still rejects an empty vector", () => {
    expect(EmbeddedChunkV1.safeParse({ ...base, embedding: [] }).success).toBe(false);
  });
});
```

> NOTE Step 0: open `libs/contracts/src/confluence_sync.v1.ts` and confirm the exact field names on `EmbeddedChunkV1` around line 179; adjust `base` above to the real required fields (the embedding-array change is the only behavioural edit).

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- embedded_chunk_dim`
Expected: FAIL — `768`/`2000` rejected by `.min(1024).max(1024)`.

- [ ] **Step 3: Implement**

In `libs/contracts/src/confluence_sync.v1.ts` (line ~179), change:

```typescript
embedding: z.array(z.number()).min(1024).max(1024),
```
to:

```typescript
// Dimension-agnostic at the contract boundary; the configured width (EMBEDDING_DIM) is enforced at
// the pgvector WRITE path (embed_doc_chunks / confluence_sync activities), not here.
embedding: z.array(z.number()).min(1),
```

- [ ] **Step 4: Run, expect PASS + regen contracts**

Run: `npm test -- embedded_chunk_dim`
Then regenerate the OpenAPI/codegen if the repo has that step: `grep -n "openapi" package.json` — if a `gen:*` script exists for contracts, run it; otherwise none is needed.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/contracts/src/confluence_sync.v1.ts test/unit/contracts/embedded_chunk_dim.test.ts
git commit -m "feat(contracts): EmbeddedChunkV1.embedding is dimension-agnostic (runtime enforces width)"
```

---

## Task 4: migration `0007` — size the empty vector columns to the configured dimension

**Files:**
- Create: `migrations/0007_configurable_embedding_dimension.cjs`
- Modify: `apps/backend/src/schema_preflight.ts:19` (append the migration name)
- Test: `test/integration/migrations/embedding_dimension.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { INTEGRATION_DSN } from "../_db.js";

describe("migration 0007 sizes vector columns to CODEMASTER_EMBEDDING_DIMENSION", () => {
  it("default deploy keeps 1024 and adds active_embedding_dimension", async () => {
    if (!INTEGRATION_DSN) return;
    const pool = new Pool({ connectionString: INTEGRATION_DSN, max: 2 });
    // atttypmod for vector(N) is N+4; -1 means unconstrained.
    const dim = async (t: string, c: string) =>
      (await pool.query(
        `SELECT atttypmod-4 AS d FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2`, [t, c])).rows[0]?.d;
    expect(await dim("core.chunk_embeddings", "embedding")).toBe(1024);
    expect(await dim("core.knowledge_chunks", "vector")).toBe(1024);
    expect(await dim("core.confluence_chunks", "embedding")).toBe(1024);
    expect(await dim("cache.cache_embeddings", "embedding")).toBe(1024);
    const ard = await pool.query(`SELECT active_embedding_dimension FROM core.embedder_runtime_state WHERE singleton=true`);
    expect(ard.rows[0].active_embedding_dimension).toBe(1024);
    await pool.end();
  });
});
```

> This test runs against the disposable PG already migrated by the suite's setup. (A non-1024 run is verified manually in Step 4b on a throwaway DB.)

- [ ] **Step 2: Run, expect FAIL**

Run: `npm run test:integration -- embedding_dimension`
Expected: FAIL — `active_embedding_dimension` column does not exist yet.

- [ ] **Step 3: Write the migration**

Create `migrations/0007_configurable_embedding_dimension.cjs`:

```javascript
/* Greenfield: size the EMPTY pgvector columns to CODEMASTER_EMBEDDING_DIMENSION (default 1024) and
 * record it on the runtime-state singleton + the seed generation. Safe ONLY on empty tables (asserts).
 * pgvector HNSW caps vector indexes at 2000 dims — enforced here too. */
exports.shorthands = undefined;

const TABLES = [
  { table: "core.chunk_embeddings", col: "embedding", index: "chunk_embeddings_hnsw_idx", where: "" },
  { table: "core.knowledge_chunks", col: "vector", index: "idx_knowledge_chunks_vector_hnsw", where: "" },
  { table: "core.confluence_chunks", col: "embedding", index: "confluence_chunks_embedding_hnsw_live",
    where: "WHERE superseded_at IS NULL AND deleted_at IS NULL AND quarantined = false" },
  { table: "cache.cache_embeddings", col: "embedding", index: null, where: "" }, // no HNSW index
];

exports.up = (pgm) => {
  const raw = process.env.CODEMASTER_EMBEDDING_DIMENSION;
  const dim = raw === undefined || raw.trim() === "" ? 1024 : Number(raw);
  if (!Number.isInteger(dim) || dim < 1 || dim > 2000) {
    throw new Error(`CODEMASTER_EMBEDDING_DIMENSION must be an integer in 1..2000 (got ${raw})`);
  }

  // Always: record the active dimension on the runtime-state singleton.
  pgm.sql(`ALTER TABLE core.embedder_runtime_state
             ADD COLUMN active_embedding_dimension integer NOT NULL DEFAULT ${dim};`);

  if (dim !== 1024) {
    for (const t of TABLES) {
      // Guard: resize is only safe on an EMPTY table (greenfield). Fail loud otherwise.
      pgm.sql(`DO $$ BEGIN
        IF (SELECT count(*) FROM ${t.table}) > 0 THEN
          RAISE EXCEPTION '0007 refuses to resize non-empty %', '${t.table}';
        END IF; END $$;`);
      if (t.index) pgm.sql(`DROP INDEX IF EXISTS ${t.table.split(".")[0]}.${t.index};`);
      pgm.sql(`ALTER TABLE ${t.table} ALTER COLUMN ${t.col} TYPE public.vector(${dim});`);
      if (t.index) {
        pgm.sql(`CREATE INDEX ${t.index} ON ${t.table} USING hnsw (${t.col} public.vector_cosine_ops)
                   WITH (m='16', ef_construction='64') ${t.where};`);
      }
    }
    pgm.sql(`UPDATE core.embedding_generations SET embedding_dimension = ${dim} WHERE generation_id = 1;`);
    pgm.sql(`UPDATE core.embedder_runtime_state SET active_embedding_dimension = ${dim} WHERE singleton = true;`);
  }
};

exports.down = false; // up-only, per the repo's migration policy
```

> Step 3b: confirm `node-pg-migrate` here picks up `.cjs` (all current migrations are `.sql`). Run `npx node-pg-migrate --help` to confirm JS migrations are enabled (they are by default); if the loader is restricted to `.sql` in config, write the default-1024 path as `0007_configurable_embedding_dimension.sql` (just the `ALTER TABLE … ADD COLUMN active_embedding_dimension integer NOT NULL DEFAULT 1024;`) and move the env-driven resize into a separate `scripts/set-embedding-dimension.ts` one-shot the operator runs pre-ingest. Decide based on the loader.

- [ ] **Step 4: Append to EXPECTED_MIGRATIONS + run**

In `apps/backend/src/schema_preflight.ts`, add after `"0006_outbox_pending_created_at_index",`:

```typescript
  // Greenfield: size pgvector columns to CODEMASTER_EMBEDDING_DIMENSION + record active_embedding_dimension.
  "0007_configurable_embedding_dimension",
```

Run: `npm run test:integration -- embedding_dimension`
Expected: PASS (default 1024 path).

- [ ] **Step 4b: Manually verify the non-1024 path on a throwaway DB**

```bash
createdb cmtest_dim 2>/dev/null || true
CODEMASTER_EMBEDDING_DIMENSION=768 CODEMASTER_PG_CORE_DSN="postgresql://postgres@localhost:5434/cmtest_dim" npm run migrate:up
psql "postgresql://postgres@localhost:5434/cmtest_dim" -c \
  "SELECT atttypmod-4 FROM pg_attribute WHERE attrelid='core.chunk_embeddings'::regclass AND attname='embedding';"
# Expected: 768
```

- [ ] **Step 5: Commit**

```bash
git add migrations/0007_configurable_embedding_dimension.cjs apps/backend/src/schema_preflight.ts test/integration/migrations/embedding_dimension.integration.test.ts
git commit -m "feat(migrations): 0007 sizes empty pgvector columns to CODEMASTER_EMBEDDING_DIMENSION"
```

---

## Task 5: dev/test stub emits `EMBEDDING_DIM`-length vectors

**Files:**
- Modify: `apps/backend/src/adapters/embeddings_port.ts` (`RecordingEmbeddingsClient`)
- Test: `test/unit/embeddings/recording_client_dim.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { RecordingEmbeddingsClient, EMBEDDING_DIM } from "#backend/adapters/embeddings_port.js";

describe("RecordingEmbeddingsClient honors EMBEDDING_DIM", () => {
  it("emits EMBEDDING_DIM-length vectors", async () => {
    const c = new RecordingEmbeddingsClient();
    const out = await c.embed({ texts: ["hello"], model_name: "stub" });
    expect(out.vectors[0].length).toBe(EMBEDDING_DIM);
  });
});
```

> Step 0: open `RecordingEmbeddingsClient` in `embeddings_port.ts` and confirm the constructor + `embed` shapes; adjust the call above to the real signature. The behavioural change is: any place the stub builds a `1024`-length array must use `EMBEDDING_DIM`.

- [ ] **Step 2: Run, expect FAIL** (only if the stub hardcodes 1024 and the env differs; the test still pins intent).

Run: `npm test -- recording_client_dim`

- [ ] **Step 3: Implement** — replace any literal `1024` length in `RecordingEmbeddingsClient` with `EMBEDDING_DIM`.

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- recording_client_dim && npm test -- embeddings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/adapters/embeddings_port.ts test/unit/embeddings/recording_client_dim.test.ts
git commit -m "test(embeddings): RecordingEmbeddingsClient emits EMBEDDING_DIM-length vectors"
```

---

## Task 6: document the deploy knob + the day-2 boundary

**Files:**
- Modify: `docs/RUN-LOCAL.md` (or `docs/runbooks/first-deploy.md` if that's the canonical deploy doc)

- [ ] **Step 1: Add a section**

```markdown
## Embedding dimension (set ONCE, before ingesting)

The corpus vector columns are sized at deploy time by `CODEMASTER_EMBEDDING_DIMENSION` (default 1024).
Set it to match your embedder model's output dimension BEFORE ingesting any content:
- `mxbai-embed-large`, `bge-large` → 1024 (the default — nothing to set)
- `nomic-embed-text` → 768
- A model whose native dim is >2000 (e.g. qwen3-embedding-8B @ 4096): pgvector's HNSW index caps at
  2000, so either configure the model to output ≤2000 (Matryoshka), or wait for the `halfvec` follow-up.

Changing the dimension AFTER content is ingested is NOT supported by this path (it would orphan every
stored vector) — that is the day-2 blue/green re-embed project (see the plan appendix).
```

- [ ] **Step 2: Commit**

```bash
git add docs/RUN-LOCAL.md
git commit -m "docs: document CODEMASTER_EMBEDDING_DIMENSION (set once, pre-ingest)"
```

---

## Self-review
- **Coverage:** the 4 constants (`EMBEDDING_DIM`, `PLATFORM_EMBEDDING_DIMENSION`, `CORPUS_DIMENSION`, the contract bound) → Tasks 1–3; the physical column width → Task 4; the dev stub → Task 5; docs → Task 6. The seed generation + runtime-state row → Task 4.
- **No placeholders:** every code step shows the code; the two "confirm exact field names" notes are Step-0 verifications, not deferred work.
- **YAGNI:** no sidecar columns, no re-embed runner, no blue/green — those are the day-2 plan.

## Appendix — day-2 (deferred): changing dimension on a LIVE corpus
When there IS a live corpus you can't drop, the column-per-dimension + generation blue/green design applies
(add `embedding_<dim>` sidecar columns, re-embed under a pending generation, `activate()` flip, GC old).
That design was mapped against the existing `embedding_generations` lifecycle and is out of scope here.
