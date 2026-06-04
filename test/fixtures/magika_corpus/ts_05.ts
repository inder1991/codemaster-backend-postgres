/**
 * ReviewFindingsRepo — 1:1 TypeScript/Kysely port of the frozen Python spine repo
 * `vendor/codemaster-py/codemaster/domain/repos/review_findings_repo.py`
 * (Sprint 20 / S20.DM.7 step B + Phase D / Task D.7 + ADR-0056 PR-1 lifecycle setters).
 *
 * Async repo over `core.review_findings`. Methods (1:1 with the Python class):
 *
 *   - persistAggregated          — multi-row INSERT of one row per ReviewFindingV1 in the
 *                                  AggregatedFindingsV1 envelope. Idempotent via the uuid5-derived
 *                                  `review_finding_id` (ON CONFLICT (review_finding_id) DO NOTHING).
 *                                  Returns the ordered tuple of finding IDs.
 *   - insertTier1Finding         — Phase D: one Tier-1 static-analyzer row carrying arbitration
 *                                  suppression metadata. ON CONFLICT DO NOTHING (replay-idempotent).
 *   - updateTier2Arbitration     — Phase D: UPDATE a previously-persisted Tier-2 LLM row with the
 *                                  arbitration decision metadata. WHERE filters installation_id.
 *   - recordDeliveryFinalized    — ADR-0056: bulk flip to inline_delivered via UPDATE ... FROM
 *                                  unnest(rfids, comment_ids). Length-parity guarded.
 *   - recordDeliverySkipped      — ADR-0056: bulk flip to not_applicable / skipped via UPDATE ...
 *                                  FROM unnest(rfids, reasons). Eligibility-reason allowlist guarded.
 *   - recordDeliveryDegraded     — ADR-0056: bulk flip to a degraded outcome (body_only_fallback |
 *                                  failed). Outcome allowlist guarded BEFORE the writes_enabled
 *                                  short-circuit.
 *   - fetchSkippedForWalkthrough — read query for the walkthrough renderer's DB-mode (F-8).
 *
 * Tenancy (CLAUDE.md invariant #10 / "default deny everywhere"): the repo's Kysely instance installs
 * `TenancyPlugin` (`#platform/db/tenancy_plugin.js`). The query-builder read path
 * (`fetchSkippedForWalkthrough`) therefore has its `installation_id = :iid` equality predicate
 * verified by the plugin's AST walk at build time. The raw-`sql`-template write paths bypass the AST
 * walk by design (same as the frozen Python `text()` SQL bypassing the SQLAlchemy ORM hook); every
 * one of them carries `installation_id` explicitly in the literal SQL (in the INSERT VALUES, or in
 * the UPDATE WHERE clause) — exactly as the Python source does, so cross-tenant mutation is
 * structurally impossible.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): the `pg.Pool` and the `Kysely` instance are MEMOIZED
 * per DSN by {@link tenantKyselyForDsn} — NEVER created per call. The repo accepts a `Kysely` (and a
 * `Clock` seam) by injection so callers share one engine across all repos.
 *
 * DEFERRED cross-subsystem wiring (documented, signatures kept 1:1 so it is purely additive later):
 *   - The Python `persistAggregated` + the three lifecycle setters wire the AD-4 stale-write guard
 *     (`codemaster.domain.stale_write_guard.assert_current_run`) inside the mutation transaction, and
 *     `persistAggregated` additionally emits the `FINDINGS_PERSISTED` milestone into
 *     `audit.workflow_events`. Both depend on TS ports that DO NOT YET EXIST in this repo
 *     (`stale_write_guard` + `emit_workflow_event` — workflow-orchestration concerns, not the
 *     `core.review_findings` data layer). They are NOT ported here; the `run_id` / `review_id`
 *     parameters are preserved on every signature so the guard threads through unchanged once those
 *     modules land. The Python observability emits (OTel lifecycle counters + structlog) are likewise
 *     best-effort side-effects outside the data layer and are not part of this port.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { createHash } from "node:crypto";
import { Pool } from "pg";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";

import type { Clock } from "#platform/clock.js";

import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { DEGRADED_OUTCOMES } from "#contracts/finding_lifecycle_inputs.v1.js";

// ─── uuid5 (deterministic; NOT randomness — outside the clock/random gate's scope) ──────────────
//
// 1:1 with the Python `uuid.uuid5(_REVIEW_FINDING_UUID5_NAMESPACE, name)`. Re-authored from
// node:crypto SHA-1 (no `uuid` npm dep), mirroring libs/contracts/src/retrieved_evidence.v1.ts.

/** uuid5 namespace — stable across replays so the same per-finding tuple maps to the same id. */
const REVIEW_FINDING_UUID5_NAMESPACE = "8a8c9d11-0a3e-5e0f-9b7e-fc2c3a8d9701";

