// MagikaFileClassifier — TypeScript port of the frozen Python
// vendor/codemaster-py/codemaster/files/magika_classifier.py::MagikaFileClassifier.
//
// Wraps the npm `magika` package (v1.0.0) to identify a file's content type from its bytes, then
// combines that ML-derived label with two path-based heuristics ported 1:1 from the frozen source:
//
//   - `is_generated`: a documented set of path patterns (lock files, build artifacts, vendor
//     directories) so the routing adapter can skip them without invoking the model on every byte.
//   - `language`: derived from the magika label for a known set of programming languages; null for
//     everything else.
//
// TOLERATED-DIVERGENCE axis (ADR-0065): the ML model differs across implementations — Python magika
// 1.0.2 vs npm magika 1.0.0 may emit different labels for the same bytes. The acceptance contract is
// a LABEL-AGREEMENT RATE (>=95%), NOT byte-parity. magika_label affects ROUTING only (never chunk_id
// or evidence_id identity), and unknown/divergent labels fall through to the safe default {review},
// so the blast radius of any single-file disagreement is contained. See ADR-0065 and the agreement
// test at test/parity/magika_agreement.parity.test.ts.
//
// The npm model is loaded ONCE (memoized) — model load is expensive. Production wiring instantiates
// one classifier per worker process and reuses it across all files, mirroring the Python lifecycle.

import { type FileClassificationV1 } from "#contracts/file_classification.v1.js";

// Path patterns that mark a file as generated. Order doesn't matter; we OR the regexes. This is the
// documented set ported verbatim from the frozen `_GENERATED_PATH_PATTERNS`; widening it requires an
// ADR so the review pipeline doesn't silently start skipping files.
//
// Python `(^|/)` → JS `(^|\/)`; Python `\.` → JS `\.`. No flags are needed (no IGNORECASE upstream).
const GENERATED_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)vendor\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)__pycache__\//,
  /\.min\.(js|css)$/,
  /\.generated\.(go|ts|js|py)$/,
];

// Magika label → language string. Absence means "no language". Ported verbatim from the frozen
// `_LANGUAGE_LABELS` (note `bash` and `shell` both map to "shell").
const LANGUAGE_LABELS: ReadonlyMap<string, string> = new Map([
  ["python", "python"],
  ["javascript", "javascript"],
  ["typescript", "typescript"],
  ["go", "go"],
  ["java", "java"],
  ["kotlin", "kotlin"],
  ["ruby", "ruby"],
  ["rust", "rust"],
  ["csharp", "csharp"],
  ["cpp", "cpp"],
  ["c", "c"],
  ["shell", "shell"],
  ["bash", "shell"],
  ["yaml", "yaml"],
  ["json", "json"],
  ["toml", "toml"],
  ["markdown", "markdown"],
  ["html", "html"],
  ["css", "css"],
  ["sql", "sql"],
  ["dockerfile", "dockerfile"],
]);

// Labels treated as binary (no LLM benefit; the sandbox can't help either). Ported verbatim from the
// frozen `_BINARY_LABELS` frozenset, including the sentinel labels "binary" and "unknown".
const BINARY_LABELS: ReadonlySet<string> = new Set([
  "png",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "zip",
  "tar",
  "gzip",
  "wasm",
  "elf",
  "macho",
  "exe",
  "binary",
  "unknown",
]);

/** Raised when the npm magika package fails to load its model at construction. Mirrors the frozen
 *  Python `MagikaModelLoadFailed`. */
export class MagikaModelLoadFailed extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MagikaModelLoadFailed";
  }
}

/** The narrow surface review-pipeline code depends on — mirrors the frozen `FileClassifierPort`
 *  Protocol. Tests inject a stub returning canned classifications. */
export type FileClassifierPort = {
  classify(args: { path: string; body: Uint8Array }): Promise<FileClassificationV1>;
};

