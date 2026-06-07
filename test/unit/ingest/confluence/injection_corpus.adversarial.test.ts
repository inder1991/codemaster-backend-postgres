// Confluence injection-pattern adversarial corpus harness — 1:1 port of the frozen Python
// vendor/codemaster-py/tests/adversarial/test_confluence_injection_corpus.py.
//
// Walks `test/corpora/confluence_injection/<pattern_class>/` for every known pattern class, loads
// each YAML fixture, runs the production detectInjectionFlags(body), and asserts:
//   1. Per-fixture: the expected pattern class is in the detected set.
//   2. Per-class: detection rate >= 95% (spec §6) over >= 5 fixtures.
//   3. Structural: every PATTERN_CLASSES entry has its own sub-corpus dir; no extra dirs; >= 30 total.
//
// The corpus YAML was copied byte-for-byte from the frozen Python corpus (unicode-bearing inputs —
// zero-width chars, bidi overrides, soft hyphens — preserved exactly).

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  PATTERN_CLASSES,
  detectInjectionFlags,
} from "#backend/ingest/confluence/injection_patterns.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// test/unit/ingest/confluence -> test/corpora/confluence_injection
const CORPUS_DIR = path.resolve(HERE, "..", "..", "..", "corpora", "confluence_injection");

const DETECTION_THRESHOLD = 0.95;
const MIN_FIXTURES_PER_CLASS = 5;

type Fixture = {
  id: string;
  patternClass: string;
  inputText: string;
  expectedClass: string;
  expectedDetected: boolean;
  yamlPath: string;
};

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function loadClassFixtures(patternClass: string): ReadonlyArray<Fixture> {
  const classDir = path.join(CORPUS_DIR, patternClass);
  if (!isDir(classDir)) return [];
  const out: Array<Fixture> = [];
  const files = readdirSync(classDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  for (const file of files) {
    const yamlPath = path.join(classDir, file);
    const data = yaml.load(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
    out.push({
      id: String(data["id"]),
      patternClass: String(data["pattern_class"]),
      inputText: String(data["input"]),
      expectedClass: String(data["expected_class"]),
      expectedDetected: Boolean(data["expected_detected"]),
      yamlPath,
    });
  }
  return out;
}

function loadAllFixtures(): ReadonlyArray<Fixture> {
  const out: Array<Fixture> = [];
  for (const cls of [...PATTERN_CLASSES].sort()) {
    out.push(...loadClassFixtures(cls));
  }
  return out;
}

const ALL_FIXTURES = loadAllFixtures();

describe("confluence injection adversarial corpus", () => {
  it.each(ALL_FIXTURES.map((f) => [f.id, f] as const))(
    "fixture %s: expected pattern class is detected",
    (_id, fixture) => {
      const detected = detectInjectionFlags(fixture.inputText);
      expect(
        detected.has(fixture.patternClass),
        `Fixture ${fixture.id} (${fixture.yamlPath}) was NOT detected. ` +
          `Expected pattern_class ${JSON.stringify(fixture.patternClass)} in detected, ` +
          `got detected=${JSON.stringify([...detected].sort())}. ` +
          `input head: ${JSON.stringify(fixture.inputText.slice(0, 120))}`,
      ).toBe(true);
    },
  );

  it.each([...PATTERN_CLASSES].sort())(
    "per-class detection rate >= 95%% for %s",
    (patternClass) => {
      const fixtures = loadClassFixtures(patternClass);
      expect(
        fixtures.length,
        `Pattern class ${patternClass} has only ${fixtures.length} fixtures; ` +
          `corpus contract requires >= ${MIN_FIXTURES_PER_CLASS}.`,
      ).toBeGreaterThanOrEqual(MIN_FIXTURES_PER_CLASS);

      const nDetected = fixtures.filter((f) =>
        detectInjectionFlags(f.inputText).has(f.patternClass),
      ).length;
      const rate = nDetected / fixtures.length;
      expect(
        rate,
        `Pattern class ${patternClass} detection rate ${(rate * 100).toFixed(2)}% < ` +
          `${DETECTION_THRESHOLD * 100}% threshold (${nDetected}/${fixtures.length} matched).`,
      ).toBeGreaterThanOrEqual(DETECTION_THRESHOLD);
    },
  );

  it("every pattern class has a corpus dir", () => {
    const missing = [...PATTERN_CLASSES]
      .filter((cls) => !isDir(path.join(CORPUS_DIR, cls)))
      .sort();
    expect(missing, `Pattern classes missing corpus directories: ${JSON.stringify(missing)}`).toEqual(
      [],
    );
  });

  it("no extra corpus dirs", () => {
    const foundDirs = readdirSync(CORPUS_DIR).filter((p) => isDir(path.join(CORPUS_DIR, p)));
    const known = new Set(PATTERN_CLASSES);
    const extra = foundDirs.filter((d) => !known.has(d)).sort();
    expect(extra, `Corpus directories without a matching PATTERN_CLASSES entry: ${JSON.stringify(extra)}`).toEqual(
      [],
    );
  });

  it("fixture count meets minimum (6 classes x 5 = >= 30)", () => {
    const totalExpected = PATTERN_CLASSES.length * MIN_FIXTURES_PER_CLASS;
    expect(ALL_FIXTURES.length).toBeGreaterThanOrEqual(totalExpected);
  });
});
