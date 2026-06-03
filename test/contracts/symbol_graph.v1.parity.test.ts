import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ConsumerHitV1,
  RefreshSymbolGraphResultV1,
  RemovedOrChangedSymbolV1,
  RepoSymbolV1,
  RetrievedConsumersV1,
  SymbolReferenceV1,
} from "../../libs/contracts/src/symbol_graph.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `<Model>(**payload).model_dump(mode="json")`) and through Zod
// (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree (invalid-value
// + extra-field for these extra=forbid models). UUIDs are spelled lowercase so Pydantic's
// lowercasing-on-dump matches Zod's pass-through. No bare-float fields → byte-equal canonical JSON.
const PY = "contracts.symbol_graph.v1";

describe("RefreshSymbolGraphResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      files_scanned: 12,
      symbols_extracted: 40,
      upserted: 7,
      skipped_unchanged: 30,
      deleted_orphans: 3,
      extractor_failures: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSymbolGraphResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshSymbolGraphResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version (1) default when omitted", async () => {
    const payload = {
      files_scanned: 0,
      symbols_extracted: 0,
      upserted: 0,
      skipped_unchanged: 0,
      deleted_orphans: 0,
      extractor_failures: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSymbolGraphResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshSymbolGraphResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (files_scanned < 0)", async () => {
    const bad = {
      files_scanned: -1,
      symbols_extracted: 0,
      upserted: 0,
      skipped_unchanged: 0,
      deleted_orphans: 0,
      extractor_failures: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSymbolGraphResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSymbolGraphResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      files_scanned: 0,
      symbols_extracted: 0,
      upserted: 0,
      skipped_unchanged: 0,
      deleted_orphans: 0,
      extractor_failures: 0,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSymbolGraphResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSymbolGraphResultV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RepoSymbolV1 parity (Pydantic ↔ Zod)", () => {
  const valid = {
    schema_version: 1,
    symbol_id: "550e8400-e29b-41d4-a716-446655440000",
    repo_id: "123e4567-e89b-12d3-a456-426614174000",
    language: "python",
    kind: "function",
    qualified_name: "pkg.module.do_thing",
    is_public: true,
    relative_path: "pkg/module.py",
    start_line: 10,
    end_line: 20,
    signature: "def do_thing(x: int) -> int",
    docstring: "Does the thing.",
    content_sha256: "a".repeat(64),
  };

  it("validates + dumps a fully-populated payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoSymbolV1", kwargs: valid });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RepoSymbolV1.parse(valid))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, docstring=null) when omitted", async () => {
    const payload = {
      symbol_id: "00000000-0000-4000-8000-000000000000",
      repo_id: "11111111-1111-4111-8111-111111111111",
      language: "typescript",
      kind: "class",
      qualified_name: "Foo",
      is_public: false,
      relative_path: "src/foo.ts",
      start_line: 1,
      end_line: 1,
      signature: "class Foo",
      content_sha256: "b".repeat(64),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoSymbolV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RepoSymbolV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT end_line < start_line (@model_validator _check_line_range)", async () => {
    const bad = { ...valid, start_line: 20, end_line: 10 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoSymbolV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepoSymbolV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a content_sha256 of the wrong length (min/max 64)", async () => {
    const bad = { ...valid, content_sha256: "a".repeat(63) };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoSymbolV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepoSymbolV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid enum value (language)", async () => {
    const bad = { ...valid, language: "rust" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoSymbolV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepoSymbolV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...valid, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoSymbolV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepoSymbolV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("SymbolReferenceV1 parity (Pydantic ↔ Zod)", () => {
  const valid = {
    schema_version: 1,
    reference_id: "550e8400-e29b-41d4-a716-446655440001",
    target_symbol_id: "550e8400-e29b-41d4-a716-446655440002",
    consumer_repo_id: "550e8400-e29b-41d4-a716-446655440003",
    consumer_relative_path: "src/consumer.ts",
    consumer_line: 42,
    kind: "import_match",
    confidence: "high",
    excerpt: "import { doThing } from './lib';",
  };

  it("validates + dumps a fully-populated payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "SymbolReferenceV1", kwargs: valid });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SymbolReferenceV1.parse(valid))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, excerpt=null) when omitted", async () => {
    const payload = {
      reference_id: "00000000-0000-4000-8000-00000000000a",
      target_symbol_id: "00000000-0000-4000-8000-00000000000b",
      consumer_repo_id: "00000000-0000-4000-8000-00000000000c",
      consumer_relative_path: "a.py",
      consumer_line: 1,
      kind: "comment_mention",
      confidence: "low",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SymbolReferenceV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SymbolReferenceV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an invalid enum value (kind)", async () => {
    const bad = { ...valid, kind: "guess_match" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SymbolReferenceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SymbolReferenceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT consumer_line < 1", async () => {
    const bad = { ...valid, consumer_line: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "SymbolReferenceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SymbolReferenceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...valid, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "SymbolReferenceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SymbolReferenceV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RemovedOrChangedSymbolV1 parity (Pydantic ↔ Zod)", () => {
  const valid = {
    target_symbol_id: "550e8400-e29b-41d4-a716-446655440004",
    qualified_name: "pkg.api.public_fn",
    change_kind: "signature_changed",
    new_signature: "def public_fn(x: int, y: int) -> int",
  };

  it("validates + dumps a fully-populated payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "RemovedOrChangedSymbolV1", kwargs: valid });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RemovedOrChangedSymbolV1.parse(valid))).toBe(r.out);
  }, 30_000);

  it("applies the same new_signature=null default when omitted", async () => {
    const payload = {
      target_symbol_id: "00000000-0000-4000-8000-00000000000d",
      qualified_name: "pkg.api.gone",
      change_kind: "removed",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RemovedOrChangedSymbolV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RemovedOrChangedSymbolV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an invalid enum value (change_kind)", async () => {
    const bad = { ...valid, change_kind: "renamed" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RemovedOrChangedSymbolV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RemovedOrChangedSymbolV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...valid, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RemovedOrChangedSymbolV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RemovedOrChangedSymbolV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ConsumerHitV1 parity (Pydantic ↔ Zod)", () => {
  const valid = {
    consumer_repo_id: "550e8400-e29b-41d4-a716-446655440005",
    consumer_relative_path: "src/uses_it.ts",
    consumer_line: 7,
    confidence: "medium",
    excerpt: "doThing(1, 2)",
  };

  it("validates + dumps a fully-populated payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "ConsumerHitV1", kwargs: valid });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConsumerHitV1.parse(valid))).toBe(r.out);
  }, 30_000);

  it("applies the same excerpt=null default when omitted", async () => {
    const payload = {
      consumer_repo_id: "00000000-0000-4000-8000-00000000000e",
      consumer_relative_path: "a.ts",
      consumer_line: 1,
      confidence: "high",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConsumerHitV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConsumerHitV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...valid, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConsumerHitV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConsumerHitV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RetrievedConsumersV1 parity (Pydantic ↔ Zod)", () => {
  const target = {
    target_symbol_id: "550e8400-e29b-41d4-a716-446655440006",
    qualified_name: "pkg.api.public_fn",
    change_kind: "signature_changed",
    new_signature: "def public_fn(x: int) -> int",
  };
  const hit = {
    consumer_repo_id: "550e8400-e29b-41d4-a716-446655440007",
    consumer_relative_path: "src/uses_it.ts",
    consumer_line: 7,
    confidence: "high",
    excerpt: "doThing(1)",
  };

  it("validates + dumps a fully-populated payload (nested target + hits) identically", async () => {
    const payload = { schema_version: 1, target, hits: [hit], truncated: true };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedConsumersV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RetrievedConsumersV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, hits=[], truncated=false) when omitted", async () => {
    const payload = { target };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedConsumersV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RetrievedConsumersV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a malformed nested hit (consumer_line < 1)", async () => {
    const bad = { target, hits: [{ ...hit, consumer_line: 0 }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedConsumersV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedConsumersV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { target, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedConsumersV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedConsumersV1.parse(bad)).toThrow();
  }, 30_000);
});
