/**
 * `code_owners_v1` feature flag (W4.6 [OM9]) — gates the `sync_code_owners` dispatch in the
 * push-event webhook → background-jobs chain.
 * Default: false. KEPT GATED (the 2026-05-24 drop-rollout-flags PR removed the other rollout
 * flags; this one stays because `sync_code_owners` makes a per-PR `GET .github/CODEOWNERS` API
 * call — GitHub-rate-limit pressure at the 60-org × 3000-repo target until a rate-limit-guarded
 * rollout story handles it).
 *
 * Fail-mode: fail-OPEN to false — a flag-table blip must NOT block webhook persistence (the
 * activity short-circuits when disabled; suggested-reviewers renders empty). NEVER throws.
 *
 * Tenancy: cross-tenant SELECT against `core.flags` (scope='global') — `core.flags` is a
 * platform-global config table outside TENANT_SCOPED_TABLES (permanent tenant:exempt).
 */

import { type Kysely, sql } from "kysely";

const FLAG_NAME = "code_owners_v1";

/**
 * Read the `code_owners_v1` flag from `core.flags`.
 *
 * Returns true IFF the row exists AND its `rollout` JSONB resolves to `{"enabled": true}` (strict
 * boolean — the Python `enabled is True`). False on absent row, malformed JSONB, missing key, or
 * any read error. Never raises.
 */
export async function readCodeOwnersV1Enabled(db: Kysely<unknown>): Promise<boolean> {
  let rollout: unknown;
  try {
    const r = await sql<{ rollout: unknown }>`
      SELECT rollout FROM core.flags WHERE flag_name = ${FLAG_NAME} LIMIT 1
    `.execute(db);
    rollout = r.rows[0]?.rollout;
  } catch (e) {
    // Python: _LOG.info("code_owners_v1: flag read failed; defaulting to false", {event, error}).
    console.info(
      JSON.stringify({
        event: "code_owners_v1_flag.read_failed",
        error: e instanceof Error ? e.name : typeof e,
      }),
    );
    return false;
  }

  if (rollout === undefined || rollout === null) {
    return false; // absent row (or NULL rollout) → default-off
  }

  // node-pg parses jsonb to a JS value; a jsonb STRING payload arrives as a string — parse it
  // defensively (the Python `isinstance(rollout, str)` branch for async drivers).
  if (typeof rollout === "string") {
    try {
      rollout = JSON.parse(rollout);
    } catch {
      return false;
    }
  }

  if (typeof rollout !== "object" || rollout === null || Array.isArray(rollout)) {
    return false;
  }

  return (rollout as Record<string, unknown>)["enabled"] === true;
}
