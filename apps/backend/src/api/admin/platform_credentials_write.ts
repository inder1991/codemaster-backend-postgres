// Platform-credentials orchestration — 1:1 port of platform_credentials.py (_get_credential /
// _patch_credential / _test_credential). Secrets live in Vault KV; the meta table holds rotation/validation
// metadata. PATCH is probe-first-then-write: a failing probe aborts the rotation (422) unless ?force=true.
// The handlers throw PlatformCredentialError for the {error,msg} 422 cases; the route maps + serializes.

import { type Kysely } from "kysely";

import { type Clock } from "#platform/clock.js";

import { type VaultPort, VaultPathNotFound } from "#backend/adapters/vault_port.js";
import {
  bumpEmbedderConfigVersion,
  type PostgresPlatformCredentialsMetaRepo,
} from "#backend/api/admin/platform_credentials_repo.js";
import {
  type PlatformCredentialProbePort,
  type PlatformTestResult,
  type UserEmailResolverPort,
} from "#backend/api/admin/platform_credentials_probe.js";
import { PLATFORM_SCOPE_AUDIT_INSTALLATION_ID } from "#backend/infra/sentinels.js";
import {
  DnsResolutionError,
  HttpsRequiredError,
  MalformedUrlError,
  PrivateCidrError,
  UrlValidationError,
  UserInfoNotAllowedError,
  validateExternalUrl,
  type DnsResolver,
} from "#backend/security/url_validator.js";

import type {
  PatchPlatformCredentialsRequestV1,
  PlatformCredentialsMetaV1,
  TestPlatformCredentialsResponseV1,
} from "#contracts/admin.v1.js";

export type PlatformCredentialKey = "confluence" | "embedder.qwen";

const CORPUS_DIMENSION = 1024; // v4 §4.4 Qwen invariant

/** A 422 the route serializes as `{ error: errorCode, msg }`. 1:1 with the Python HTTPException(422, {error,msg}). */
export class PlatformCredentialError extends Error {
  public constructor(
    public readonly errorCode: string,
    public readonly msg: string,
  ) {
    super(msg);
  }
}

/** Post-action audit-emit seam (installationId is `string | null`; structurally compatible with opts.audit). */
export type PlatformAuditEmitter = (e: {
  actorUserId: string;
  installationId: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  now: Date;
}) => Promise<void>;

export type PlatformCredentialsDeps = {
  db: Kysely<unknown>;
  vault: VaultPort;
  probe: PlatformCredentialProbePort;
  metaRepo: PostgresPlatformCredentialsMetaRepo;
  userEmailResolver: UserEmailResolverPort;
  clock: Clock;
  audit?: PlatformAuditEmitter | undefined;
  dnsResolver?: DnsResolver | undefined;
};

// ───────────── credential-key maps (switch form — no dynamic object indexing) ─────────────

const vaultPath = (ck: PlatformCredentialKey): string =>
  ck === "confluence" ? "codemaster/confluence/token" : "codemaster/embedder/qwen";

const auditAction = (ck: PlatformCredentialKey): string =>
  ck === "confluence" ? "platform_credentials.rotated.confluence" : "platform_credentials.rotated.embedder_qwen";

/** The token field name inside the Vault payload: confluence→token, embedder.qwen→api_key. */
const readToken = (payload: Record<string, string>, ck: PlatformCredentialKey): string | undefined =>
  ck === "confluence" ? payload.token : payload.api_key;

async function readVaultPayload(vault: VaultPort, path: string): Promise<Record<string, string> | null> {
  try {
    return await vault.kvRead({ path });
  } catch (err) {
    if (err instanceof VaultPathNotFound) {
      return null;
    }
    throw err; // VaultConnectivityError etc. → uncaught → 500 (faithful)
  }
}

async function runProbe(
  probe: PlatformCredentialProbePort,
  ck: PlatformCredentialKey,
  baseUrl: string,
  token: string,
): Promise<PlatformTestResult> {
  return ck === "confluence" ? probe.testConfluence({ baseUrl, token }) : probe.testQwen({ baseUrl, apiKey: token });
}

async function validateUrlOr422(baseUrl: string, dnsResolver: DnsResolver | undefined): Promise<void> {
  try {
    await validateExternalUrl(baseUrl, { allowHttp: false, ...(dnsResolver ? { resolver: dnsResolver } : {}) });
  } catch (err) {
    if (err instanceof HttpsRequiredError) {
      throw new PlatformCredentialError("https_required", err.message);
    }
    if (err instanceof PrivateCidrError) {
      throw new PlatformCredentialError("ssrf_blocked", err.message);
    }
    if (err instanceof UserInfoNotAllowedError) {
      throw new PlatformCredentialError("userinfo_not_allowed", err.message);
    }
    if (err instanceof DnsResolutionError) {
      throw new PlatformCredentialError("dns_resolution_failed", err.message);
    }
    if (err instanceof MalformedUrlError) {
      throw new PlatformCredentialError("malformed_url", err.message);
    }
    if (err instanceof UrlValidationError) {
      throw new PlatformCredentialError("validation_failed", err.message);
    }
    throw err;
  }
}

function toMetaV1(
  ck: PlatformCredentialKey,
  baseUrl: string | null,
  tokenPresent: boolean,
  metaRow: Awaited<ReturnType<PostgresPlatformCredentialsMetaRepo["get"]>>,
): PlatformCredentialsMetaV1 {
  return {
    schema_version: 1,
    credential_key: ck,
    base_url: baseUrl,
    token_present: tokenPresent,
    last_rotated_at: metaRow === null ? null : metaRow.lastRotatedAt.toISOString(),
    last_rotated_by: metaRow === null ? null : metaRow.lastRotatedBy,
    last_validated_at: metaRow?.lastValidatedAt == null ? null : metaRow.lastValidatedAt.toISOString(),
    last_validation_error: metaRow === null ? null : metaRow.lastValidationError,
  };
}

