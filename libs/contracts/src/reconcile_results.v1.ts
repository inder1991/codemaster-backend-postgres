import { z } from "zod";

// Zod port of the RETURN contracts of the two reconcile activities (read 2026-06-07):
//  - ReconcileInstallationResultV1  — codemaster/activities/reconcile_installation.py:40-46
//  - ReconcileRepositoriesResultV1  — codemaster/activities/reconcile_repositories.py:30-35
// Both use `ConfigDict(extra="forbid")` → `.strict()`.
//
// (RepairResultV1, the return of hydrate_installation_repositories_activity, lives in
// repair_installation_repositories.v1.ts next to its request payload — see that file.)

/**
 * Return contract of `reconcile_installation_activity`.
 *
 * Pydantic model (reconcile_installation.py:40-46, `ConfigDict(extra="forbid")` → .strict()):
 *  - schema_version: int = 1                → z.number().int().default(1)
 *  - action: Literal[5 values]              → z.enum([...])  (NOTE the RESULT enum carries "updated",
 *      which the INPUT GitHubInstallationPayloadV1.action does NOT — the activity maps a re-applied
 *      "created" event onto "updated" when a prior installations row already existed, py:256-261)
 *  - installation_id: uuid.UUID             → z.string().uuid()  (UUID lowercased on model_dump json)
 *  - user_id: uuid.UUID | None              → z.string().uuid().nullable()
 *
 * PARITY NOTE (divergence from the task's "default null" instruction): the Python field
 * `user_id: uuid.UUID | None` has NO default assignment → it is REQUIRED-but-nullable in Pydantic v2
 * (the key must be present; the value may be None). Faithful 1:1 keeps it required (no `.default(null)`);
 * the activity always passes `user_id=...` so the key is always present in practice.
 */
export const ReconcileInstallationResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    action: z.enum(["created", "updated", "deleted", "suspended", "unsuspended"]),
    installation_id: z.string().uuid(),
    user_id: z.string().uuid().nullable(),
  })
  .strict();
export type ReconcileInstallationResultV1 = z.infer<typeof ReconcileInstallationResultV1>;

/**
 * Return contract of `reconcile_repositories_activity`.
 *
 * Pydantic model (reconcile_repositories.py:30-35, `ConfigDict(extra="forbid")` → .strict()):
 *  - schema_version: int = 1   → z.number().int().default(1)
 *  - added: int                → z.number().int()  (REQUIRED, no default — the activity always passes it)
 *  - removed: int              → z.number().int()  (REQUIRED, no default)
 *
 * `added` counts every repository in repositories_added (unconditionally, even an UPDATE-refresh of an
 * existing row); `removed` counts only soft-disabled rows that were previously recorded (a remove of an
 * unrecorded repo is a no-op and does NOT increment).
 */
export const ReconcileRepositoriesResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    added: z.number().int(),
    removed: z.number().int(),
  })
  .strict();
export type ReconcileRepositoriesResultV1 = z.infer<typeof ReconcileRepositoriesResultV1>;
