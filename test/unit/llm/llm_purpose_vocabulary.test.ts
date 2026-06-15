// Vocabulary + executable-subset invariants — TEST 1.
//
// Guards three cross-module invariants that, if they drift, silently introduce bugs:
//
//   1. LLM_PURPOSE_LITERALS (the contract vocabulary) == the 8 values in the
//      core.llm_purpose_model CHECK constraint (`ck_llm_purpose_model_purpose_valid`,
//      migrations/0001_baseline.sql line 1709). A drift in EITHER direction causes the
//      admin GET to throw a 500 when it parses a DB-valid purpose that the Zod enum no
//      longer accepts.
//
//   2. EXECUTABLE_LLM_PURPOSES == keys of PURPOSE_MODEL_SEED. The contract comment claims
//      "the purposes the runtime resolver actually consumes" — this test pins that claim
//      so a future edit that adds a purpose to one but not the other fails CI.
//
//   3. EXECUTABLE_LLM_PURPOSES ⊆ LLM_PURPOSE_LITERALS. A non-vocabulary value in the
//      executable set would be un-assignable in the DB (the CHECK constraint would reject
//      it) and the resolver would fall through to DEFAULT_MODEL — a silent no-op.

import { describe, expect, it } from "vitest";

import { LLM_PURPOSE_LITERALS } from "#contracts/llm_routing.v1.js";
import { EXECUTABLE_LLM_PURPOSES } from "#contracts/admin.v1.js";
import { PURPOSE_MODEL_SEED } from "#backend/llm/model_router.js";

// The 8 values in the CHECK constraint at migrations/0001_baseline.sql line 1709:
//   CONSTRAINT ck_llm_purpose_model_purpose_valid CHECK ((purpose = ANY (ARRAY[
//     'review_summary'::text, 'review_finding'::text, 'chat_reply'::text,
//     'walkthrough'::text, 'redaction_check'::text, 'cost_estimate'::text,
//     'analysis_curator'::text, 'fix_prompt'::text
//   ])))
const DB_CHECK_PURPOSES = new Set([
  "review_summary",
  "review_finding",
  "chat_reply",
  "walkthrough",
  "redaction_check",
  "cost_estimate",
  "analysis_curator",
  "fix_prompt",
]);

describe("LLM purpose vocabulary invariants", () => {
  it("LLM_PURPOSE_LITERALS equals the 8-value DB CHECK constraint (ck_llm_purpose_model_purpose_valid)", () => {
    // Both directions: no missing value in the contract, and no extra value not in the DB.
    const contractSet = new Set<string>(LLM_PURPOSE_LITERALS);
    expect(contractSet).toEqual(DB_CHECK_PURPOSES);
  });

  it("EXECUTABLE_LLM_PURPOSES equals the keys of PURPOSE_MODEL_SEED (executable ⟺ seeded)", () => {
    const executableSet = new Set<string>(EXECUTABLE_LLM_PURPOSES);
    const seedKeys = new Set<string>(PURPOSE_MODEL_SEED.keys());
    expect(executableSet).toEqual(seedKeys);
  });

  it("EXECUTABLE_LLM_PURPOSES is a subset of LLM_PURPOSE_LITERALS", () => {
    const vocabularySet = new Set<string>(LLM_PURPOSE_LITERALS);
    for (const purpose of EXECUTABLE_LLM_PURPOSES) {
      expect(vocabularySet.has(purpose), `EXECUTABLE purpose '${purpose}' is not in LLM_PURPOSE_LITERALS`).toBe(true);
    }
  });
});
