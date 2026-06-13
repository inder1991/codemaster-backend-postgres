// LlmInvocationLedger — NARROW LLM-invocation idempotency ledger (ADR-0068). Makes the paid provider
// call idempotent: a stable idempotency_key (derived from deterministic activity inputs) maps to the
// raw provider response, so a retry REPLAYS the stored response instead of re-invoking the provider.
//
// This is INTENTIONALLY the smallest LLM-invocation ledger that prevents duplicate paid calls, NOT a
// generic outbox (owner decision: "Do NOT build a broad generic outbox yet — build the smallest LLM
// invocation ledger that prevents duplicate paid calls").
//
// Persistence seam: ADR-0062 single-pool Kysely. The ledger takes an INJECTED `Kysely` (tests / the
// composition root hand it the shared `tenantKysely(dsn)` instance); {@link LlmInvocationLedger.fromDsn}
// is the default entry point that routes through the process-wide single pool.
//
// Tenancy: `core.llm_invocation_ledger` is registered in TENANT_SCOPED_TABLES and carries
// installation_id NOT NULL. Every statement filters on installation_id (the insert names it in the
// target column list; the lookup filters on it alongside the PK as defense-in-depth tenant isolation),
// so the raw-SQL tenancy gate's "installation_id token in the SQL" escape hatch is satisfied naturally.
//
// Clock/random discipline (clock_random gate): the key is a SHA-256 hash via `node:crypto`'s
// `createHash` — NOT a banned random function, so this is sanctioned outside the randomness seam (the
// gate bans `crypto.randomBytes/randomInt/...`, not `createHash`; the chunk-id deriver uses the same
// `createHash` idiom). No wall-clock read here: `created_at` defaults to the DB `now()`.

import { createHash } from "node:crypto";

import { type Kysely, sql } from "kysely";

import { type Counter, getMeter } from "#platform/observability/metrics.js";
import { tenantKysely } from "#platform/db/database.js";
import { uuid5 } from "#platform/randomness.js";

/** The deterministic activity inputs the idempotency key is derived from (owner decision verbatim). */
export type LlmInvocationKeyInputs = {
  /** Stable per-review identity (mapped from `ReviewContextV1.pr_id` at the call site). */
  reviewId: string;
  /** Stable per-chunk identity (mapped from `ReviewContextV1.chunk.chunk_id` at the call site). */
  chunkId: string;
  /** The LLM role ("primary" | "secondary"). */
  role: string;
  /** The resolved Bedrock model. */
  model: string;
  /** SHA-256 hex of the serialized request messages (the prompt hash). */
  promptSha256: string;
  /** The tool-schema version (content-addressable digest of REVIEW_TOOL_SCHEMA at the call site). */
  toolSchemaVersion: string;
};

/** What {@link LlmInvocationLedger.store} persists alongside the key. */
export type LlmInvocationLedgerEntry = {
  installationId: string;
  reviewId: string;
  chunkId: string;
  role: string;
  model: string;
  promptSha256: string;
  toolSchemaVersion: string;
  /** The raw provider response dict (replayed verbatim on a retry — the paid completion, stored once). */
  providerResponse: Record<string, unknown>;
};

/**
 * The injection seam the {@link LlmClient} depends on — the concrete {@link LlmInvocationLedger}
 * satisfies it structurally. Typing the client field to this PORT (not the concrete class) lets unit
 * tests inject an in-memory fake without a Postgres pool, exactly as every other client collaborator
 * (cost-cap, blob, telemetry, Langfuse) is a port. The Postgres-backed `LlmInvocationLedger` is the only
 * production implementation.
 */
export type LlmInvocationLedgerPort = {
  computeKey(inputs: LlmInvocationKeyInputs): string;
  lookup(args: { key: string; installationId: string }): Promise<Record<string, unknown> | null>;
  store(args: { key: string; entry: LlmInvocationLedgerEntry }): Promise<void>;
};

/** Field separator in the key pre-image — `\0` cannot appear in any of the (uuid / token) parts. */
const KEY_FIELD_SEP = "\0";

/** Read shape of the `provider_response::text` lookup row (the driver hands back a JSON string). */
type ProviderResponseReadRow = {
  provider_response: string;
};

