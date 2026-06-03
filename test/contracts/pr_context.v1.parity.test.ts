import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ChangedFile,
  FileClassification,
  ManifestSnapshot,
  ParsedDependencyV1,
  PRContext,
} from "../../libs/contracts/src/pr_context.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `<Model>(**payload).model_dump(mode="json")`) and through Zod
// (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// UUIDs are spelled lowercase so Pydantic's lowercasing-on-dump matches Zod's pass-through.
const PY = "contracts.retrieval.pr_context.v1";

describe("ParsedDependencyV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      ecosystem: "npm",
      name: "react",
      version_spec: "^19.0.0",
      dependency_type: "prod",
      source_manifest: "frontend/package.json",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParsedDependencyV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ParsedDependencyV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version/version_spec/dependency_type) when omitted", async () => {
    const payload = { ecosystem: "pip", name: "requests", source_manifest: "pyproject.toml" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParsedDependencyV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ParsedDependencyV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown ecosystem (Literal ↔ z.enum)", async () => {
    const bad = { ecosystem: "maven", name: "x", source_manifest: "pom.xml" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParsedDependencyV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ParsedDependencyV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty name (min_length=1)", async () => {
    const bad = { ecosystem: "pip", name: "", source_manifest: "pyproject.toml" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParsedDependencyV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ParsedDependencyV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ecosystem: "pip", name: "x", source_manifest: "pyproject.toml", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParsedDependencyV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ParsedDependencyV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("FileClassification parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = { is_generated: true, is_vendored: false, is_test: true, reason: "matches *_test.py" };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassification", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileClassification.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same all-default payload (every field omitted)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassification", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileClassification.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { is_generated: true, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassification", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileClassification.parse(bad)).toThrow();
  }, 30_000);
});

describe("ChangedFile parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload (nested classification) identically", async () => {
    const payload = {
      path: "src/app.py",
      additions: 10,
      deletions: 3,
      classification: { is_generated: false, is_vendored: false, is_test: false, reason: null },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ChangedFile", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ChangedFile.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same default_factory classification when omitted", async () => {
    const payload = { path: "README.md", additions: 0, deletions: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ChangedFile", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ChangedFile.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative additions (ge=0)", async () => {
    const bad = { path: "a", additions: -1, deletions: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ChangedFile", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ChangedFile.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { path: "a", additions: 0, deletions: 0, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ChangedFile", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ChangedFile.parse(bad)).toThrow();
  }, 30_000);
});

describe("ManifestSnapshot parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload (nested records + v2 fields) identically", async () => {
    const payload = {
      path: "pyproject.toml",
      raw_body: "[project]\nname = \"codemaster\"\n",
      parsed_dependencies: ["requests", "pydantic"],
      parsed_dependency_records: [
        {
          schema_version: 1,
          ecosystem: "pip",
          name: "requests",
          version_spec: ">=2.31.0",
          dependency_type: "prod",
          source_manifest: "pyproject.toml",
        },
      ],
      fetch_status: "success",
      content_type: "text",
      byte_length: 1024,
      sha256: "e".repeat(64),
      truncated: false,
      detected_ecosystem: "python",
      dependency_parsing_state: "parsed",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ManifestSnapshot", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ManifestSnapshot.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same v2 defaults (every additive field omitted)", async () => {
    const payload = { path: "go.mod" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ManifestSnapshot", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ManifestSnapshot.parse(payload))).toBe(r.out);
  }, 30_000);

  it("dumps a fetch-failed snapshot (empty body + NOT_FOUND enum) identically", async () => {
    const payload = {
      path: "package.json",
      fetch_status: "not_found",
      content_type: "unknown",
      dependency_parsing_state: "not_attempted",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ManifestSnapshot", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ManifestSnapshot.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown fetch_status enum value (StrEnum ↔ z.enum)", async () => {
    const bad = { path: "a", fetch_status: "rate_limited" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ManifestSnapshot", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ManifestSnapshot.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a sha256 over max_length (64)", async () => {
    const bad = { path: "a", sha256: "f".repeat(65) };
    const r = await pyRef({ pyModule: PY, pyCallable: "ManifestSnapshot", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ManifestSnapshot.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { path: "a", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ManifestSnapshot", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ManifestSnapshot.parse(bad)).toThrow();
  }, 30_000);
});

describe("PRContext parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload (nested files + manifests) identically", async () => {
    const payload = {
      schema_version: 1,
      pr_id: "550e8400-e29b-41d4-a716-446655440000",
      head_sha: "a".repeat(40),
      changed_files: [
        {
          path: "src/app.py",
          additions: 5,
          deletions: 1,
          classification: { is_generated: false, is_vendored: false, is_test: false, reason: null },
        },
      ],
      manifests: [
        {
          path: "pyproject.toml",
          raw_body: "[project]\n",
          parsed_dependencies: ["requests"],
          parsed_dependency_records: [],
          fetch_status: "success",
          content_type: "text",
          byte_length: 11,
          sha256: "",
          truncated: false,
          detected_ecosystem: "python",
          dependency_parsing_state: "not_attempted",
        },
      ],
      repo_default_branch: "main",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRContext", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PRContext.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version/changed_files/manifests) when omitted", async () => {
    const payload = {
      pr_id: "123e4567-e89b-12d3-a456-426614174000",
      head_sha: "0".repeat(40),
      repo_default_branch: "develop",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRContext", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PRContext.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a head_sha that is not exactly 40 chars (min/max=40)", async () => {
    const bad = {
      pr_id: "123e4567-e89b-12d3-a456-426614174000",
      head_sha: "a".repeat(39),
      repo_default_branch: "main",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRContext", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PRContext.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID pr_id", async () => {
    const bad = { pr_id: "not-a-uuid", head_sha: "a".repeat(40), repo_default_branch: "main" };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRContext", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PRContext.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      pr_id: "123e4567-e89b-12d3-a456-426614174000",
      head_sha: "a".repeat(40),
      repo_default_branch: "main",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRContext", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PRContext.parse(bad)).toThrow();
  }, 30_000);
});