/** RFC4122 v5 UUID (SHA-1 of namespace bytes ++ name bytes), canonical lowercase hyphenated form. */
function uuid5(namespaceHex: string, name: string): string {
  const nsBytes = Buffer.from(namespaceHex.replace(/-/g, ""), "hex"); // 16 bytes
  const digest = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf-8")).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8); // RFC4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Stable per-finding UUID5. Workflow replays produce the same id so the
 * `ON CONFLICT (review_finding_id) DO NOTHING` clause makes {@link PostgresReviewFindingsRepo.persistAggregated}
 * idempotent. 1:1 with the Python `derive_review_finding_id` name composition:
 * `f"{pr_id}|{file}|{start_line}|{end_line}|{severity}|{title}"`.
 */
export function deriveReviewFindingId(args: {
  prId: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: string;
  title: string;
}): string {
  const name = `${args.prId}|${args.file}|${args.startLine}|${args.endLine}|${args.severity}|${args.title}`;
  return uuid5(REVIEW_FINDING_UUID5_NAMESPACE, name);
}

// ─── Eligibility-reason allowlist (1:1 with codemaster/domain/review_findings/eligibility_reasons.py
//     EligibilityReason StrEnum / migration 0091 core.finding_eligibility_reason enum). ───────────

/**
 * `record_delivery_skipped` rejects a stale/typo'd reason BEFORE the SQL UPDATE — Postgres would
 * otherwise abort the entire batch on cast-to-enum failure, rolling back every otherwise-valid row.
 */
export const VALID_ELIGIBILITY_REASONS: ReadonlySet<string> = new Set([
  "file_not_in_diff",
  "line_after_last_hunk",
  "line_before_first_hunk",
  "line_spans_hunks",
  "line_in_unchanged_gap",
]);

// ─── Read-model row shape (1:1 with the Python frozen dataclass SkippedFindingRow). ─────────────

/**
 * Read-model row shape for the walkthrough renderer's DB-mode (F-8 follow-up). Returned by
 * {@link PostgresReviewFindingsRepo.fetchSkippedForWalkthrough} in severity-rank → `file_path` →
 * `start_line` order. NOTE: no `rule_id` field — that column doesn't exist on `core.review_findings`;
 * Tier-1 findings encode the rule_id in `title`.
 */
export type SkippedFindingRow = {
  readonly reviewFindingId: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly severity: string;
  readonly category: string;
  readonly title: string;
  readonly eligibilityReason: string;
};

// ─── Minimal Kysely DB schema (only what the read path's query-builder needs to be typed). ──────
//
// The write paths use raw `sql` templates, so they do not need a column-level Kysely schema. The
// read path needs the columns it SELECTs / filters / orders on, typed so the TenancyPlugin's AST
// (which fires on builder queries) carries a real `installation_id = :x` equality predicate.

type ReviewFindingsTable = {
  review_finding_id: string;
  installation_id: string;
  pr_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  severity: string;
  category: string;
  title: string;
  delivery_eligibility: string | null;
  suppression_state: string;
  eligibility_reason: string | null;
};

type ReviewFindingsDb = {
  "core.review_findings": ReviewFindingsTable;
};

// ─── Memoized engine (ADR-0062) ─────────────────────────────────────────────────────────────────

type Engine = { pool: Pool; db: Kysely<ReviewFindingsDb> };

/** DSN -> memoized { pool, db } so we NEVER build a pool/engine per call (ADR-0062). */
const ENGINES = new Map<string, Engine>();

/**
 * Return a process-memoized tenant-scoped Kysely (TenancyPlugin installed) + its backing `pg.Pool`,
 * keyed by DSN. Subsequent calls with the same DSN return the SAME instances — the ADR-0062
 * "no engine memoization → ~28 pools/worker → TooManyConnectionsError" defect is closed by
 * construction.
 */
export function tenantKyselyForDsn(dsn: string, opts: { maxConnections?: number } = {}): Engine {
  const existing = ENGINES.get(dsn);
  if (existing !== undefined) {
    return existing;
  }
  const pool = new Pool({ connectionString: dsn, max: opts.maxConnections ?? 8 });
  const db = new Kysely<ReviewFindingsDb>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new TenancyPlugin()],
  });
  const engine: Engine = { pool, db };
  ENGINES.set(dsn, engine);
  return engine;
}

