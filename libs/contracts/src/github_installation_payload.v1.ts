import { z } from "zod";

import { GitHubAccountV1, GitHubInstallationV1 } from "./github_pull_request_payload.v1.js";

// Zod port of the `installation` + `installation_repositories` webhook event contracts in
// contracts/integrations/github_payloads/v1.py (read 2026-06-07). These are the
// TRUST-TIER boundary contracts: the raw webhook body is validated against them before any internal
// id resolution / outbox enqueue.
//
// Reuse note: GitHubAccountV1 + GitHubInstallationV1 are NOT redefined here — they are imported from
// github_pull_request_payload.v1.js (the same frozen-Python module defines all four shapes:
// GitHubAccountV1, GitHubInstallationV1, GitHubRepositoryV1, and the two payload events). The PR
// payload file landed GitHubAccountV1/GitHubInstallationV1 first; this file owns GitHubRepositoryV1
// + the two installation-event payloads to keep the installation-flow contracts together.
//
// EXTRA-FIELD HANDLING: every Python model here uses `ConfigDict(extra="ignore")` → Pydantic drops
// unknown keys silently. Zod's DEFAULT `.object()` behaviour also strips unknown keys (`.strip()`),
// so the two agree by construction. We therefore do NOT call `.strict()` here — GitHub adds fields
// freely and both sides drop the ones we don't model.

/**
 * GitHub's `repository` object (subset).
 *
 * Fields: id (int), full_name (1..200), default_branch (default "main"), archived (default false),
 * owner (GitHubAccountV1, required).
 * `owner.login` feeds the v2 outbox enrichment / PR-backfill installation-account synthesis.
 */
export const GitHubRepositoryV1 = z.object({
  id: z.number().int(),
  full_name: z.string().min(1).max(200),
  default_branch: z.string().default("main"),
  archived: z.boolean().default(false),
  owner: GitHubAccountV1,
});
export type GitHubRepositoryV1 = z.infer<typeof GitHubRepositoryV1>;

/**
 * `installation` event payload — created / deleted / suspended / unsuspended.
 *
 * `ConfigDict(extra="ignore")` → default `.strip()` (NO `.strict()`). The producer normalizes the GitHub webhook actions
 * "suspend" → "suspended" / "unsuspend" → "unsuspended" BEFORE validation, so the action enum here is
 * the already-normalized 4-value vocabulary (no "updated"; that lives only on the RESULT contract).
 */
export const GitHubInstallationPayloadV1 = z.object({
  schema_version: z.number().int().default(1),
  action: z.enum(["created", "deleted", "suspended", "unsuspended"]),
  installation: GitHubInstallationV1,
  sender: GitHubAccountV1,
});
export type GitHubInstallationPayloadV1 = z.infer<typeof GitHubInstallationPayloadV1>;

/**
 * `installation_repositories` event payload — added / removed.
 *
 * `ConfigDict(extra="ignore")` → default `.strip()`. The two repo arrays default to `[]`
 * (`Field(default_factory=list)`); the activity reads repo.id / full_name / default_branch / archived
 * (owner is carried but unused on this path).
 */
export const GitHubInstallationRepositoriesPayloadV1 = z.object({
  schema_version: z.number().int().default(1),
  action: z.enum(["added", "removed"]),
  installation: GitHubInstallationV1,
  sender: GitHubAccountV1,
  repositories_added: z.array(GitHubRepositoryV1).default([]),
  repositories_removed: z.array(GitHubRepositoryV1).default([]),
});
export type GitHubInstallationRepositoriesPayloadV1 = z.infer<
  typeof GitHubInstallationRepositoriesPayloadV1
>;
