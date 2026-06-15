// PUT /api/admin/llm-models — the concurrent-add race fallback. model_id is GLOBALLY unique
// (uq_llm_models_model_id). The handler pre-checks for a cross-provider clash (clean 409 with a message),
// but two concurrent adds can both pass that pre-check; the unique index is the source of truth, so the
// handler ALSO catches SQLSTATE 23505 from the INSERT and re-reads the race-winner's provider for the body.
// The integration test covers the pre-check path; this unit test forces the 23505 path (unreachable
// sequentially — the pre-check would catch a real cross-provider collision first) via a recording fake DB.

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { recordingKysely } from "./_recording_kysely.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

function superAdminCookie(): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role: "super_admin",
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: null,
  });
}

async function makeAdminApp(dbResults: ReadonlyArray<ReadonlyArray<unknown> | Error>) {
  const { db } = recordingKysely(dbResults);
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describe("PUT /api/admin/llm-models — concurrent-add 23505 fallback", () => {
  it("a unique-index race (pre-check passes, INSERT violates uq_llm_models_model_id) → 409 llm_model_id_taken", async () => {
    const dup = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    // The race winner: the same model_id ended up registered under a DIFFERENT provider.
    const winnerRow = {
      provider: "bedrock",
      model_id: "itest-race",
      display_name: null,
      enabled: true,
      last_validation_status: "untested",
      last_validation_error: null,
      last_validated_at: null,
    };
    // Query order in the PUT handler: (1) listLlmModels pre-check → no clash ([]); (2) upsertModel INSERT
    // → throws 23505; (3) listLlmModels winner re-read → the row now under bedrock.
    const app = await makeAdminApp([[], dup, [winnerRow]]);
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/llm-models",
      cookies: { [SESSION_COOKIE_NAME]: superAdminCookie() },
      payload: { provider: "anthropic_direct", model_id: "itest-race", enabled: true },
    });
    expect(res.statusCode).toBe(409);
    const detail = res.json<{ detail: { code: string; provider: string } }>().detail;
    expect(detail.code).toBe("llm_model_id_taken");
    expect(detail.provider).toBe("bedrock");
    await app.close();
  });
});