/** Tear down a memoized engine (tests / shutdown). No-op when the DSN was never opened. */
export async function disposeTenantKysely(dsn: string): Promise<void> {
  const engine = ENGINES.get(dsn);
  if (engine === undefined) {
    return;
  }
  ENGINES.delete(dsn);
  await engine.db.destroy();
}

// ─── The repo ───────────────────────────────────────────────────────────────────────────────────

/** Implements the frozen Python ReviewFindingsRepoPort against `core.review_findings`. */
export class PostgresReviewFindingsRepo {
  private readonly db: Kysely<ReviewFindingsDb>;
  private readonly clock: Clock;

  public constructor({ db, clock }: { db: Kysely<ReviewFindingsDb>; clock: Clock }) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * Persist findings; returns the ordered finding IDs (1:1 with Python `persist_aggregated`).
   *
   * Multi-row INSERT (one `VALUES (...)` tuple per finding) collapsing N round-trips into one, with
   * `ON CONFLICT (review_finding_id) DO NOTHING` for replay idempotency. JSONB columns (`citations`,
   * `policy_metadata`, `evidence_refs`) are written with `CAST(:x AS JSONB)` over a `JSON.stringify`d
   * payload — mirroring the frozen Python idiom. The empty-findings case skips the INSERT (an empty
   * VALUES clause is illegal in Postgres) but still returns the (empty) ordered id tuple.
   *
   * `policyMetadata` is per-finding aligned by index (None / out-of-range → `{}`), 1:1 with the
   * Python T-8b semantics.
   *
   * DEFERRED (see module header): the AD-4 stale-write guard + FINDINGS_PERSISTED milestone emit the
   * Python version runs inside this transaction are NOT wired here (un-ported cross-subsystem deps).
   * `runId` / `reviewId` are accepted and preserved so threading the guard later is additive.
   */
  public async persistAggregated(args: {
    prId: string;
    installationId: string;
    aggregated: AggregatedFindingsV1;
    runId: string;
    reviewId: string;
    policyMetadata?: ReadonlyArray<Record<string, unknown>> | null;
  }): Promise<ReadonlyArray<string>> {
    const { prId, installationId, aggregated } = args;
    const policyMetadata = args.policyMetadata ?? null;

    // S20.DM-FIX M4 — Clock injection (was: datetime.now(UTC)); recorded as created_at on each row.
    const now = this.clock.now();

    const findingIds: Array<string> = [];
    type Row = {
      rfid: string;
      file_path: string;
      start_line: number;
      end_line: number;
      severity: string;
      category: string;
      title: string;
      body: string;
      suggestion: string | null;
      confidence: number;
      citations: string;
      policy_metadata: string;
      scope: string;
      evidence_refs: string;
    };
    const rows: Array<Row> = [];

    aggregated.findings.forEach((finding, i) => {
      const rfid = deriveReviewFindingId({
        prId,
        file: finding.file,
        startLine: finding.start_line,
        endLine: finding.end_line,
        severity: finding.severity,
        title: finding.title,
      });
      findingIds.push(rfid);
      const citationsJson = finding.sources;
      // T-8b: per-finding policy_metadata aligned by index. None or out-of-range → {} (column default).
      // `.at(i)` (not `[i]`) avoids the object-injection sink; `i` is a bounded forEach loop counter.
      const pm = policyMetadata !== null && i < policyMetadata.length ? policyMetadata.at(i) ?? {} : {};
      rows.push({
        rfid,
        file_path: finding.file,
        start_line: finding.start_line,
        end_line: finding.end_line,
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
        body: finding.body,
        suggestion: finding.suggestion,
        confidence: finding.confidence,
        // R-2 — v9-MINIMAL scope + v10 evidence_refs wire-through (JSONB ::cast on write).
        citations: JSON.stringify(citationsJson),
        policy_metadata: JSON.stringify(pm),
        scope: finding.scope,
        evidence_refs: JSON.stringify([...finding.evidence_refs]),
      });
    });

    // BF-8 smoke fix: a clean PR (0 findings) flows through WITHOUT an empty VALUES clause; the
    // INSERT is skipped. (The FINDINGS_PERSISTED milestone emit the Python version runs in this case
    // is deferred — see module header.)
    if (rows.length > 0) {
      // S20.DM-FIX I5 — single multi-row INSERT. Build the VALUES tuples with `sql.join`; every bind
      // value flows through parameterised `sql` fragments (no user data interpolated).
      const valueTuples = rows.map(
        (r) =>
          sql`(${r.rfid}, ${installationId}, ${prId}, ${r.file_path}, ${r.start_line}, ${r.end_line}, ${r.severity}, ${r.category}, ${r.title}, ${r.body}, ${r.suggestion}, ${r.confidence}, CAST(${r.citations} AS JSONB), CAST(${r.policy_metadata} AS JSONB), ${r.scope}, CAST(${r.evidence_refs} AS JSONB), ${now})`,
      );
      await sql`
        INSERT INTO core.review_findings
          (review_finding_id, installation_id, pr_id,
           file_path, start_line, end_line,
           severity, category, title, body, suggestion,
           confidence, citations, policy_metadata,
           scope, evidence_refs, created_at)
        VALUES ${sql.join(valueTuples)}
        ON CONFLICT (review_finding_id) DO NOTHING
      `.execute(this.db);
    }

    return findingIds;
  }

