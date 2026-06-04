// Magika LABEL-AGREEMENT acceptance test (TOLERATED-DIVERGENCE axis — ADR-0065).
//
// The TS file classifier wraps npm magika 1.0.0; the frozen Python source wraps Python magika 1.0.2.
// These are two independent ML models that may emit different labels for the same bytes, so the
// acceptance contract is NOT byte-parity — it is a LABEL-AGREEMENT RATE of >=95% across a curated,
// representative corpus. magika_label affects ROUTING only (never chunk_id / evidence_id identity),
// and divergent/unknown labels fall through to the safe {review} default, so the blast radius of any
// single-file disagreement is contained.
//
// Model-availability contract: BOTH the npm model (bundled ONNX/TF backend must initialize in this
// Node runtime) AND the frozen Python ref (magika 1.0.2 must load under vendor/codemaster-py/.venv)
// can be environment-gated (network / runtime incompatibility). The suite probes both up front and
// SKIPS cleanly when either is unavailable, so `validate-fast` never hard-fails on a model that can't
// load. When both load, the agreement assertion is live.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { pyLabelPath, shutdownMagikaRef } from "./magika_oracle.js";
import { MagikaFileClassifier } from "#backend/files/magika_classifier.js";

const AGREEMENT_THRESHOLD = 0.95;

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "magika_corpus");

/** All corpus files (sorted for deterministic ordering under pytest-randomly-style shuffling). */
function corpusFiles(): Array<{ name: string; path: string }> {
  return readdirSync(CORPUS_DIR)
    .filter((n) => !n.startsWith("."))
    .sort()
    .map((name) => ({ name, path: join(CORPUS_DIR, name) }));
}

/** Probe npm magika: can the model load AND classify a trivial buffer in this runtime? Returns the
 *  loaded classifier on success, or null if the bundled backend can't initialize here. */
async function probeNpmMagika(): Promise<MagikaFileClassifier | null> {
  try {
    const clf = new MagikaFileClassifier();
    const r = await clf.classify({ path: "probe.py", body: new TextEncoder().encode("x = 1\n") });
    return r.magika_label.length > 0 ? clf : null;
  } catch {
    return null;
  }
}

/** Probe the frozen Python magika ref: can it return a label for a trivial buffer? */
async function probePythonMagika(): Promise<boolean> {
  // Use a real corpus file so the path op is exercised exactly as the suite will use it.
  const files = corpusFiles();
  if (files.length === 0) return false;
  const r = await pyLabelPath(files[0]!.path);
  return r.ok;
}

// OPT-IN: this heavyweight cross-impl ML check loads an ONNX model and classifies the whole corpus
// (~150s on the pure-JS tfjs backend), so it runs ONLY when CODEMASTER_TEST_MAGIKA=1 — keeping the
// default `npm run test` / validate-fast fast. Run it ad-hoc / in a dedicated CI job:
//   CODEMASTER_TEST_MAGIKA=1 npx vitest run test/parity/magika_agreement.parity.test.ts
// Within that, availability is probed ONCE (single clear skip reason if a model can't initialize).
const enabled = process.env["CODEMASTER_TEST_MAGIKA"] === "1";
const npmClassifier = enabled ? await probeNpmMagika() : null;
const pythonAvailable = enabled && npmClassifier !== null ? await probePythonMagika() : false;
const bothAvailable = npmClassifier !== null && pythonAvailable;

const skipReason = !enabled
  ? "set CODEMASTER_TEST_MAGIKA=1 to run the magika cross-impl agreement check (~150s; loads an ONNX model)"
  : npmClassifier === null
    ? "npm magika model unavailable (bundled ONNX/TF backend could not initialize in this runtime)"
    : !pythonAvailable
      ? "frozen Python magika (vendor/codemaster-py/.venv) unavailable"
      : "";

afterAll(() => shutdownMagikaRef());

