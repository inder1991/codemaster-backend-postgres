import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  DiscoveredRepoDocsV1,
  EmbedDocChunksResultV1,
  MAX_DOC_BYTES,
  RefreshRepoDocsResultV1,
  RepoDocV1,
} from "../../libs/contracts/src/repo_docs.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree (invalid-value + extra-field for these strict models).
const PY = "contracts.repo_docs.v1";

const SHA64 = "a".repeat(64);

describe("RepoDocV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { relative_path: "docs/adr/0001-foo.md", byte_size: 1234, content_sha256: SHA64 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoDocV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RepoDocV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts byte_size at the boundaries (0 and MAX_DOC_BYTES)", async () => {
    for (const byte_size of [0, MAX_DOC_BYTES]) {
      const payload = { relative_path: "README.md", byte_size, content_sha256: SHA64 };
      const r = await pyRef({ pyModule: PY, pyCallable: "RepoDocV1", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(RepoDocV1.parse(payload))).toBe(r.out);
    }
  }, 30_000);

  it("both REJECT byte_size below range (< 0)", async () => {
    const bad = { relative_path: "README.md", byte_size: -1, content_sha256: SHA64 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoDocV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepoDocV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT byte_size above MAX_DOC_BYTES", async () => {
    const bad = { relative_path: "README.md", byte_size: MAX_DOC_BYTES + 1, content_sha256: SHA64 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoDocV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepoDocV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a content_sha256 of the wrong length (63 chars)", async () => {
    const bad = { relative_path: "README.md", byte_size: 1, content_sha256: "a".repeat(63) };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoDocV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepoDocV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { relative_path: "README.md", byte_size: 1, content_sha256: SHA64, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RepoDocV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepoDocV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("DiscoveredRepoDocsV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a populated payload identically (nested RepoDocV1 tuple)", async () => {
    const payload = {
      schema_version: 1,
      docs: [
        { relative_path: "README.md", byte_size: 10, content_sha256: SHA64 },
        { relative_path: "CLAUDE.md", byte_size: 20, content_sha256: "b".repeat(64) },
      ],
      docs_cap_hit: true,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredRepoDocsV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiscoveredRepoDocsV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (docs=[], docs_cap_hit=false, schema_version=1) when omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredRepoDocsV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiscoveredRepoDocsV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a malformed nested doc (sha256 wrong length)", async () => {
    const bad = { docs: [{ relative_path: "README.md", byte_size: 1, content_sha256: "short" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredRepoDocsV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DiscoveredRepoDocsV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredRepoDocsV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DiscoveredRepoDocsV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("EmbedDocChunksResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { schema_version: 1, embedded: 7, skipped_unchanged: 3, deleted_orphans: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedDocChunksResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(EmbedDocChunksResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative counter (embedded < 0)", async () => {
    const bad = { embedded: -1, skipped_unchanged: 0, deleted_orphans: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedDocChunksResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmbedDocChunksResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { embedded: 0, skipped_unchanged: 0, deleted_orphans: 0, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedDocChunksResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmbedDocChunksResultV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RefreshRepoDocsResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      docs_discovered: 12,
      docs_cap_hit: true,
      chunks_emitted: 40,
      embedded: 35,
      skipped_unchanged: 5,
      deleted_orphans: 2,
      retrieval_degraded: true,
      degradation_reason: "embed service rate-limited",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshRepoDocsResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshRepoDocsResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (docs_cap_hit/retrieval_degraded=false, degradation_reason='')", async () => {
    const payload = {
      docs_discovered: 0,
      chunks_emitted: 0,
      embedded: 0,
      skipped_unchanged: 0,
      deleted_orphans: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshRepoDocsResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshRepoDocsResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative counter (docs_discovered < 0)", async () => {
    const bad = {
      docs_discovered: -1,
      chunks_emitted: 0,
      embedded: 0,
      skipped_unchanged: 0,
      deleted_orphans: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshRepoDocsResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshRepoDocsResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a degradation_reason over max_length (200)", async () => {
    const bad = {
      docs_discovered: 0,
      chunks_emitted: 0,
      embedded: 0,
      skipped_unchanged: 0,
      deleted_orphans: 0,
      degradation_reason: "x".repeat(201),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshRepoDocsResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshRepoDocsResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      docs_discovered: 0,
      chunks_emitted: 0,
      embedded: 0,
      skipped_unchanged: 0,
      deleted_orphans: 0,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshRepoDocsResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshRepoDocsResultV1.parse(bad)).toThrow();
  }, 30_000);
});