  // ─── Phase D / Task D.7 — arbitration persistence ─────────────────────────────────────────────

  /**
   * Insert one Tier-1 `core.review_findings` row (1:1 with Python `insert_tier1_finding`).
   *
   * Idempotent via `ON CONFLICT (review_finding_id) DO NOTHING`. `installation_id` is part of the
   * INSERT VALUES (literal SQL) so the tenancy gate sees the column. Tier-1 scaffolding defaults
   * (1:1 with the frozen source): severity='issue', category='other', confidence=1.0,
   * title=body=`<tool>:<rule_id>`, citations=[], scope='chunk_observed', evidence_refs=[], tier=1.
   */
  public async insertTier1Finding(args: {
    installationId: string;
    prId: string;
    reviewFindingId: string;
    file: string;
    startLine: number;
    endLine: number;
    tool: string;
    ruleId: string;
    suppressionState: string;
    suppressionReason: string | null;
    suppressionConfidence: number | null;
    suppressionModel: string | null;
    suppressionPromptVersion: string | null;
    suppressedAt: Date | null;
  }): Promise<void> {
    const now = this.clock.now();
    const ruleTitle = `${args.tool}:${args.ruleId}`;
    await sql`
      INSERT INTO core.review_findings (
        review_finding_id, installation_id, pr_id,
        file_path, start_line, end_line,
        severity, category, title, body, suggestion,
        confidence, citations, scope, evidence_refs, created_at,
        tier, source_tool,
        suppression_state, suppression_reason, suppression_confidence,
        suppression_model, suppression_prompt_version, suppressed_at
      ) VALUES (
        ${args.reviewFindingId}, ${args.installationId}, ${args.prId},
        ${args.file}, ${args.startLine}, ${args.endLine},
        ${"issue"}, ${"other"}, ${ruleTitle}, ${ruleTitle}, ${null},
        ${1.0}, CAST(${JSON.stringify([])} AS JSONB),
        ${"chunk_observed"}, CAST(${JSON.stringify([])} AS JSONB), ${now},
        ${1}, ${args.tool},
        CAST(${args.suppressionState} AS core.suppression_state),
        ${args.suppressionReason}, ${args.suppressionConfidence},
        ${args.suppressionModel}, ${args.suppressionPromptVersion}, ${args.suppressedAt}
      ) ON CONFLICT (review_finding_id) DO NOTHING
    `.execute(this.db);
  }

