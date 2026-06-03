import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { load as yamlLoad } from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

import { pyDetectSecrets, shutdownRedactRef, type Finding } from "./redact_oracle.js";
import { detectSecrets } from "#backend/redact/secret_detector.js";

afterAll(() => shutdownRedactRef());

// Adversarial-corpus parity for the secret detector: prove the TS `detectSecrets` port is byte-equal
// to the frozen Python `PatternSecretDetector.detect` over the WHOLE secrets corpus, AND that it
// clears the named CI recall floor (≥ 0.99 over in-scope positives) with zero false positives on the
// negative controls.
//
// The recall denominator mirrors the frozen Python gate exactly
// (vendor/codemaster-py/tests/adversarial/test_corpus_runner.py::test_secret_detection_corpus_recall):
// the detector implements six kinds; corpus positives targeting OTHER kinds (PEM, JWT, SSH, …) stay
// in the corpus for future work but are excluded from the recall denominator and from the per-entry
// positive gate. The PARITY assertion below is stronger than recall — it diffs every finding's
// (kind, start_offset, end_offset, snippet_redacted) against the live Python driver for EVERY corpus
// entry, in-scope or not, so even the out-of-scope positives and the negatives are proven equal.

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
const REPO_ROOT = join(HERE, "..", "..");
const SECRETS_DIR = join(
  REPO_ROOT,
  "vendor",
  "codemaster-py",
  "tests",
  "corpora",
  "secrets",
);

// Mirrors SECRET_SPRINT_7_KINDS in the frozen Python corpus runner — the kinds the detector
// implements. The recall denominator is positives whose expected_category is one of these.
const SECRET_DETECTOR_KINDS: ReadonlySet<string> = new Set([
  "aws_access_key_id",
  "github_pat",
  "github_app_token",
  "vault_token",
  "aws_secret_access_key",
  "generic_high_entropy",
]);

const RECALL_THRESHOLD = 0.99;

type CorpusEntry = {
  readonly id: string;
  readonly category: string;
  readonly input: string;
  readonly expected_detected: boolean;
  readonly expected_category: string;
};

function loadCorpus(): Array<CorpusEntry> {
  // Read the corpus from the submodule (NOT vendored): the YAML `input:` block scalars de-indent to
  // the exact string the frozen `.detect()` consumes, so offsets line up 1:1. Sorted by filename so
  // ids are deterministic; `_README.md`-style underscore files are skipped (matches the Python
  // runner's `_load_corpus`).
  const files = readdirSync(SECRETS_DIR)
    .filter((n) => n.endsWith(".yaml") && !n.startsWith("_"))
    .sort();
  return files.map((name) => yamlLoad(readFileSync(join(SECRETS_DIR, name), "utf8")) as CorpusEntry);
}

/** Stable key for sorting + diffing findings: the four byte-precise fields (confidence excluded). */
function findingKey(f: { kind: string; start_offset: number; end_offset: number; snippet_redacted?: string }): string {
  return `${f.start_offset}:${f.end_offset}:${f.kind}:${f.snippet_redacted ?? ""}`;
}

function sortedKeys(
  findings: ReadonlyArray<{ kind: string; start_offset: number; end_offset: number; snippet_redacted?: string }>,
): Array<string> {
  return findings.map(findingKey).sort();
}

const CORPUS = loadCorpus();

describe("detectSecrets parity (TS ↔ frozen Python PatternSecretDetector) over the secrets corpus", () => {
  it("corpus is non-empty and well-formed", () => {
    expect(CORPUS.length).toBeGreaterThan(0);
    for (const e of CORPUS) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.input).toBe("string");
      expect(typeof e.expected_detected).toBe("boolean");
    }
  });

  it("RECALL GATE: ≥ 0.99 over in-scope positives (matches frozen Python denominator)", () => {
    const inScopePositives = CORPUS.filter(
      (e) => e.expected_detected === true && SECRET_DETECTOR_KINDS.has(e.expected_category),
    );
    // Frozen Python asserts ≥ 60 in-scope positives; mirror the floor so a shrunk corpus is caught.
    expect(inScopePositives.length).toBeGreaterThanOrEqual(60);

    let hits = 0;
    const misses: Array<string> = [];
    for (const e of inScopePositives) {
      if (detectSecrets(e.input).length > 0) {
        hits += 1;
      } else {
        misses.push(e.id);
      }
    }
    const recall = hits / inScopePositives.length;
    expect(recall, `missed in-scope positives: ${misses.join(", ")}`).toBeGreaterThanOrEqual(
      RECALL_THRESHOLD,
    );
  });

  it("NEGATIVE CONTROLS: zero false positives, and agrees with Python on negatives", async () => {
    const negatives = CORPUS.filter((e) => e.expected_detected === false);
    expect(negatives.length).toBeGreaterThan(0);
    const falsePositives: Array<string> = [];
    for (const e of negatives) {
      const ours = detectSecrets(e.input);
      if (ours.length > 0) {
        falsePositives.push(`${e.id}:[${ours.map((f) => f.kind).join(",")}]`);
      }
      // Parity: TS and Python must agree byte-for-byte even on negatives.
      const py = await pyDetectSecrets(e.input);
      expect(sortedKeys(ours), `negative ${e.id}`).toEqual(sortedKeys(py));
    }
    expect(falsePositives, `false positives on negatives: ${falsePositives.join(", ")}`).toEqual([]);
  }, 60_000);

  it("PARITY: every corpus entry's findings match Python on (kind, start, end, snippet)", async () => {
    let passed = 0;
    const failures: Array<string> = [];
    for (const e of CORPUS) {
      const ours = detectSecrets(e.input);
      const py: Array<Finding> = await pyDetectSecrets(e.input);
      const oursKeys = sortedKeys(ours);
      const pyKeys = sortedKeys(py);
      try {
        expect(oursKeys).toEqual(pyKeys);
        // Confidence is a bare float on the wire — compare per matched finding within tolerance, and
        // independently assert each is in [0, 1]. Sort both sides by the same key so index lines up.
        const oursByKey = [...ours].sort((a, b) => (findingKey(a) < findingKey(b) ? -1 : 1));
        const pyByKey = [...py].sort((a, b) => (findingKey(a) < findingKey(b) ? -1 : 1));
        for (let i = 0; i < oursByKey.length; i++) {
          const oc = oursByKey[i]!.confidence;
          const pc = pyByKey[i]!.confidence;
          expect(oc).toBeGreaterThanOrEqual(0);
          expect(oc).toBeLessThanOrEqual(1);
          expect(Math.abs(oc - pc)).toBeLessThan(1e-9);
        }
        passed += 1;
      } catch (err) {
        failures.push(`${e.id}: ours=${JSON.stringify(oursKeys)} py=${JSON.stringify(pyKeys)} (${String(err)})`);
      }
    }
    expect(failures, `${passed}/${CORPUS.length} entries matched; failures:\n${failures.join("\n")}`).toEqual([]);
    expect(passed).toBe(CORPUS.length);
  }, 120_000);
});
