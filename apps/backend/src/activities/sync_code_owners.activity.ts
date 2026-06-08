/**
 * `syncCodeOwners` activity — registered Temporal activity name `sync_code_owners_activity`.
 *
 * FAITHFUL 1:1 port of the frozen Python
 * `vendor/codemaster-py/codemaster/activities/sync_code_owners.py::SyncCodeOwnersActivity.sync_code_owners`
 * (Sprint 21 / S21.DM.11; consumer-wired S23.AR.4 / DM-WIRE T0).
 *
 * Fetches the repository's CODEOWNERS file from the default branch via the injected {@link CodeOwnersFilePort}
 * (the spine adapter tries `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS` in order — that adapter is
 * the INTEGRATOR's wiring, NOT this holder), parses it via the ported {@link parseCodeowners}, and upserts
 * each rule into `core.code_owners` through the injected {@link CodeOwnersRepoPort}
 * ({@link PostgresCodeOwnersRepo}). Returns the count of rules persisted.
 *
 * ## Feature flag
 *
 * Gated INSIDE the activity on `code_owners_v1` (the injected `isEnabled`). Disabled → return 0 WITHOUT any
 * I/O (no GitHub fetch, no DB write). The webhook emit is UNCONDITIONAL; the activity is the gate. The
 * `core.flags` reader is an ingest-side helper the INTEGRATOR wires (same as fetch_suggested_reviewers'
 * `isEnabled` is wired DEFAULT-OFF in build_activities until the flag-reader is ported — see
 * FOLLOW-UP-code-owners-v1-flag-reader there).
 *
 * ## Idempotency (replay-safe)
 *
 * `deriveCodeOwnerId` is a UUIDv5 of `(repository_id, path_pattern, source_file_sha)` — content-addressable,
 * NO clock / random. The repo's `INSERT … ON CONFLICT (repository_id, path_pattern, source_file_sha) DO
 * NOTHING` collapses replays against the same CODEOWNERS SHA to a no-op (returns 0).
 *
 * ## Empty-output cases (return 0 cleanly, 1:1 with the Python)
 *   - `code_owners_v1` flag disabled.
 *   - Repo has no CODEOWNERS file (the port returns null).
 *   - File parses to zero valid rules (all malformed).
 *   - File SHA matches an already-persisted batch (ON CONFLICT no-ops everything).
 *
 * ## Typed-input envelope (CLAUDE.md invariant 11 / ADR-0047)
 *
 * The frozen Python dispatches with SIX positional arguments; this port CLOSES that violation — the single
 * positional input is the {@link SyncCodeOwnersPayloadV1} envelope (field names mirror the Python payload
 * dict keys verbatim so the webhook emitter needs no rename adapter).
 *
 * ## Runtime context
 *
 * The activity runs in the NORMAL Node runtime (NOT the workflow V8-isolate sandbox), so real GitHub + DB
 * I/O is fine. The clock is injected for parity with the Python constructor; the sync path does no time math
 * (`synced_at` is set by the DB server clock inside `upsertRules`).
 */

import type { CodeOwnerRuleV1 } from "#contracts/code_owner_rule.v1.js";
import type { SyncCodeOwnersPayloadV1 } from "#contracts/sync_code_owners_payload.v1.js";

import type { Clock } from "#platform/clock.js";
import { uuid5 } from "#platform/randomness.js";

import { parseCodeowners } from "#backend/integrations/github/codeowners_parser.js";

/**
 * uuid5 namespace — stable across replays so the same `(repository_id, path_pattern, source_file_sha)`
 * tuple always maps to the same code_owner_id. 1:1 with the Python
 * `_CODE_OWNER_UUID5_NAMESPACE = uuid.UUID("8c8c9d13-0a3e-5e0f-9b7e-fc2c3a8d9703")`. MUST NOT change — it
 * would re-key every rule.
 */
export const CODE_OWNER_UUID5_NAMESPACE = "8c8c9d13-0a3e-5e0f-9b7e-fc2c3a8d9703";

/**
 * Stable per-rule UUIDv5 keyed on the natural-key tuple. 1:1 with the Python `derive_code_owner_id`:
 * `uuid5(NAMESPACE, f"{repository_id}|{path_pattern}|{source_file_sha}")`. Deterministic (no randomness),
 * so byte-for-byte identical to the Python derivation across replays + across the TS/Python impls.
 */
export function deriveCodeOwnerId(args: {
  repositoryId: string;
  pathPattern: string;
  sourceFileSha: string;
}): string {
  const name = `${args.repositoryId}|${args.pathPattern}|${args.sourceFileSha}`;
  return uuid5(CODE_OWNER_UUID5_NAMESPACE, name);
}

/**
 * The slice of GitHub the activity needs (1:1 with the Python `CodeOwnersFilePort`).
 *
 * Returns either `[contentBytes, blobSha]` or `null` when no CODEOWNERS file is present in the repo. The
 * activity treats the null case as a no-op (some repos genuinely don't have a CODEOWNERS file).
 *
 * `contentBytes` are the BASE64-ASCII bytes the GitHub contents API yields (the activity base64-decodes) —
 * exactly the shape `GitHubApiClient.getContents` returns. The INTEGRATOR's spine adapter wraps
 * `getContents` with the three-path CODEOWNERS lookup behind this port.
 */
export type CodeOwnersFilePort = {
  fetchCodeowners(args: {
    installationId: number;
    owner: string;
    repo: string;
    ref: string;
  }): Promise<readonly [Uint8Array, string] | null>;
};

