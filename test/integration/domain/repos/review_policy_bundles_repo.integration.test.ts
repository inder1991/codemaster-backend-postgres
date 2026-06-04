import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  ReviewPolicyBundlesRepo,
  type ReviewPolicyBundleRow,
} from "#backend/domain/repos/review_policy_bundles_repo.js";

import { disposeAllPools, getPool } from "#platform/db/database.js";

import { type ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied; core.review_policy_bundles
// has 6 columns: review_id PK uuid, installation_id uuid, applied_bundle jsonb, rule_count int>=0,
// created_at/updated_at tz). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS
// otherwise so validate-fast stays green without a DB. We NEVER touch any other DB. Each test uses a
// UNIQUE installation_id + review_id and cleans up its own rows.

let pool: Pool;
let repo: ReviewPolicyBundlesRepo;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: the repo + the raw seed/assert reads share the ONE process-wide pool from the central
  // factory (getPool / tenantKysely) — never a private per-file pool.
  pool = getPool(INTEGRATION_DSN);
  repo = ReviewPolicyBundlesRepo.fromDsn(INTEGRATION_DSN);
});

afterAll(async () => {
  // ADR-0062 teardown: end the shared pool(s) via the central seam — NOT a private pool.end().
  await disposeAllPools();
});

/** Delete every row this test family created for a given installation_id. */
async function cleanupInstallation(installationId: string): Promise<void> {
  await pool.query(`DELETE FROM core.review_policy_bundles WHERE installation_id = $1`, [
    installationId,
  ]);
}

// sha256-shaped hex strings (exactly 64 chars) for normalized_hash + source_file_sha256 on the
// nested ExtractedRuleV1 payloads.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

// `satisfies` (not `as const`) so each field types as the mutable shape the contract's input type
// expects (heading_path: string[]), while still type-checking against the schema's inferred input.
type ExtractedRuleInput = ResolvedGuidanceBundleV1["applicable_rules"][number]["rule"];

/** A representative valid nested ExtractedRuleV1 payload (no float / UUID / datetime fields). */
const RULE_SECURITY: ExtractedRuleInput = {
  schema_version: 1,
  rule_id: "sec-src-no-eval-1a2b3c",
  normalized_hash: HASH_A,
  source_file: "src/CLAUDE.md",
  source_file_sha256: HASH_B,
  scope_dir: "src",
  heading_path: ["Security", "Input handling"],
  rule_index: 3,
  title: "No eval()",
  body: "Never call eval() on untrusted input.",
  category: "security",
  intent: "forbid",
  priority: 100,
  oversized_rule_warning: false,
};

/** A second nested rule (different normalized_hash) — used as an extra `sources` entry. */
const RULE_SECURITY_ANCESTOR: ExtractedRuleInput = {
  schema_version: 1,
  rule_id: "sec-root-no-eval-9z8y7x",
  normalized_hash: HASH_C,
  source_file: "CLAUDE.md",
  source_file_sha256: HASH_B,
  scope_dir: "",
  heading_path: ["Security"],
  rule_index: 0,
  title: "No eval()",
  body: "Never call eval() on untrusted input.",
  category: "security",
  intent: "forbid",
  priority: 100,
  oversized_rule_warning: false,
};

/** A full bundle with one deduped rule (canonical + 2 sources) and one explanation line. */
function fullBundle(changedPath: string): ResolvedGuidanceBundleV1 {
  return {
    schema_version: 1,
    changed_path: changedPath,
    applicable_rules: [
      { schema_version: 1, rule: RULE_SECURITY, sources: [RULE_SECURITY, RULE_SECURITY_ANCESTOR] },
    ],
    resolution_explanation: [
      "Applied src/CLAUDE.md (Security > Input handling) - nearest-ancestor; category=security, intent=forbid, priority=100",
    ],
  };
}

/** An empty bundle (no applicable rules) — exercises the rule_count=0 + default-fields path. */
function emptyBundle(changedPath: string): ResolvedGuidanceBundleV1 {
  return {
    schema_version: 1,
    changed_path: changedPath,
    applicable_rules: [],
    resolution_explanation: [],
  };
}