describe("magika label-agreement (npm 1.0.0 ↔ frozen Python 1.0.2) — ADR-0065", () => {
  if (!bothAvailable) {
    // One visible skipped placeholder carrying the reason — keeps the suite green when a model is
    // environment-gated, while making the gate's dormancy explicit in the test output.
    it.skip(`SKIPPED: ${skipReason}`, () => {
      expect(true).toBe(true);
    });
    return;
  }

  const clf = npmClassifier!;
  const files = corpusFiles();

  // Per-batch classification keeps each `it()` well under the vitest reporter heartbeat window —
  // a single 150s test starves the worker→main IPC and surfaces spurious "onTaskUpdate" timeouts.
  // ~2.7s/file under the pure-JS tfjs backend × ~9 files/batch ≈ 25s/case. Shared counters
  // accumulate across batches; a final case asserts the aggregate ≥95% rate. The Python ref labels
  // are fired up front (pipelined through the long-lived process) so they overlap TS inference.
  const BATCH_SIZE = 9;
  const PER_FILE_TIMEOUT_MS = 8_000; // generous per-file ceiling × BATCH_SIZE = the case timeout
  const batches: Array<Array<{ name: string; path: string }>> = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) batches.push(files.slice(i, i + BATCH_SIZE));

  // All Python-ref labels, keyed by file name. Started once, resolved lazily per batch.
  const pyByName = new Map(files.map((f) => [f.name, pyLabelPath(f.path)]));

  let matches = 0;
  let total = 0;
  const divergences: Array<{ file: string; ts: string; py: string }> = [];

  it("corpus has >=50 representative files across the routing-relevant axes", () => {
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  for (const [idx, batch] of batches.entries()) {
    it(
      `batch ${idx + 1}/${batches.length} (${batch.map((b) => b.name).join(", ")})`,
      async () => {
        for (const { name, path } of batch) {
          const body = new Uint8Array(readFileSync(path));
          const [tsResult, pyResult] = await Promise.all([
            clf.classify({ path: name, body }),
            pyByName.get(name)!,
          ]);
          // tfjs `identifyBytes` is a SYNCHRONOUS, CPU-heavy tensor op (~2.7s) that blocks the Node
          // event loop. Yield once per file so vitest's worker→main RPC heartbeat (onTaskUpdate) gets
          // serviced — otherwise the reporter IPC times out and surfaces spurious "unhandled errors"
          // even though the assertions pass. setImmediate is an event-loop primitive, not a wall-clock
          // / random source, so it's outside the clock_random gate's scope.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          // A Python-ref read failure is a harness fault, not a divergence — surface it loudly.
          expect(
            pyResult.ok,
            `python ref failed for ${name}: ${pyResult.ok ? "" : pyResult.err}`,
          ).toBe(true);
          const tsLabel = tsResult.magika_label;
          const pyLabel = pyResult.ok ? pyResult.label : "<error>";
          total += 1;
          if (tsLabel === pyLabel) {
            matches += 1;
          } else {
            divergences.push({ file: name, ts: tsLabel, py: pyLabel });
          }
        }
      },
      BATCH_SIZE * PER_FILE_TIMEOUT_MS,
    );
  }

  // The aggregate assertion runs as an afterAll hook — it executes AFTER every batch case regardless
  // of vitest's shuffled task order (sequence.shuffle is global), so it never races a batch that
  // hasn't accumulated yet. A failed assertion here fails the suite, which is the acceptance gate.
  afterAll(() => {
    if (total === 0) return; // suite was skipped (model unavailable) — nothing to assert.
    expect(total, "all batches must have run before the aggregate").toBe(files.length);
    const rate = matches / total;

    // Per-file divergence log: routing-impact transparency. Divergent labels route to {review} (the
    // safe default) unless BOTH sides independently agree on a SANDBOX_LANGUAGES label, so this log
    // is the operator-facing record of where the two models part ways.
    if (divergences.length > 0) {
      process.stdout.write(
        `\n[magika-agreement] ${divergences.length}/${total} divergent labels:\n` +
          divergences.map((d) => `  - ${d.file}: ts=${d.ts} py=${d.py}`).join("\n") +
          "\n",
      );
    }
    process.stdout.write(
      `[magika-agreement] rate=${(rate * 100).toFixed(1)}% (${matches}/${total}) ` +
        `threshold=${AGREEMENT_THRESHOLD * 100}%\n`,
    );

    expect(
      rate,
      `label-agreement ${(rate * 100).toFixed(1)}% < ${AGREEMENT_THRESHOLD * 100}% — see divergence log above`,
    ).toBeGreaterThanOrEqual(AGREEMENT_THRESHOLD);
  });
});