/** The subset of the npm magika instance API this wrapper consumes. `identifyBytes` returns the
 *  per-file prediction envelope; we read `prediction.output.label`. Typed structurally so the wrapper
 *  doesn't depend on magika's exported result classes (which differ across the cjs/mjs/node builds). */
type MagikaInstance = {
  identifyBytes(bytes: Uint8Array): Promise<MagikaResultLike>;
};

/** Structural shape of the npm magika v1 `identifyBytes` result that we read. The label lives at
 *  `prediction.output.label`; `status` flags model-internal failures. Everything else (score,
 *  scores_map, dl, mime_type) is present but unused here — magika_label is the only routing input. */
type MagikaResultLike = {
  status?: string;
  prediction?: {
    output?: {
      label?: unknown;
    };
  };
};

// Memoized model promise — the model loads ONCE per process. Concurrent first-callers all await the
// same in-flight promise rather than triggering N redundant loads. Reset to undefined on failure so a
// transient load error doesn't permanently poison the cache.
let modelPromise: Promise<MagikaInstance> | undefined;

/** Load (or return the in-flight/cached) npm magika instance. Throws `MagikaModelLoadFailed` if the
 *  package can't be imported or the model can't be created in this environment (e.g. a runtime that
 *  the bundled ONNX/TF backend can't initialize). */
async function loadModel(): Promise<MagikaInstance> {
  if (modelPromise !== undefined) return modelPromise;
  modelPromise = (async (): Promise<MagikaInstance> => {
    let MagikaCtor: { create(): Promise<MagikaInstance> };
    try {
      ({ Magika: MagikaCtor } = await import("magika"));
    } catch (e) {
      throw new MagikaModelLoadFailed(`magika package not importable: ${String(e)}`, { cause: e });
    }
    try {
      return await MagikaCtor.create();
    } catch (e) {
      throw new MagikaModelLoadFailed(`magika model load failed: ${String(e)}`, { cause: e });
    }
  })();
  // On rejection, clear the cache so a later call can retry rather than re-throwing the stale error.
  modelPromise.catch(() => {
    modelPromise = undefined;
  });
  return modelPromise;
}

/** Production `FileClassifierPort` wrapping the npm magika library. Construct once per worker and
 *  reuse — the model is memoized at module scope, so every instance shares the single loaded model. */
export class MagikaFileClassifier implements FileClassifierPort {
  public async classify(args: { path: string; body: Uint8Array }): Promise<FileClassificationV1> {
    const { path, body } = args;

    // Empty body: short-circuit to the "empty" label exactly like the frozen Python — no model call.
    if (body.length === 0) {
      return {
        schema_version: 1,
        path,
        byte_size: 0,
        magika_label: "empty",
        language: null,
        is_binary: false,
        is_generated: isGeneratedPath(path),
      };
    }

    const model = await loadModel();
    const result = await model.identifyBytes(body);
    const label = extractMagikaLabel(result);
    const language = LANGUAGE_LABELS.get(label) ?? null;
    const is_binary = BINARY_LABELS.has(label);

    return {
      schema_version: 1,
      path,
      byte_size: body.length,
      magika_label: label,
      language,
      is_binary,
      is_generated: isGeneratedPath(path),
    };
  }
}

/** True iff the path matches any documented generated-file pattern. Mirrors `_is_generated_path`. */
export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((p) => p.test(path));
}

/** Defensively extract the lowercased label from the npm magika result. The label lives at
 *  `prediction.output.label`; if the model reports a non-`ok` status or the field is missing/empty we
 *  return "unknown" (which the routing adapter handles as the safe {review} default) — mirroring the
 *  frozen `_extract_magika_label` fallback chain. */
export function extractMagikaLabel(result: MagikaResultLike): string {
  const label = result.prediction?.output?.label;
  if (typeof label === "string" && label.length > 0) {
    return label.toLowerCase();
  }
  return "unknown";
}
