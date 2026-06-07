/**
 * Platform-credential probe + actor-email seams — the injectable ports the platform-credentials PATCH/test
 * handlers depend on. PORTS only (the established preflight-validator idiom); the REAL adapters are wired at
 * the composition root and are DEFERRED:
 *   - testConfluence: ConfluenceClient.list_spaces smoke test + the 6-way exception→error_code map.
 *   - testQwen: embed-ping + the 1024-dim corpus check (errorCode 'dimension_mismatch' on a mismatch).
 * Both need ported external clients (ConfluenceClient / Qwen embeddings adapter) — FOLLOW-UP. Tests inject stubs.
 */

import { type PlatformTestErrorCode } from "#contracts/admin.v1.js";

/** Outcome of a credential probe — 1:1 with the Python *_test_callable return shape. */
export type PlatformTestResult = {
  readonly ok: boolean;
  readonly errorCode: PlatformTestErrorCode | null;
  readonly errorDetail: string | null;
  readonly latencyMs: number | null;
  readonly detectedDimension: number | null; // null for confluence; the observed vector dim for qwen
};

/** Pre-write credential validator. confluence → Bearer-token space smoke test; qwen → embed-ping (the
 *  caller passes the qwen token as `apiKey`). */
export type PlatformCredentialProbePort = {
  testConfluence(args: { baseUrl: string; token: string }): Promise<PlatformTestResult>;
  testQwen(args: { baseUrl: string; apiKey: string }): Promise<PlatformTestResult>;
};

/** Factory injected into the admin routes (mirrors GetPreflightValidator). Undefined at the composition
 *  root until the real probe adapters land → the platform-credentials PATCH/test routes 503. */
export type GetPlatformCredentialProbe = () => PlatformCredentialProbePort;

/** Resolves an actor user_id → email for the credential-rotation audit + meta.last_rotated_by. */
export type UserEmailResolverPort = {
  resolveEmail(userId: string): Promise<string>;
};

/** Default actor-email resolver — 1:1 with the Python bootstrap shim (`shim-user-<uuid>@codemaster.local`).
 *  The real PostgresUserEmailResolver (decrypt core.users.email_ciphertext via the ADR-0033 AAD codec) is a
 *  FOLLOW-UP; until then the handler defaults to this shim (matching the Python bootstrap fallback). */
export const shimUserEmailResolver: UserEmailResolverPort = {
  async resolveEmail(userId) {
    return `shim-user-${userId}@codemaster.local`;
  },
};