/**
 * Durable record that makes the paid Bedrock call idempotent (ADR-0068). The repo owns NO pool — it is
 * handed a `Kysely` over the process-wide single pool (ADR-0062); the `TenancyPlugin` is already
 * installed by {@link tenantKysely}, so it is NOT re-installed here. The `Kysely` is typed `<unknown>`
 * (this repo uses only raw `sql` tagged templates — no query builder — so the typed schema buys nothing
 * and forcing the generic would block injecting a `Kysely<unknown>`; mirrors `PostgresLlmCallsTelemetryWriter`).
 */
export class LlmInvocationLedger {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<unknown>;

  /**
   * Construct from an injected `Kysely` — the tenant-scoped, shared-pool instance from
   * {@link tenantKysely}. Tests / composition roots that already hold a `Kysely` inject it here.
   */
  public constructor(args: { db: Kysely<unknown> }) {
    this.#db = args.db;
  }

  /**
   * Default entry point (ADR-0062): build a ledger over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool.
   */
  public static fromDsn(dsn: string): LlmInvocationLedger {
    return new LlmInvocationLedger({ db: tenantKysely<unknown>(dsn) });
  }

  /**
   * Compute the stable idempotency key (sha256 hex) from the deterministic activity inputs:
   * review_id + chunk_id + role + model + prompt hash + tool-schema version (owner decision verbatim).
   *
   * Pure + deterministic: the SAME inputs always produce the SAME key, across processes and retries —
   * the property that lets a retry find the prior record and replay it. `createHash` (NOT a random
   * function) is the sanctioned hashing primitive (clock_random gate).
   */
  public computeKey(inputs: LlmInvocationKeyInputs): string {
    const preimage = [
      inputs.reviewId,
      inputs.chunkId,
      inputs.role,
      inputs.model,
      inputs.promptSha256,
      inputs.toolSchemaVersion,
    ].join(KEY_FIELD_SEP);
    return createHash("sha256").update(Buffer.from(preimage, "utf-8")).digest("hex");
  }