/**
 * Repo Protocol consumed by the activity (1:1 with the Python `CodeOwnersRepoPort`).
 *
 * `upsertRules` returns the count of rules written; ON CONFLICT DO NOTHING absorbs replays against the same
 * SHA. The concrete {@link PostgresCodeOwnersRepo} satisfies this shape.
 */
export type CodeOwnersRepoPort = {
  upsertRules(args: {
    installationId: string;
    repositoryId: string;
    rules: ReadonlyArray<CodeOwnerRuleV1>;
  }): Promise<number>;
};

/** An async feature-flag check (1:1 with the Python `Callable[[], Awaitable[bool]]`). */
export type IsEnabled = () => Promise<boolean>;

/**
 * GitHub's contents API returns base64-encoded bodies. Decode + utf-8 the result. Defensive against odd
 * encoding hints. 1:1 with the Python `_decode_github_contents` (default encoding "base64").
 *
 * `content` are the base64-ASCII bytes from the port; `Buffer.from(content).toString("base64")` would be
 * wrong — the bytes ARE the base64 text, so we read them as a base64-encoded latin1 string and decode.
 * Errors are replaced (utf-8 `errors="replace"` analogue → Node's lossy "utf-8" decode of a Buffer).
 */
export function decodeGithubContents(content: Uint8Array, encoding = "base64"): string {
  if (encoding === "base64") {
    // The bytes are the ASCII characters of the base64 text; reconstruct that text, then base64-decode it.
    const b64Text = Buffer.from(content).toString("latin1");
    return Buffer.from(b64Text, "base64").toString("utf-8");
  }
  return Buffer.from(content).toString("utf-8");
}

/**
 * Map parser output → wire envelope rows. Filters out rules whose SHA-derived UUIDv5 collides (defensive —
 * should not happen under normal CODEOWNERS shapes). 1:1 with the Python `_to_v1_rules`.
 */
export function toV1Rules(args: {
  parsed: ReadonlyArray<{ path_pattern: string; owner_logins: ReadonlyArray<string> }>;
  installationId: string;
  repositoryId: string;
  sourceFileSha: string;
}): ReadonlyArray<CodeOwnerRuleV1> {
  const out: Array<CodeOwnerRuleV1> = [];
  const seen = new Set<string>();
  for (const r of args.parsed) {
    const rid = deriveCodeOwnerId({
      repositoryId: args.repositoryId,
      pathPattern: r.path_pattern,
      sourceFileSha: args.sourceFileSha,
    });
    if (seen.has(rid)) {
      continue;
    }
    seen.add(rid);
    out.push({
      schema_version: 1,
      code_owner_id: rid,
      installation_id: args.installationId,
      repository_id: args.repositoryId,
      path_pattern: r.path_pattern,
      owner_logins: [...r.owner_logins],
      source_file_sha: args.sourceFileSha,
      synced_at: null,
    });
  }
  return out;
}

/** Bound-method holder for `sync_code_owners_activity` (1:1 with the Python `SyncCodeOwnersActivity`). */
export class SyncCodeOwnersActivity {
  readonly #github: CodeOwnersFilePort;
  readonly #repo: CodeOwnersRepoPort;
  readonly #isEnabled: IsEnabled;
  // The injected clock is part of the Python constructor's dependency set; retained for parity even though
  // the sync path does no time math (`synced_at` is the DB server clock in upsertRules).
  readonly #clock: Clock;

  public constructor(args: {
    github: CodeOwnersFilePort;
    repo: CodeOwnersRepoPort;
    isEnabled: IsEnabled;
    clock: Clock;
  }) {
    this.#github = args.github;
    this.#repo = args.repo;
    this.#isEnabled = args.isEnabled;
    this.#clock = args.clock;
  }

  /**
   * Fetch + parse + upsert. Returns the count of rules persisted. 1:1 with the Python `sync_code_owners`.
   *
   * Returns 0 when: `code_owners_v1` disabled; repo has no CODEOWNERS file; file parses to zero valid
   * rules; or the file's SHA matches an already-persisted batch (ON CONFLICT no-ops everything).
   *
   * @param input the typed single-arg envelope (closes the Python 6-positional dispatch).
   */
  public async syncCodeOwners(input: SyncCodeOwnersPayloadV1): Promise<number> {
    if (!(await this.#isEnabled())) {
      return 0;
    }

    const fetched = await this.#github.fetchCodeowners({
      installationId: input.installation_id_int,
      owner: input.owner,
      repo: input.repo,
      ref: input.default_branch,
    });
    if (fetched === null) {
      // No CODEOWNERS file in this repo on the default branch — no-op (some repos genuinely don't have one).
      return 0;
    }

    const [contentBytes, sourceFileSha] = fetched;
    const body = decodeGithubContents(contentBytes);
    const parsed = parseCodeowners(body);
    if (parsed.length === 0) {
      return 0;
    }

    const rules = toV1Rules({
      parsed,
      installationId: input.installation_id_uuid,
      repositoryId: input.repository_id,
      sourceFileSha,
    });

    return this.#repo.upsertRules({
      installationId: input.installation_id_uuid,
      repositoryId: input.repository_id,
      rules,
    });
  }

  /** Exposed for parity with the Python constructor's clock dependency (kept reachable). */
  public clock(): Clock {
    return this.#clock;
  }
}
