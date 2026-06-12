import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { costJournalShadowEnabled, PostgresCostJournal } from "#backend/cost/cost_journal.js";
import { sharedClientCollaborators } from "#backend/integrations/llm/client_cache.js";

// de-Temporal Phase 0 checklist #4 — the feature seam's DEFAULT-OFF posture. The journal shadow
// writes are wired into the shared client collaborators ONLY when CODEMASTER_COST_JOURNAL_SHADOW
// is EXACTLY "1" (strict: truthy-looking strings like "true"/"yes" stay OFF — an operator must set
// the documented value, and a typo can never silently turn on double-writes). Unset/anything-else
// → `costJournal` is undefined → the LlmClient seam is invisible and production behavior is
// byte-identical until the deliberate cutover-prep flip.
//
// `sharedClientCollaborators` is memoized per DSN, so each case uses a fresh unique DSN; the
// Postgres-backed collaborators are pool-lazy (no connection until first query), so this stays a
// unit test.

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A unique never-connected DSN so the per-DSN memo can't leak state across cases. */
function uniqueDsn(): string {
  return `postgresql://unit:unit@localhost:5/unit_${randomUUID().replace(/-/g, "")}`;
}

describe("costJournalShadowEnabled — the strict env predicate", () => {
  it("is OFF when unset", () => {
    expect(costJournalShadowEnabled({})).toBe(false);
  });

  it('is OFF for every value except exactly "1" (no truthy-string surprises)', () => {
    for (const value of ["0", "", "true", "yes", "on", " 1"]) {
      expect(costJournalShadowEnabled({ CODEMASTER_COST_JOURNAL_SHADOW: value })).toBe(false);
    }
  });

  it('is ON for exactly "1"', () => {
    expect(costJournalShadowEnabled({ CODEMASTER_COST_JOURNAL_SHADOW: "1" })).toBe(true);
  });
});

describe("sharedClientCollaborators — costJournal wiring follows the flag", () => {
  it("builds NO costJournal by default (production behavior unchanged)", () => {
    const collaborators = sharedClientCollaborators(uniqueDsn());
    expect(collaborators.costJournal).toBeUndefined();
  });

  it('builds the PostgresCostJournal when CODEMASTER_COST_JOURNAL_SHADOW="1" (read at build time, not import time)', () => {
    vi.stubEnv("CODEMASTER_COST_JOURNAL_SHADOW", "1");
    const collaborators = sharedClientCollaborators(uniqueDsn());
    expect(collaborators.costJournal).toBeInstanceOf(PostgresCostJournal);
  });
});