  /**
   * UPDATE a previously-persisted Tier-2 finding row with the arbitration decision metadata
   * (1:1 with Python `update_tier2_arbitration`). The WHERE clause filters on `installation_id` so
   * cross-tenant mutation is structurally impossible.
   */
  public async updateTier2Arbitration(args: {
    installationId: string;
    reviewFindingId: string;
    suppressionState: string;
    suppressionReason: string | null;
    suppressionConfidence: number | null;
    suppressionModel: string | null;
    suppressionPromptVersion: string | null;
    suppressedAt: Date | null;
  }): Promise<void> {
    await sql`
      UPDATE core.review_findings SET
        suppression_state = CAST(${args.suppressionState} AS core.suppression_state),
        suppression_reason = ${args.suppressionReason},
        suppression_confidence = ${args.suppressionConfidence},
        suppression_model = ${args.suppressionModel},
        suppression_prompt_version = ${args.suppressionPromptVersion},
        suppressed_at = ${args.suppressedAt},
        source_tool = COALESCE(source_tool, 'llm'),
        tier = 2
      WHERE review_finding_id = ${args.reviewFindingId}
        AND installation_id = ${args.installationId}
    `.execute(this.db);
  }

  // ─── ADR-0056 / PR-1 — finding-delivery-lifecycle setters ─────────────────────────────────────

  /**
   * Atomically flip rows to DELIVERY_FINALIZED via inline delivery (1:1 with Python
   * `record_delivery_finalized`): sets delivery_eligibility='eligible' +
   * delivery_outcome='inline_delivered' + github_comment_id + posted_review_pr_id +
   * lifecycle_updated_at=NOW() in one bulk `UPDATE ... FROM unnest(rfids, comment_ids)`.
   *
   * `writesEnabled=false` → returns `[]`, no DB access. `rfids` empty → `[]`. `rfids` and
   * `commentIds` are index-paired and MUST be equal-length (mismatch raises BEFORE any DB access).
   * The `WHERE delivery_outcome IS NULL` guard makes the flip idempotent; the
   * `suppression_state = 'NONE'` guard skips suppressed rows (F2). Returns the rfids that flipped.
   *
   * DEFERRED (module header): the AD-4 stale-write guard + OTel/structlog emits are not wired here.
   */
  public async recordDeliveryFinalized(args: {
    installationId: string;
    rfids: ReadonlyArray<string>;
    commentIds: ReadonlyArray<number>;
    postedReviewPrId: string;
    runId: string;
    reviewId: string;
    writesEnabled: boolean;
  }): Promise<ReadonlyArray<string>> {
    if (!args.writesEnabled) {
      return [];
    }
    if (args.rfids.length === 0) {
      return [];
    }
    if (args.rfids.length !== args.commentIds.length) {
      throw new Error(
        `length mismatch: rfids=${args.rfids.length} comment_ids=${args.commentIds.length}`,
      );
    }

    const result = await sql<{ review_finding_id: string }>`
      UPDATE core.review_findings AS rf
      SET delivery_eligibility = CAST('eligible' AS core.delivery_eligibility),
          delivery_outcome = CAST('inline_delivered' AS core.delivery_outcome),
          github_comment_id = data.cid,
          posted_review_pr_id = ${args.postedReviewPrId},
          lifecycle_updated_at = NOW()
      FROM unnest(CAST(${[...args.rfids]} AS UUID[]), CAST(${[...args.commentIds]} AS BIGINT[]))
           AS data(rfid, cid)
      WHERE rf.review_finding_id = data.rfid
        AND rf.installation_id = ${args.installationId}
        AND rf.delivery_outcome IS NULL
        AND rf.suppression_state = CAST('NONE' AS core.suppression_state)
      RETURNING rf.review_finding_id
    `.execute(this.db);

    return result.rows.map((r) => r.review_finding_id);
  }

