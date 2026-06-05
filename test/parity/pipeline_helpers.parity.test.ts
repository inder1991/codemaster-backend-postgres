import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import { pyHelper, shutdownPipelineHelpersRef } from "./pipeline_helpers_oracle.js";
import {
  stageOutcomeForPublication,
  fixPromptStageOutcome,
  resolveDegradedPayload,
  configChangeNoticeFinding,
  pathFiltersExcludedAllFinding,
  inferPrTopologyKind,
  composeOrchestratorDegradationNote,
} from "#backend/review/pipeline/helpers.js";
import { PublicationOutcome } from "#contracts/posted_review.v1.js";

afterAll(() => {
  shutdownPipelineHelpersRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS pure pipeline helpers are byte-equal to their frozen Python originals
// (vendor/codemaster-py/codemaster/workflows/{review_pull_request,review_pipeline_orchestrator}.py),
// driven over the dedicated ref (tools/parity/run_pipeline_helpers_ref.py).
//
// Most helpers return a plain string / null / object that canonicalizes whole on both sides. The two
// finding helpers (configChangeNoticeFinding / pathFiltersExcludedAllFinding) return a ReviewFindingV1
// whose `confidence` is a BARE FLOAT (0.99); the canonicalizer REJECTS bare floats (Python repr vs JS
// Number.toString diverge), so we STRIP `confidence` before the canonical compare and assert it
// structurally + by range — the established review-findings gotcha.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Strip the bare-float `confidence` field so the rest of the finding canonicalizes; assert it's the
 *  expected 0.99 on BOTH sides (range + exact) outside the byte compare. */
function splitConfidence(finding: Record<string, unknown>): {
  rest: Record<string, unknown>;
  confidence: number;
} {
  const { confidence, ...rest } = finding;
  return { rest, confidence: confidence as number };
}

const TIMEOUT = 30_000;

describe("_stage_outcome_for_publication parity (Python ↔ TS)", () => {
  const cases: Array<{ wire: PublicationOutcome | null; label: string }> = [
    { wire: null, label: "null" },
    { wire: PublicationOutcome.enum.inline_posted, label: "inline_posted" },
    { wire: PublicationOutcome.enum.body_only_posted, label: "body_only_posted" },
    { wire: PublicationOutcome.enum.degraded_unposted, label: "degraded_unposted" },
  ];
  for (const c of cases) {
    it(
      `outcome=${c.label}`,
      async () => {
        const py = await pyHelper("stage_outcome_for_publication", { outcome: c.wire });
        const ts = stageOutcomeForPublication(c.wire);
        expect(canonicalize(ts)).toBe(canonicalize(py));
      },
      TIMEOUT,
    );
  }
});

describe("_fix_prompt_stage_outcome parity (Python ↔ TS)", () => {
  const cases: Array<{ generated: boolean; generationMode: string }> = [
    { generated: false, generationMode: "llm" },
    { generated: false, generationMode: "deterministic" },
    { generated: true, generationMode: "llm" },
    { generated: true, generationMode: "deterministic" },
    { generated: true, generationMode: "anything-else" },
  ];
  for (const c of cases) {
    it(
      `generated=${c.generated} mode=${c.generationMode}`,
      async () => {
        const py = await pyHelper("fix_prompt_stage_outcome", {
          generated: c.generated,
          generation_mode: c.generationMode,
        });
        const ts = fixPromptStageOutcome({ generated: c.generated, generationMode: c.generationMode });
        expect(canonicalize(ts)).toBe(canonicalize(py));
      },
      TIMEOUT,
    );
  }
});

describe("_resolve_degraded_payload parity (Python ↔ TS)", () => {
  const rfids = [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
  ];
  const outcomes: Array<PublicationOutcome | null> = [
    null,
    PublicationOutcome.enum.inline_posted,
    PublicationOutcome.enum.body_only_posted,
    PublicationOutcome.enum.degraded_unposted,
  ];
  for (const outcome of outcomes) {
    it(
      `outcome=${outcome ?? "null"}`,
      async () => {
        const py = (await pyHelper("resolve_degraded_payload", {
          outcome,
          kept_rfids: rfids,
        })) as { rfids: ReadonlyArray<string>; outcome_value: string | null };
        const ts = resolveDegradedPayload(outcome, rfids);
        // The Python returns {rfids, outcome_value}; the TS returns {rfidsToFlip, outcomeValue}. Compare
        // field-for-field (the Python wire shape uses snake_case; we map names explicitly).
        expect(canonicalize(ts.rfidsToFlip)).toBe(canonicalize(py.rfids));
        expect(canonicalize(ts.outcomeValue)).toBe(canonicalize(py.outcome_value));
      },
      TIMEOUT,
    );
  }
});

describe("_config_change_notice_finding parity (Python ↔ TS; confidence stripped)", () => {
  it(
    "byte-equal ReviewFindingV1 envelope (minus bare-float confidence)",
    async () => {
      const py = splitConfidence((await pyHelper("config_change_notice_finding")) as Record<string, unknown>);
      const ts = splitConfidence(configChangeNoticeFinding() as unknown as Record<string, unknown>);
      expect(canonicalize(ts.rest)).toBe(canonicalize(py.rest));
      // confidence: assert structurally + by range + exact value on both sides.
      expect(py.confidence).toBe(0.99);
      expect(ts.confidence).toBe(0.99);
      expect(ts.confidence).toBeGreaterThanOrEqual(0);
      expect(ts.confidence).toBeLessThanOrEqual(1);
    },
    TIMEOUT,
  );
});

describe("_path_filters_excluded_all_finding parity (Python ↔ TS; confidence stripped)", () => {
  it(
    "byte-equal ReviewFindingV1 envelope (minus bare-float confidence)",
    async () => {
      const py = splitConfidence(
        (await pyHelper("path_filters_excluded_all_finding")) as Record<string, unknown>,
      );
      const ts = splitConfidence(pathFiltersExcludedAllFinding() as unknown as Record<string, unknown>);
      expect(canonicalize(ts.rest)).toBe(canonicalize(py.rest));
      expect(py.confidence).toBe(0.99);
      expect(ts.confidence).toBe(0.99);
    },
    TIMEOUT,
  );
});

describe("_infer_pr_topology_kind parity (Python ↔ TS) — ORDER is load-bearing", () => {
  // The branch order (test → doc → config → code → other) means e.g. "TESTING.md" → "test" (startsWith
  // "test"), not "doc". This corpus exercises every branch + the order-sensitive overlaps.
  const paths = [
    "src/api/test_foo.py",
    "tests/x.py",
    "foo/test/bar.py",
    "TESTING.md", // startsWith "test" → test (NOT doc), despite .md
    "README.md",
    "docs/x.rst",
    "notes.txt",
    ".codemaster.yaml", // startsWith "." → config
    "config.toml",
    "app.json",
    "settings.ini",
    "x.cfg",
    "Dockerfile.dockerfile",
    "main.py",
    "x.ts",
    "x.tsx",
    "x.js",
    "x.jsx",
    "x.go",
    "x.rs",
    "x.java",
    "binary.bin",
    "random",
    "UPPER/Test_Case.PY", // upper-case → lowercased before matching
  ];
  for (const path of paths) {
    it(
      `path=${path}`,
      async () => {
        const py = await pyHelper("infer_pr_topology_kind", { path });
        const ts = inferPrTopologyKind(path);
        expect(canonicalize(ts)).toBe(canonicalize(py));
      },
      TIMEOUT,
    );
  }
});

describe("_compose_orchestrator_degradation_note parity (Python ↔ TS)", () => {
  const cases: Array<{ notes: ReadonlyArray<string>; priorNote: string | null; label: string }> = [
    { notes: [], priorNote: null, label: "empty notes, null prior" },
    { notes: [], priorNote: "earlier", label: "empty notes, prior kept unchanged" },
    { notes: ["a", "b", "a", " ", "b"], priorNote: null, label: "dedup + strip-empty, null prior" },
    { notes: [" x "], priorNote: "earlier", label: "strip + chain onto prior" },
    {
      notes: ["persist_findings_failed", "apply_arbitration_failed"],
      priorNote: null,
      label: "two real markers",
    },
    { notes: ["  ", "\t", ""], priorNote: "only-prior", label: "all-whitespace notes → prior unchanged" },
    { notes: ["solo"], priorNote: "", label: "empty-string prior is treated as falsey (no chain)" },
  ];
  for (const c of cases) {
    it(
      c.label,
      async () => {
        const py = await pyHelper("compose_orchestrator_degradation_note", {
          notes: c.notes,
          prior_note: c.priorNote,
        });
        const ts = composeOrchestratorDegradationNote({ notes: c.notes, priorNote: c.priorNote });
        expect(canonicalize(ts)).toBe(canonicalize(py));
      },
      TIMEOUT,
    );
  }
});
