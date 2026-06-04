import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import { assertParity, shutdownRef } from "./oracle.js";
import { chunkMarkdown } from "#backend/chunking/markdown_chunker.js";
import { computeChunkId } from "#contracts/diff_chunking.v1.js";

// Tier-A parity for the markdown chunker. `chunk_markdown` is a MODULE-LEVEL PURE function returning
// a tuple of MarkdownChunkV1 (all JSON-safe int/str fields) — so the GENERIC oracle (assertParity /
// pyRef → tools/parity/run_python_ref.py) drives it directly, no dedicated driver needed. Each case
// runs the SAME kwargs through the frozen Python chunker and the TS port, then diffs canonical JSON.
afterAll(() => shutdownRef());

const PY_MODULE = "codemaster.chunking.markdown_chunker";
const PY_CALLABLE = "chunk_markdown";

// ── harness reconciliation: ensure_ascii ─────────────────────────────────────────────────────────
// The Python ref runner canonicalizes with `json.dumps(...)` (default ensure_ascii=True → non-ASCII
// escaped as \uXXXX), while the TS canonicalizer uses JSON.stringify (raw chars). The chunk BODIES
// are byte-identical (this subsystem emits U+FFFD on invalid UTF-8 input, exactly like Python); only
// the canonicalizer's escaping policy differs. We cannot touch the shared harness (canonical.ts /
// run_python_ref.py belong to sibling streams), so we reconcile per-test by ASCII-escaping the TS
// canonical string the same way Python's json.dumps does — per UTF-16 code unit, lowercase hex,
// astral chars as surrogate pairs (verified equal to Python's ensure_ascii form). For pure-ASCII
// outputs this is a no-op, so it is safe to apply to every case.
const NON_ASCII = /[\u0080-\uffff]/g;
function escapeNonAscii(s: string): string {
  return s.replace(NON_ASCII, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Drive the frozen Python chunker and assert the TS port is byte-identical (ensure_ascii-reconciled). */
async function assertChunkParity(kwargs: Record<string, unknown>): Promise<void> {
  const r = await assertParity({
    kwargs,
    pyModule: PY_MODULE,
    pyCallable: PY_CALLABLE,
    tsFn: (k) =>
      // Omit target_chars entirely when absent (exactOptionalPropertyTypes forbids explicit undefined).
      chunkMarkdown(
        k.target_chars === undefined
          ? { relative_path: k.relative_path as string, body: k.body as string }
          : {
              relative_path: k.relative_path as string,
              body: k.body as string,
              target_chars: k.target_chars as number,
            },
      ),
  });
  // r.ts/r.py are the canonical-JSON strings; reconcile ensure_ascii before comparing.
  expect(escapeNonAscii(r.ts), `TS=${r.ts}\nPY=${r.py}`).toBe(r.py);
}

// Each fixture is the exact kwargs object `chunk_markdown(**kwargs)` consumes (keyword-only args:
// relative_path / body / target_chars). Chosen to cover: empty, single paragraph, H1/H2/H3 anchoring,
// pre-heading prose, fenced code (heading-like lines inside a fence must NOT split), an oversized
// section split at a paragraph boundary, trailing-newline line-count handling, and H4+ as body.
const FIXTURES: ReadonlyArray<{ name: string; kwargs: Record<string, unknown> }> = [
  {
    name: "empty body → no chunks",
    kwargs: { relative_path: "docs/x.md", body: "" },
  },
  {
    name: "single paragraph, no heading",
    kwargs: { relative_path: "docs/x.md", body: "Just one paragraph of prose.\n" },
  },
  {
    name: "pre-heading prose then H1 sections",
    kwargs: {
      relative_path: "x.md",
      body: "intro line\n\n# Architecture\narch body\n\n# Operations\nops body\n",
    },
  },
  {
    name: "H1 → H2 → H3 heading-path nesting",
    kwargs: {
      relative_path: "x.md",
      body: "# A\narch\n\n## B\nrows\n\n### C\ndeep content\n\ntrailing\n",
    },
  },
  {
    name: "fenced code with heading-like lines inside (no split)",
    kwargs: {
      relative_path: "r.md",
      body: "# Code\nhere is code:\n\n```python\n# not a heading\ndef f(): pass\n```\n\ndone\n",
    },
  },
  {
    name: "oversized section split at paragraph boundary (target_chars=40)",
    kwargs: {
      relative_path: "r.md",
      body: "# H\npara one line\n\npara two line\n\npara three line\n\npara four line\n",
      target_chars: 40,
    },
  },
  {
    name: "H4+ treated as body content, not structural",
    kwargs: {
      relative_path: "deep.md",
      body: "# Top\nbody\n\n#### Sub-sub-heading line\nstill same chunk\n",
    },
  },
  {
    name: "body WITHOUT trailing newline (line-count edge)",
    kwargs: {
      relative_path: "n.md",
      body: "# T\nlast line has no newline",
    },
  },
  {
    name: "non-ASCII heading + body (UTF-8 round-trip)",
    kwargs: {
      relative_path: "u.md",
      body: "# Naming › Variables\nuse café_count not c\n\n## 日本語\n本文 — 🎉\n",
    },
  },
];

describe("chunkMarkdown parity (frozen Python ↔ TS port)", () => {
  for (const fixture of FIXTURES) {
    it(`is byte-equal: ${fixture.name}`, async () => {
      await assertChunkParity(fixture.kwargs);
    }, 30_000);
  }
});

// ── Invariant #15 foundation: chunk_id on INVALID-UTF-8 input must be BYTE-IDENTICAL ──────────────
//
// The chunk_id is minted by computeChunkId (already ported, libs/contracts) as
//   UUIDv5(namespace, f"{path}\n{start}\n{end}\n{sha256(body).hexdigest()}")
// where Python encodes body via `.encode("utf-8", errors="replace")`. Real file bytes are decoded
// ONCE upstream (raw bytes → str via errors="replace" / TextDecoder), so the body the chunker sees is
// already a valid Unicode string of U+FFFD replacement chars wherever the source bytes were invalid.
// This test pins that the byte-derived path (decode invalid bytes → mint id) is byte-identical across
// languages: TextDecoder("utf-8") and Python bytes.decode("utf-8", errors="replace") both emit one
// U+FFFD per invalid byte, and re-encoding U+FFFD → EF BF BD identically on both sides. Downstream
// v10 evidence_id derives from this chunk_id, so a divergence here would silently fork grounding.
describe("computeChunkId parity on invalid-UTF-8 body (invariant #15)", () => {
  // 0xFF 0xFE embedded between valid ASCII — the canonical "stray invalid bytes in a real file" case.
  const RAW_INVALID = Buffer.from([
    0x23, 0x20, 0x54, 0x69, 0x74, 0x6c, 0x65, 0x0a, // "# Title\n"
    0x73, 0x6f, 0x6d, 0x65, 0x20, 0x62, 0x6f, 0x64, 0x79, 0x20, // "some body "
    0xff, 0xfe, // two invalid bytes → two U+FFFD
    0x20, 0x6d, 0x6f, 0x72, 0x65, 0x0a, // " more\n"
  ]);
  // Decoded EXACTLY as production does (raw file bytes → str). The frozen Python value below was
  // produced by vendor/codemaster-py compute_chunk_id over the IDENTICAL decoded string.
  const BODY = new TextDecoder("utf-8").decode(RAW_INVALID);

  it("decodes 0xFF 0xFE to two U+FFFD identically to Python errors='replace'", () => {
    expect(BODY).toBe("# Title\nsome body �� more\n");
  });

  it("mints the byte-identical chunk_id pinned against frozen Python", () => {
    // Verified against vendor/codemaster-py:
    //   compute_chunk_id(path='docs/x.md', start_line=1, end_line=2,
    //                    body=b'...\xff\xfe...'.decode('utf-8', errors='replace'))
    const id = computeChunkId({ path: "docs/x.md", start_line: 1, end_line: 2, body: BODY });
    expect(id).toBe("c5cf4b6b-3e53-5326-be97-63e6d64204fd");
  });

  it("round-trips the same chunk over multiple invalid byte sequences (decode→mint stable)", async () => {
    // Several invalid-UTF-8 byte sequences (incl. surrogate-range bytes ED A0 80 and overlong C0 80)
    // all decode→re-encode byte-identically across languages; prove value-parity via the chunk body.
    for (const hex of ["ff", "fe", "fffe", "eda080", "c080", "e228a1"]) {
      const decoded = new TextDecoder("utf-8").decode(Buffer.from(hex, "hex"));
      await assertChunkParity({ relative_path: "inv.md", body: `# H\n${decoded}\n` });
    }
  }, 30_000);

  it("canonical chunk JSON for the invalid body matches Python end-to-end", async () => {
    await assertChunkParity({ relative_path: "docs/x.md", body: BODY });
    // and the TS output is internally consistent (canonicalizes without throwing).
    expect(() => canonicalize(chunkMarkdown({ relative_path: "docs/x.md", body: BODY }))).not.toThrow();
  }, 30_000);
});
