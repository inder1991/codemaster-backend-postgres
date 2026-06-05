// LlmInvocationLedger — the NARROW LLM-invocation idempotency ledger (TS hardening divergence — ADR-0068).
//
// TS hardening divergence (ADR-0068) — the frozen Python has NO invocation ledger. In Python, a
// post-call persistence failure followed by a Temporal activity retry re-invokes Bedrock and buys a
// SECOND paid completion (the SDK call is the only non-repeatable, paid edge, and Python repeats it on
// every retry). This ledger makes the paid provider call idempotent: a stable idempotency_key (derived
// from the deterministic activity inputs) maps to the raw provider response, so a retry REPLAYS the
// stored response instead of re-invoking Bedrock.
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

import { tenantKysely } from "#platform/db/database.js";

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
}

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