  /**
   * Atomically flip rows to DELIVERY_FINALIZED via the not_applicable outcome (1:1 with Python
   * `record_delivery_skipped`): sets delivery_eligibility='skipped' + per-row eligibility_reason +
   * delivery_outcome='not_applicable' + posted_review_pr_id + lifecycle_updated_at=NOW() via
   * `UPDATE ... FROM unnest(rfids, reasons)`.
   *
   * Length parity (rfids vs reasons) AND the eligibility-reason allowlist are enforced BEFORE any DB
   * access; either violation raises so a caller mistake never leaves a half-flipped review. Same
   * kill-switch + idempotency + suppression-skip semantics as {@link recordDeliveryFinalized}.
   */
  public async recordDeliverySkipped(args: {
    installationId: string;
    rfids: ReadonlyArray<string>;
    reasons: ReadonlyArray<string>;
    postedReviewPrId: string;
    runId: string;
    reviewId: string;
    writesEnabled: boolean;
  }): Promise<ReadonlyArray<string>> {
    if (!args.writesEnabled) {
      return [];
    }
    if (args.rfids.length === 0) {
      return [];
    }
    if (args.rfids.length !== args.reasons.length) {
      throw new Error(`length mismatch: rfids=${args.rfids.length} reasons=${args.reasons.length}`);
    }
    // F6 — pre-flight allowlist check; an unknown reason would abort the whole batch on cast-to-enum.
    for (const r of args.reasons) {
      if (!VALID_ELIGIBILITY_REASONS.has(r)) {
        throw new Error(
          `unknown eligibility_reason: ${JSON.stringify(r)} ` +
            `(valid: ${[...VALID_ELIGIBILITY_REASONS].sort().join(", ")})`,
        );
      }
    }

    const result = await sql<{ review_finding_id: string }>`
      UPDATE core.review_findings AS rf
      SET delivery_eligibility = CAST('skipped' AS core.delivery_eligibility),
          eligibility_reason = CAST(data.reason AS core.finding_eligibility_reason),
          delivery_outcome = CAST('not_applicable' AS core.delivery_outcome),
          posted_review_pr_id = ${args.postedReviewPrId},
          lifecycle_updated_at = NOW()
      FROM unnest(CAST(${[...args.rfids]} AS UUID[]), CAST(${[...args.reasons]} AS TEXT[]))
           AS data(rfid, reason)
      WHERE rf.review_finding_id = data.rfid
        AND rf.installation_id = ${args.installationId}
        AND rf.delivery_outcome IS NULL
        AND rf.suppression_state = CAST('NONE' AS core.suppression_state)
      RETURNING rf.review_finding_id
    `.execute(this.db);

    return result.rows.map((r) => r.review_finding_id);
  }

