import { z } from "zod";

// Zod port of contracts/repair_installation_repositories/payload_v1.py (frozen Python).
// NON-STANDARD layout: the contract lives in a versioned FILE `payload_v1.py` (not a v1/ dir),
// so its Python module is `contracts.repair_installation_repositories.payload_v1`.
// Parity-validated in repair_installation_repositories.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - TriggerSource (Python Literal["pr_webhook", "admin_manual", "installation_created"]) → z.enum
//  - RepairInstallationRepositoriesPayloadV1
//    (ConfigDict(extra="forbid", frozen=True) → .strict(); frozen is a TS-side concern, not wire)
//
// Field notes:
//  - schema_version: Literal[1] = 1   → z.literal(1).default(1)
//  - github_installation_id: int Field(ge=1) → z.number().int().gte(1) (required; no default)
//  - trigger_source: Literal[...]     → TriggerSource enum (required; no default)

// trigger_source = Literal["pr_webhook", "admin_manual", "installation_created"]
export const TriggerSource = z.enum(["pr_webhook", "admin_manual", "installation_created"]);
export type TriggerSource = z.infer<typeof TriggerSource>;

// RepairInstallationRepositoriesPayloadV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const RepairInstallationRepositoriesPayloadV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    github_installation_id: z.number().int().gte(1),
    trigger_source: TriggerSource,
  })
  .strict();
export type RepairInstallationRepositoriesPayloadV1 = z.infer<
  typeof RepairInstallationRepositoriesPayloadV1
>;