// ───────────── handlers ─────────────

/** GET — surface base_url + token_present (NEVER the secret) + the meta row. */
export async function getCredential(
  deps: Pick<PlatformCredentialsDeps, "vault" | "metaRepo">,
  ck: PlatformCredentialKey,
): Promise<PlatformCredentialsMetaV1> {
  const payload = await readVaultPayload(deps.vault, vaultPath(ck));
  const baseUrl = payload !== null && typeof payload.base_url === "string" ? payload.base_url : null;
  const tokenPresent = payload !== null && Boolean(readToken(payload, ck));
  const metaRow = await deps.metaRepo.get(ck);
  return toMetaV1(ck, baseUrl, tokenPresent, metaRow);
}

/** PATCH — probe-first-then-write rotation with ?force override. Throws PlatformCredentialError (→ 422) for
 *  empty/SSRF/incomplete/probe-fail-no-force; resolver throw bubbles → 500 (no state change). */
export async function patchCredential(
  deps: PlatformCredentialsDeps,
  ck: PlatformCredentialKey,
  body: PatchPlatformCredentialsRequestV1,
  actorUserId: string,
  force: boolean,
): Promise<PlatformCredentialsMetaV1> {
  if (body.base_url === null && body.token === null) {
    throw new PlatformCredentialError("empty_patch", "at least one of base_url / token must be supplied");
  }
  if (body.base_url !== null) {
    await validateUrlOr422(body.base_url, deps.dnsResolver);
  }
  // Resolve actor email BEFORE the probe (fail-closed — a resolver throw aborts with no state change).
  const actorEmail = await deps.userEmailResolver.resolveEmail(actorUserId);

  const current = await readVaultPayload(deps.vault, vaultPath(ck));
  const currentBaseUrl = current !== null && typeof current.base_url === "string" ? current.base_url : null;
  const currentToken = current === null ? null : (readToken(current, ck) ?? null);
  const newBaseUrl = body.base_url ?? currentBaseUrl;
  const newToken = body.token ?? currentToken;
  if (!newBaseUrl || !newToken) {
    throw new PlatformCredentialError(
      "incomplete_credential",
      "both base_url and token required (either in body or previously in Vault)",
    );
  }

  // PROBE FIRST — no write yet.
  const probeRes = await runProbe(deps.probe, ck, newBaseUrl, newToken);
  if (!probeRes.ok && !force) {
    throw new PlatformCredentialError(
      probeRes.errorCode ?? "validation_failed",
      `${probeRes.errorDetail ?? "probe failed"} (rotate aborted; use ?force=true to write Vault anyway)`,
    );
  }
  // (!probeRes.ok && force) → operator override: fall through to the write.

  const data: Record<string, string> =
    ck === "confluence" ? { base_url: newBaseUrl, token: newToken } : { base_url: newBaseUrl, api_key: newToken };
  await deps.vault.kvWrite({ path: vaultPath(ck), data });
  await deps.metaRepo.upsertRotation({ credentialKey: ck, lastRotatedBy: actorEmail });

  await deps.audit?.({
    actorUserId,
    installationId: PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
    action: auditAction(ck),
    targetKind: "platform_credential",
    targetId: ck,
    before: null,
    after: {
      credential_key: ck,
      base_url_changed: body.base_url !== null,
      token_changed: body.token !== null,
      probe_ok: probeRes.ok,
      forced: force && !probeRes.ok,
    },
    now: deps.clock.now(),
  });

  // Qwen-only: bump the worker config_version so embedder pods refresh the credential cache within the SLA.
  if (ck === "embedder.qwen") {
    await bumpEmbedderConfigVersion(deps.db, actorEmail);
  }
  await deps.metaRepo.updateValidation({
    credentialKey: ck,
    lastValidatedAt: deps.clock.now(),
    lastValidationError: probeRes.ok ? null : probeRes.errorCode,
  });

  const metaRow = await deps.metaRepo.get(ck);
  return toMetaV1(ck, newBaseUrl, true, metaRow);
}

/** POST /test — probe the EXISTING Vault credential. 200 even on probe failure (ok:false in the body).
 *  Throws PlatformCredentialError("no_credential") → 422 when nothing is stored. */
export async function testCredential(
  deps: Pick<PlatformCredentialsDeps, "vault" | "probe" | "metaRepo" | "clock">,
  ck: PlatformCredentialKey,
): Promise<TestPlatformCredentialsResponseV1> {
  const current = await readVaultPayload(deps.vault, vaultPath(ck));
  if (current === null) {
    throw new PlatformCredentialError("no_credential", "no credential in Vault");
  }
  const rawBaseUrl = current.base_url;
  const rawToken = readToken(current, ck);
  if (typeof rawBaseUrl !== "string" || typeof rawToken !== "string") {
    throw new PlatformCredentialError(
      "no_credential",
      `Vault payload at ${vaultPath(ck)} missing required fields ('base_url', '${ck === "confluence" ? "token" : "api_key"}')`,
    );
  }
  const probeRes = await runProbe(deps.probe, ck, rawBaseUrl, rawToken);
  await deps.metaRepo.updateValidation({
    credentialKey: ck,
    lastValidatedAt: deps.clock.now(),
    lastValidationError: probeRes.ok ? null : probeRes.errorCode,
  });
  return {
    schema_version: 1,
    ok: probeRes.ok,
    error: probeRes.errorCode,
    error_detail: probeRes.errorDetail,
    latency_ms: probeRes.latencyMs,
    detected_dimension: probeRes.detectedDimension,
    corpus_dimension: ck === "embedder.qwen" ? CORPUS_DIMENSION : null,
  };
}