  /**
   * Atomically flip rows to DELIVERY_FINALIZED via a degraded outcome (1:1 with Python
   * `record_delivery_degraded`): sets delivery_eligibility='eligible' + delivery_outcome=outcome +
   * posted_review_pr_id + lifecycle_updated_at=NOW() where outcome ∈ {body_only_fallback, failed}.
   *
   * Outcome validation runs BEFORE the writesEnabled short-circuit so a typo in a wired-but-disabled
   * environment surfaces at the first dispatch attempt. inline_delivered / not_applicable are owned
   * by the finalize / skip setters. Same idempotency + suppression-skip semantics as the others.
   */
  public async recordDeliveryDegraded(args: {
    installationId: string;
    rfids: ReadonlyArray<string>;
    outcome: string;
    postedReviewPrId: string;
    runId: string;
    reviewId: string;
    writesEnabled: boolean;
  }): Promise<ReadonlyArray<string>> {
    if (!DEGRADED_OUTCOMES.includes(args.outcome)) {
      throw new Error(
        `record_delivery_degraded outcome=${JSON.stringify(args.outcome)} not in ` +
          `${[...DEGRADED_OUTCOMES].sort().join(", ")}; ` +
          `inline_delivered / not_applicable are owned by the finalize / skip setters respectively`,
      );
    }
    if (!args.writesEnabled) {
      return [];
    }
    if (args.rfids.length === 0) {
      return [];
    }

    const result = await sql<{ review_finding_id: string }>`
      UPDATE core.review_findings AS rf
      SET delivery_eligibility = CAST('eligible' AS core.delivery_eligibility),
          delivery_outcome = CAST(${args.outcome} AS core.delivery_outcome),
          posted_review_pr_id = ${args.postedReviewPrId},
          lifecycle_updated_at = NOW()
      FROM unnest(CAST(${[...args.rfids]} AS UUID[])) AS data(rfid)
      WHERE rf.review_finding_id = data.rfid
        AND rf.installation_id = ${args.installationId}
        AND rf.delivery_outcome IS NULL
        AND rf.suppression_state = CAST('NONE' AS core.suppression_state)
      RETURNING rf.review_finding_id
    `.execute(this.db);

    return result.rows.map((r) => r.review_finding_id);
  }

  /**
   * Read query for the walkthrough renderer's DB-mode (1:1 with Python
   * `fetch_skipped_for_walkthrough`). Returns rows where delivery_eligibility='skipped' AND
   * suppression_state='NONE', tenancy-scoped on installation_id, ordered by severity rank
   * (blocker 0 < issue 1 < suggestion 2 < nit 3 < else 4) then file_path then start_line.
   *
   * This path uses the Kysely query builder so the TenancyPlugin's AST walk verifies the real
   * `installation_id = :iid` equality predicate at build time (the `where(... installation_id ...)`
   * below). The severity-rank ORDER BY is an `sql` expression (the same CASE the Python source uses).
   */
  public async fetchSkippedForWalkthrough(args: {
    installationId: string;
    prId: string;
  }): Promise<ReadonlyArray<SkippedFindingRow>> {
    const severityRank = sql<number>`CASE severity
      WHEN 'blocker' THEN 0
      WHEN 'issue' THEN 1
      WHEN 'suggestion' THEN 2
      WHEN 'nit' THEN 3
      ELSE 4
    END`;

    const rows = await this.db
      .selectFrom("core.review_findings")
      .select([
        "review_finding_id",
        "file_path",
        "start_line",
        "end_line",
        "severity",
        "category",
        "title",
        "eligibility_reason",
      ])
      .where("installation_id", "=", args.installationId)
      .where("pr_id", "=", args.prId)
      .where("delivery_eligibility", "=", sql<string>`CAST('skipped' AS core.delivery_eligibility)`)
      .where("suppression_state", "=", sql<string>`CAST('NONE' AS core.suppression_state)`)
      .orderBy(severityRank)
      .orderBy("file_path")
      .orderBy("start_line")
      .execute();

    return rows.map((r) => ({
      reviewFindingId: r.review_finding_id,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      severity: r.severity,
      category: r.category,
      title: r.title,
      // delivery_eligibility='skipped' implies eligibility_reason IS NOT NULL (ck_lifecycle_skipped_has_reason).
      eligibilityReason: r.eligibility_reason ?? "",
    }));
  }
}
