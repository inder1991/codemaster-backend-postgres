import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { modelForPurpose } from "#backend/llm/model_router.js";

afterAll(() => shutdownRef());

// Parity of the TS purpose→model resolver against the frozen Python source-of-truth.
//
// PLAN-vs-CODE DRIFT (documented in the deliverable notes): the task brief describes a class-based
// `ModelRouter(policy_snapshot).route(purpose, prompt_chars, installation_id) -> RoutingDecisionV1`
// with a per-installation → per-purpose → per-size-threshold → default priority cascade. That
// mechanism was RETIRED in the frozen Python by ADR-0060 A (see the docstring of
// contracts/llm_routing/v1.py and tests/unit/contracts/test_llm_routing_v1.py): `ModelRouter`,
// `RoutingPolicyV1`, `RoutingDecisionV1`, `KNOWN_MODELS` and `SizeRule` no longer exist. Model
// selection moved to a purpose→model resolver — a MODULE-LEVEL PURE FUNCTION
// `model_for_purpose(purpose: str) -> str` in codemaster/integrations/llm/purpose_model.py. The
// 1:1 port therefore targets that live entry point. Because it returns a plain (JSON-safe, non-float)
// string and carries no constructor state, the GENERIC oracle (pyRef) is the correct harness — no
// dedicated driver is needed (the dedicated-driver path is only for class methods / bare floats).
//
// The DB-backed async variants (`PurposeModelCache` / `resolve_model_for_purpose`) require a live
// SQLAlchemy session and are out of scope per the no-database guardrail; the pure sync resolver IS
// the unconfigured / seed-only behavior those variants fall back to, so this proves the seed table
// and the default-fallback byte-for-byte.

const PY_MODULE = "codemaster.integrations.llm.purpose_model";
const PY_CALLABLE = "model_for_purpose";

async function assertResolverParity(purpose: string): Promise<void> {
  const r = await pyRef({ pyModule: PY_MODULE, pyCallable: PY_CALLABLE, kwargs: { purpose } });
  expect(r.ok, r.err).toBe(true);
  expect(canonicalize(modelForPurpose(purpose))).toBe(r.out);
}

describe("model_for_purpose parity (TS ↔ frozen Python purpose→model resolver)", () => {
  // Every seeded purpose maps to its pinned model (the seed == today's prior hardcodes).
  it("review_finding → sonnet (seed)", async () => {
    await assertResolverParity("review_finding");
  }, 30_000);

  it("walkthrough → opus (seed; the only opus pin)", async () => {
    await assertResolverParity("walkthrough");
  }, 30_000);

  it("analysis_curator → haiku (seed; the only haiku pin, dated id)", async () => {
    await assertResolverParity("analysis_curator");
  }, 30_000);

  it("fix_prompt → sonnet (seed)", async () => {
    await assertResolverParity("fix_prompt");
  }, 30_000);

  // Purposes that are valid LlmPurposeV1 members but ABSENT from the seed dict → DEFAULT_MODEL.
  // This exercises the dict-miss → default fallback for in-vocabulary purposes.
  it("review_summary → default sonnet (in enum, not in seed)", async () => {
    await assertResolverParity("review_summary");
  }, 30_000);

  it("chat_reply → default sonnet (in enum, not in seed)", async () => {
    await assertResolverParity("chat_reply");
  }, 30_000);

  it("redaction_check → default sonnet (in enum, not in seed)", async () => {
    await assertResolverParity("redaction_check");
  }, 30_000);

  it("cost_estimate → default sonnet (in enum, not in seed)", async () => {
    await assertResolverParity("cost_estimate");
  }, 30_000);

  // Unknown / out-of-vocabulary purpose → DEFAULT_MODEL (the resolver does NOT validate against the
  // enum; it is a permissive dict.get with a default — byte-significant: an unknown string must NOT
  // raise, it must fall through to sonnet).
  it("unknown purpose → default sonnet (permissive dict.get fallback)", async () => {
    await assertResolverParity("totally_unknown_purpose");
  }, 30_000);

  it("empty-string purpose → default sonnet (dict miss, not an error)", async () => {
    await assertResolverParity("");
  }, 30_000);
});