describeDb("ReviewPolicyBundlesRepo (integration, disposable PG)", () => {
  it("round-trips upsert → get: the read bundle equals the written bundle byte-faithfully", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    const bundle = fullBundle("src/app.py");
    try {
      await repo.upsert({ review_id: reviewId, installation_id: installationId, bundle });

      const row = await repo.get({ review_id: reviewId, installation_id: installationId });
      expect(row).not.toBeNull();
      const r = row as ReviewPolicyBundleRow;
      expect(r.review_id).toBe(reviewId);
      expect(r.installation_id).toBe(installationId);
      // rule_count is DERIVED from applicable_rules.length, never the caller (here: 1).
      expect(r.rule_count).toBe(1);
      // The JSONB round-trips byte-faithfully through the canonical contract serialization.
      expect(r.bundle).toEqual(bundle);
      expect(JSON.stringify(r.bundle)).toBe(JSON.stringify(bundle));
    } finally {
      await cleanupInstallation(installationId);
    }
  });

  it("get returns null for an absent review", async () => {
    const installationId = randomUUID();
    const row = await repo.get({ review_id: randomUUID(), installation_id: installationId });
    expect(row).toBeNull();
  });

  it("persists rule_count=0 and the canonical empty-bundle JSONB", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    const bundle = emptyBundle("README.md");
    try {
      await repo.upsert({ review_id: reviewId, installation_id: installationId, bundle });
      const row = await repo.get({ review_id: reviewId, installation_id: installationId });
      expect(row).not.toBeNull();
      const r = row as ReviewPolicyBundleRow;
      expect(r.rule_count).toBe(0);
      expect(r.bundle).toEqual(bundle);

      // Confirm the on-disk column is real jsonb (object), not a quoted string, and rule_count=0.
      const raw = await pool.query<{ applied_bundle: unknown; rule_count: number }>(
        `SELECT applied_bundle, rule_count FROM core.review_policy_bundles WHERE review_id = $1`,
        [reviewId],
      );
      expect(typeof raw.rows[0]?.applied_bundle).toBe("object");
      expect(Number(raw.rows[0]?.rule_count)).toBe(0);
    } finally {
      await cleanupInstallation(installationId);
    }
  });

  it("upsert is idempotent on the review_id PK: a second upsert overwrites bundle + rule_count", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    try {
      // First write: a full bundle (rule_count 1).
      await repo.upsert({
        review_id: reviewId,
        installation_id: installationId,
        bundle: fullBundle("src/app.py"),
      });
      const first = await repo.get({ review_id: reviewId, installation_id: installationId });
      expect(first?.rule_count).toBe(1);

      // Re-run the same review with a DIFFERENT bundle (empty → rule_count 0, different path).
      const rerun = emptyBundle("src/app.py");
      await repo.upsert({ review_id: reviewId, installation_id: installationId, bundle: rerun });

      const second = await repo.get({ review_id: reviewId, installation_id: installationId });
      expect(second?.rule_count).toBe(0);
      expect(second?.bundle).toEqual(rerun);

      // Exactly ONE row exists for this review (ON CONFLICT overwrote, did not duplicate).
      const cnt = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.review_policy_bundles WHERE review_id = $1`,
        [reviewId],
      );
      expect(Number(cnt.rows[0]?.n)).toBe(1);
    } finally {
      await cleanupInstallation(installationId);
    }
  });

  it("ON CONFLICT carries installation_id from EXCLUDED (a re-run can move the row's tenant)", async () => {
    const installationA = randomUUID();
    const installationB = randomUUID();
    const reviewId = randomUUID();
    const bundle = fullBundle("src/app.py");
    try {
      await repo.upsert({ review_id: reviewId, installation_id: installationA, bundle });
      // Same review_id PK, different installation_id → EXCLUDED.installation_id overwrites.
      await repo.upsert({ review_id: reviewId, installation_id: installationB, bundle });

      // Tenant A no longer sees the row; tenant B does (installation_id was updated to B).
      expect(await repo.get({ review_id: reviewId, installation_id: installationA })).toBeNull();
      const inB = await repo.get({ review_id: reviewId, installation_id: installationB });
      expect(inB?.installation_id).toBe(installationB);
    } finally {
      await cleanupInstallation(installationA);
      await cleanupInstallation(installationB);
    }
  });

  it("tenant isolation: get scoped to installation A does not see installation B's row", async () => {
    const installationA = randomUUID();
    const installationB = randomUUID();
    const reviewIdA = randomUUID();
    const reviewIdB = randomUUID();
    try {
      await repo.upsert({
        review_id: reviewIdA,
        installation_id: installationA,
        bundle: fullBundle("a/app.py"),
      });
      await repo.upsert({
        review_id: reviewIdB,
        installation_id: installationB,
        bundle: fullBundle("b/app.py"),
      });

      // A's review is invisible when queried under B's installation_id, and vice-versa.
      expect(await repo.get({ review_id: reviewIdA, installation_id: installationB })).toBeNull();
      expect(await repo.get({ review_id: reviewIdB, installation_id: installationA })).toBeNull();

      // Each tenant sees only its own row.
      const a = await repo.get({ review_id: reviewIdA, installation_id: installationA });
      const b = await repo.get({ review_id: reviewIdB, installation_id: installationB });
      expect(a?.bundle.changed_path).toBe("a/app.py");
      expect(b?.bundle.changed_path).toBe("b/app.py");
    } finally {
      await cleanupInstallation(installationA);
      await cleanupInstallation(installationB);
    }
  });

  it("round-trips a unicode-bearing changed_path + explanation byte-faithfully through jsonb", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    const bundle: ResolvedGuidanceBundleV1 = {
      schema_version: 1,
      changed_path: "src/café/app.py",
      applicable_rules: [],
      resolution_explanation: ["Applied src/CLAUDE.md — em-dash, café, 日本語"],
    };
    try {
      await repo.upsert({ review_id: reviewId, installation_id: installationId, bundle });
      const row = await repo.get({ review_id: reviewId, installation_id: installationId });
      expect(row?.bundle).toEqual(bundle);
      expect(row?.bundle.changed_path).toBe("src/café/app.py");
    } finally {
      await cleanupInstallation(installationId);
    }
  });
});