  /**
   * Return the stored raw provider response for `key`, or `null` when no record exists (a MISS — the
   * caller must then invoke the SDK). The `provider_response::text` read-cast hands back a JSON STRING
   * we reparse, so the driver never pre-deserializes it into a shape that could drift.
   *
   * Tenancy: filtered on BOTH idempotency_key (the PK) AND installation_id (defense-in-depth — a key is
   * already per-tenant-deterministic, so a cross-tenant hit is astronomically impossible, but the filter
   * costs nothing and carries the installation_id token the raw-SQL gate requires).
   */
  public async lookup(args: {
    key: string;
    installationId: string;
  }): Promise<Record<string, unknown> | null> {
    const r = await sql<ProviderResponseReadRow>`
      SELECT provider_response::text AS provider_response
        FROM core.llm_invocation_ledger
       WHERE idempotency_key = ${args.key}
         AND installation_id = ${args.installationId}::uuid
    `.execute(this.#db);
    const row = r.rows[0];
    if (row === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(row.provider_response);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // A non-object provider_response is a corrupt row; treat as a MISS rather than replay junk.
      return null;
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * Persist the raw provider response under `key`, BEFORE the caller returns. `INSERT ... ON CONFLICT
   * DO NOTHING` so a racing retry that already stored the SAME key is a safe no-op (the key is
   * content-addressable, so the racing rows are byte-identical). The provider_response is bound as a
   * JSON string through `CAST(... AS jsonb)` (the codebase write idiom).
   *
   * Tenancy: installation_id is named in the INSERT target column list (the raw-SQL gate token).
   */
  public async store(args: { key: string; entry: LlmInvocationLedgerEntry }): Promise<void> {
    const { entry } = args;
    const providerResponseJson = JSON.stringify(entry.providerResponse);
    await sql`
      INSERT INTO core.llm_invocation_ledger
          (idempotency_key, installation_id, review_id, chunk_id, role, model,
           prompt_sha256, tool_schema_version, provider_response)
      VALUES
          (${args.key}, ${entry.installationId}::uuid, ${entry.reviewId}::uuid,
           ${entry.chunkId}::uuid, ${entry.role}, ${entry.model}, ${entry.promptSha256},
           ${entry.toolSchemaVersion}, CAST(${providerResponseJson} AS jsonb))
      ON CONFLICT (idempotency_key) DO NOTHING
    `.execute(this.#db);
  }

  /**
   * Retention sweep (D2): DELETE every ledger row whose `created_at` is older than `days` days, and
   * return how many rows were deleted. This is a CROSS-TENANT maintenance operation (the retention
   * policy is platform-wide, not per-installation) — so it deliberately does NOT filter on
   * installation_id, and the raw-SQL tenancy gate is satisfied by an explicit `tenant:exempt` marker
   * (the retention sweep is the gate's intended escape-hatch case, tracked under the GF-3 follow-up).
   *
   * The cutoff is computed server-side via `now() - make_interval(days => ${days})` so no wall-clock is
   * read in process (clock_random gate — the DB's `now()` is the time source, consistent with the
   * `created_at` default). The W6.4 schedule wires this against {@link DEFAULT_LEDGER_RETENTION_DAYS};
   * here it is the mechanism only.
   */
  public async pruneOlderThan(days: number): Promise<number> {
    // tenant:exempt reason=retention-sweep follow_up=PERMANENT-EXEMPTION-cross-tenant-retention-sweep
    const r = await sql`
      DELETE FROM core.llm_invocation_ledger
       WHERE created_at < now() - make_interval(days => ${days})
    `.execute(this.#db);
    return Number(r.numAffectedRows ?? 0n);
  }
}

/**
 * Default ledger retention window in days, read once from `CODEMASTER_LLM_LEDGER_RETENTION_DAYS`
 * (fallback 7). The W6.4 retention schedule passes this into {@link LlmInvocationLedger.pruneOlderThan};
 * a non-positive or non-numeric env value falls back to 7 so a misconfiguration can never widen the
 * sweep to delete fresh rows.
 */
export const DEFAULT_LEDGER_RETENTION_DAYS: number = (() => {
  const raw = process.env["CODEMASTER_LLM_LEDGER_RETENTION_DAYS"];
  if (raw === undefined) return 7;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
})();

/**
 * SHA-256 hex of the serialized request messages — the prompt hash component of the idempotency key.
 * Stable across retries because the messages are a deterministic transform of the activity input.
 * Exported so the client computes it once and the call site / tests can reproduce it. `createHash` is
 * the sanctioned hashing primitive (clock_random gate — NOT a banned random function).
 */
export function hashMessagesForLedger(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const canonical = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
  return createHash("sha256").update(Buffer.from(canonical, "utf-8")).digest("hex");
}

// ─── PR-level ledger purpose-key surrogate (E8 / D2) ──────────────────────────────────────────────
//
// The per-chunk paid call (bedrock_review_chunk) keys the ledger by the content-addressed chunk_id
// UUID. The four PR-LEVEL paid calls (walkthrough / Tier-1 curator / rerank / fix-prompt) have NO
// per-chunk UUID, so they need a STABLE, DETERMINISTIC chunkId surrogate to satisfy `computeKey` —
// otherwise two distinct PR-level purposes for the same review_id would collide (D2 verbatim: "key by
// purpose + stable input, not just review_id — otherwise walkthrough and fix_prompt could collide or
// replay the wrong LLM response"). The surrogate is `uuid5(LEDGER_PURPOSE_NS, purpose)`: deterministic
// (same purpose → same id across replays + across the TS/Python impls, no oracle leak — the LLM never
// sees the mint inputs) and distinct per purpose. Combined with promptSha256 + the per-site
// toolSchemaVersion, the full key stays unique across sites. `uuid5` is the sanctioned deterministic
// minter (#platform/randomness.js; clock_random gate — hashing only, no entropy).

/** The set of PR-level paid-call purposes the ledger surrogate keys. Bounds the metric `purpose` label. */
export type LedgerPurpose = "walkthrough" | "curator" | "rerank" | "fix_prompt";

/**
 * The frozen uuid5 namespace for PR-level ledger chunk-key surrogates (a uuid4 literal minted ONCE at
 * authoring time). MUST NOT change — it would re-key every PR-level ledger row and force a re-pay on the
 * next retry of every walkthrough / curator / rerank / fix-prompt call.
 */
export const LEDGER_PURPOSE_NS = "b7e3a1c4-2f6d-4a8b-9c0e-5d1f7a2b6c8e";

/**
 * The deterministic `chunkId` surrogate for a PR-level paid LLM call (E8). Same `purpose` always maps to
 * the same UUID; distinct purposes never collide. Used both as the ledger idempotency `chunkId` AND
 * (F9) tied to the SAME `purpose` token the metric label carries, so cost observability and replay
 * keying never diverge.
 */
export function purposeChunkId(purpose: LedgerPurpose): string {
  return uuid5(LEDGER_PURPOSE_NS, purpose);
}

// ─── ledger telemetry (D2) — four bounded-cardinality counters, label `purpose` only ──────────────
//
// `hit` vs `miss` is the replay-effectiveness signal; `paid_call` vs `miss` over time exposes duplicate
// spend (D2's upgrade trigger for the full in-flight reservation protocol); `store_failed` makes the
// silent-swallow of a ledger write failure (client.ts storeInvocation guard) VISIBLE. Mirrors the OTel
// idiom of runner_metrics.ts: a module-scoped meter + instruments cached once at import, every emit
// fail-safe so telemetry never perturbs the paid path. Cardinality discipline: the ONLY label is
// `purpose` (bounded to {bedrock_review_chunk} for the per-chunk call + {walkthrough|curator|rerank|
// fix_prompt} for the PR-level calls) — NEVER per-tenant / per-PR / per-review labels.

/** Grafana-query-stable counter names (renaming requires ADR). */
export const LEDGER_HIT_TOTAL_NAME = "codemaster_llm_ledger_hit_total";
export const LEDGER_MISS_TOTAL_NAME = "codemaster_llm_ledger_miss_total";
export const LEDGER_STORE_FAILED_TOTAL_NAME = "codemaster_llm_ledger_store_failed_total";
export const LEDGER_PAID_CALL_TOTAL_NAME = "codemaster_llm_ledger_paid_call_total";

const LEDGER_METER = getMeter("codemaster.integrations.llm.invocation_ledger");

const LEDGER_HIT_COUNTER: Counter = LEDGER_METER.createCounter(LEDGER_HIT_TOTAL_NAME, {
  description:
    "Count of ledger lookups that REPLAYED a stored provider response (a HIT — the paid SDK call was " +
    "skipped). Bounded label `purpose`. hit/miss is the replay-effectiveness signal.",
});
const LEDGER_MISS_COUNTER: Counter = LEDGER_METER.createCounter(LEDGER_MISS_TOTAL_NAME, {
  description:
    "Count of ledger lookups with no stored row (a MISS — the paid SDK call is about to run). Bounded " +
    "label `purpose`. paid_call/miss over time exposes duplicate spend (D2 upgrade trigger).",
});
const LEDGER_STORE_FAILED_COUNTER: Counter = LEDGER_METER.createCounter(LEDGER_STORE_FAILED_TOTAL_NAME, {
  description:
    "Count of ledger store() writes that FAILED after a paid SDK call (the write is guarded so it never " +
    "masks a successful invocation — but a subsequent retry would re-pay). Bounded label `purpose`.",
});
const LEDGER_PAID_CALL_COUNTER: Counter = LEDGER_METER.createCounter(LEDGER_PAID_CALL_TOTAL_NAME, {
  description:
    "Count of paid provider (SDK) calls made after a ledger MISS — the actual billed completions. " +
    "Bounded label `purpose`. Diverging from miss signals racing duplicate spend.",
});

/** Record one ledger HIT (a replay). `purpose` is the bounded label. Fail-safe. */
export function recordLedgerHit(purpose: string): void {
  try { LEDGER_HIT_COUNTER.add(1, { purpose }); } catch { /* telemetry never perturbs the paid path */ }
}

/** Record one ledger MISS (no stored row; the SDK is about to run). Fail-safe. */
export function recordLedgerMiss(purpose: string): void {
  try { LEDGER_MISS_COUNTER.add(1, { purpose }); } catch { /* telemetry never perturbs the paid path */ }
}

/** Record one ledger store() failure (a guarded write that did not persist). Fail-safe. */
export function recordLedgerStoreFailed(purpose: string): void {
  try { LEDGER_STORE_FAILED_COUNTER.add(1, { purpose }); } catch { /* telemetry never perturbs the paid path */ }
}

/** Record one paid provider (SDK) call made after a MISS. Fail-safe. */
export function recordLedgerPaidCall(purpose: string): void {
  try { LEDGER_PAID_CALL_COUNTER.add(1, { purpose }); } catch { /* telemetry never perturbs the paid path */ }
}
