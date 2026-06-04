import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import {
  pyDoClassify,
  shutdownClassifyRef,
  type ClassificationInput,
  type ClassifyRequest,
} from "./classify_oracle.js";
import { doClassify } from "#backend/activities/classify_files.activity.js";
import { ClassifyFilesInputV1 } from "#contracts/classify_files.v1.js";
import { FileClassificationV1 } from "#contracts/file_classification.v1.js";
import type { FileClassifierPort } from "#backend/files/magika_classifier.js";

afterAll(() => {
  shutdownClassifyRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `doClassify` orchestration (read bytes → classify → decideRoute → bucket,
// with per-file failure isolation) is byte-equal to the frozen Python `_do_classify`
// (vendor/codemaster-py/codemaster/activities/classify_files.py), driven over the dedicated ref
// (tools/parity/run_classify_ref.py).
//
// Both sides classify via a STUB looked up from the SAME {path -> FileClassificationV1 wire dict} map —
// the magika ML is OUT OF SCOPE here (separately covered by test:magika). The stub keeps the routing /
// failure-isolation orchestration byte-verifiable WITHOUT the ~150s ONNX model load.
//
// FileRoutingV1 + FileClassificationV1 are pure-structural (no bare floats), so the generic
// `canonicalize` compare diffs the whole envelope (the four path lists IN INPUT ORDER + classifications +
// classifier_failures) directly — no per-field stripping needed (unlike the aggregate confidence float).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Build one FileClassificationV1 wire dict with sensible defaults for the routing under test. */
function cls(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    path: "x",
    byte_size: 1,
    magika_label: "markdown",
    language: null,
    is_binary: false,
    is_generated: false,
    ...overrides,
  };
}

/** A TS stub `FileClassifierPort` mirroring the Python `_MapStubClassifier`: look up the {path -> wire
 *  dict} map and parse through the contract (applying defaults), raising for any `fail` path. NO magika. */
function stubClassifier(
  classifications: Readonly<Record<string, ClassificationInput>>,
  fail: ReadonlySet<string>,
): FileClassifierPort {
  return {
    classify({ path }: { path: string; body: Uint8Array }): Promise<FileClassificationV1> {
      if (fail.has(path)) {
        return Promise.reject(new Error(`parity stub: forced classify failure for ${path}`));
      }
      const entry = classifications[path];
      if (entry === undefined) {
        return Promise.reject(new Error(`parity stub: no classification mapped for ${path}`));
      }
      return Promise.resolve(FileClassificationV1.parse(entry));
    },
  };
}

const tempDirs: Array<string> = [];

/** Materialize the request's fixtures into a fresh temp workspace for the TS side (the Python driver
 *  writes its OWN temp dir internally). Returns the absolute workspace path. Nested paths get their
 *  parent dirs created (mirrors the Python `parent.mkdir(parents=True)`). */
function writeTsWorkspace(fixtures: Readonly<Record<string, string>>): string {
  const workspace = mkdtempSync(join(tmpdir(), "classify-parity-"));
  tempDirs.push(workspace);
  for (const [rel, body] of Object.entries(fixtures)) {
    const abs = join(workspace, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf-8");
  }
  return workspace;
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Run the SAME request through the TS `doClassify` and the frozen Python `_do_classify`, and assert
 * byte-equality of the whole `FileRoutingV1` envelope (the four path lists in INPUT ORDER + classifications
 * + classifier_failures). Returns the Python envelope for extra structural assertions.
 */
async function assertParity(req: ClassifyRequest): Promise<RoutingDictLocal> {
  const workspace = writeTsWorkspace(req.fixtures);
  const failSet = new Set(req.classify_fail);
  const classifier = stubClassifier(req.classifications, failSet);

  const ts = (await doClassify({
    workspace,
    files: req.files,
    classifier,
  })) as unknown as Record<string, unknown>;
  const py = (await pyDoClassify(req)) as Record<string, unknown>;

  expect(canonicalize(ts)).toBe(canonicalize(py));
  return py as RoutingDictLocal;
}

type RoutingDictLocal = {
  readonly review_files: ReadonlyArray<string>;
  readonly sandbox_files: ReadonlyArray<string>;
  readonly skip_files: ReadonlyArray<string>;
  readonly classifications: ReadonlyArray<Record<string, unknown>>;
  readonly classifier_failures: ReadonlyArray<string>;
};

describe("classify_files _do_classify parity (Python ↔ TS)", () => {
  it("review-only — a markdown file routes to review only", async () => {
    const py = await assertParity({
      files: ["readme.md"],
      fixtures: { "readme.md": "# hi" },
      classifications: {
        "readme.md": cls({ path: "readme.md", magika_label: "markdown", language: "markdown" }),
      },
      classify_fail: [],
    });
    expect(py.review_files).toEqual(["readme.md"]);
    expect(py.sandbox_files).toEqual([]);
    expect(py.skip_files).toEqual([]);
    expect(py.classifier_failures).toEqual([]);
  }, 30_000);

  it("sandbox+review — a CODE file (python) routes to BOTH review and sandbox", async () => {
    const py = await assertParity({
      files: ["mod.py"],
      fixtures: { "mod.py": "x = 1\n" },
      classifications: {
        "mod.py": cls({ path: "mod.py", magika_label: "python", language: "python", byte_size: 6 }),
      },
      classify_fail: [],
    });
    // The dual-bucket membership of a code file is preserved exactly (Python frozenset → TS Set).
    expect(py.review_files).toEqual(["mod.py"]);
    expect(py.sandbox_files).toEqual(["mod.py"]);
    expect(py.skip_files).toEqual([]);
  }, 30_000);

  it("skip — a generated file routes to skip only (never review/sandbox)", async () => {
    const py = await assertParity({
      files: ["package-lock.json"],
      fixtures: { "package-lock.json": "{}" },
      classifications: {
        "package-lock.json": cls({
          path: "package-lock.json",
          magika_label: "json",
          language: "json",
          is_generated: true,
        }),
      },
      classify_fail: [],
    });
    expect(py.skip_files).toEqual(["package-lock.json"]);
    expect(py.review_files).toEqual([]);
    expect(py.sandbox_files).toEqual([]);
  }, 30_000);

  it("read failure — an UNREADABLE file (not on disk) lands in classifier_failures, absent everywhere", async () => {
    const py = await assertParity({
      files: ["missing.py"],
      // NO fixture written → Path.read_bytes raises FileNotFoundError (OSError) / readFileSync throws.
      fixtures: {},
      classifications: {
        "missing.py": cls({ path: "missing.py", language: "python", magika_label: "python" }),
      },
      classify_fail: [],
    });
    expect(py.classifier_failures).toEqual(["missing.py"]);
    expect(py.review_files).toEqual([]);
    expect(py.sandbox_files).toEqual([]);
    expect(py.skip_files).toEqual([]);
    // A read failure never reaches the classifier → classifications excludes it.
    expect(py.classifications).toHaveLength(0);
  }, 30_000);

  it("classify failure — the stub raises for one path → that path in classifier_failures only", async () => {
    const py = await assertParity({
      files: ["boom.py"],
      fixtures: { "boom.py": "y = 2\n" },
      classifications: {}, // stub raises before any lookup
      classify_fail: ["boom.py"],
    });
    expect(py.classifier_failures).toEqual(["boom.py"]);
    expect(py.review_files).toEqual([]);
    expect(py.sandbox_files).toEqual([]);
    expect(py.skip_files).toEqual([]);
    expect(py.classifications).toHaveLength(0);
  }, 30_000);

  it("mixed PR — review-only + code(both) + skip + read-fail + classify-fail, INPUT ORDER preserved", async () => {
    const py = await assertParity({
      // Deliberately interleaved so input-order preservation across all buckets is asserted.
      files: ["a.md", "b.py", "gen.min.js", "gone.go", "bad.ts", "c.py"],
      fixtures: {
        "a.md": "# doc",
        "b.py": "b = 1\n",
        "gen.min.js": "var a=1;",
        // "gone.go" intentionally NOT written → read failure.
        "bad.ts": "const x = 1;",
        "c.py": "c = 3\n",
      },
      classifications: {
        "a.md": cls({ path: "a.md", magika_label: "markdown", language: "markdown" }),
        "b.py": cls({ path: "b.py", magika_label: "python", language: "python" }),
        "gen.min.js": cls({
          path: "gen.min.js",
          magika_label: "javascript",
          language: "javascript",
          is_generated: true,
        }),
        "gone.go": cls({ path: "gone.go", magika_label: "go", language: "go" }),
        // "bad.ts" classify-fails before lookup.
        "c.py": cls({ path: "c.py", magika_label: "python", language: "python" }),
      },
      classify_fail: ["bad.ts"],
    });
    // review = markdown + the two python code files, in input order.
    expect(py.review_files).toEqual(["a.md", "b.py", "c.py"]);
    // sandbox = the two python code files only (markdown isn't sandboxed), in input order.
    expect(py.sandbox_files).toEqual(["b.py", "c.py"]);
    // skip = the generated min.js.
    expect(py.skip_files).toEqual(["gen.min.js"]);
    // failures = read-fail (gone.go) then classify-fail (bad.ts), in input order.
    expect(py.classifier_failures).toEqual(["gone.go", "bad.ts"]);
    // classifications excludes BOTH failed files (read-fail + classify-fail), keeping the 4 that routed.
    expect(py.classifications.map((c) => c["path"])).toEqual([
      "a.md",
      "b.py",
      "gen.min.js",
      "c.py",
    ]);
  }, 30_000);

  it("empty file list → empty routing envelope", async () => {
    const py = await assertParity({
      files: [],
      fixtures: {},
      classifications: {},
      classify_fail: [],
    });
    expect(py.review_files).toEqual([]);
    expect(py.sandbox_files).toEqual([]);
    expect(py.skip_files).toEqual([]);
    expect(py.classifications).toEqual([]);
    expect(py.classifier_failures).toEqual([]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ClassifyFilesInputV1 — the NEW typed envelope introduced during the port (CLAUDE.md invariant 11 /
// ADR-0047 closure of the Python 2-positional dispatch). There is NO Python counterpart to byte-diff, so
// this covers round-trip + validation only (mirrors the AggregateFindingsInputV1 envelope tests).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("ClassifyFilesInputV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts a valid {workspace_path, files} and applies the schema_version default", () => {
    const parsed = ClassifyFilesInputV1.parse({ workspace_path: "/tmp/ws", files: ["a.py", "b.md"] });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.workspace_path).toBe("/tmp/ws");
    expect(parsed.files).toEqual(["a.py", "b.md"]);
  });

  it("accepts empty files", () => {
    const parsed = ClassifyFilesInputV1.parse({ workspace_path: "/tmp/ws", files: [] });
    expect(parsed.files).toEqual([]);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() =>
      ClassifyFilesInputV1.parse({ workspace_path: "/tmp/ws", files: [], bogus: true }),
    ).toThrow();
  });

  it("rejects a non-string file entry", () => {
    expect(() => ClassifyFilesInputV1.parse({ workspace_path: "/tmp/ws", files: [42] })).toThrow();
  });
});
