// W2.2 (prompt caching) — unit coverage of buildCachedReviewPrompt, the cache-ordered split of the
// review-chunk user prompt:
//
//   stablePrefix — PR-level blocks ONLY (PR header, chunk-independent PR-scope manifest, project
//                  manifests). MUST be BYTE-IDENTICAL across every chunk call of one review — the
//                  Anthropic/Bedrock prompt cache matches PREFIXES, so any per-chunk byte leaking in
//                  (a "← THIS CHUNK" marker, retrieval-cited path retention, map-iteration order)
//                  silently zeroes the cache-hit rate. The identity assertions here are the W2.2 pin.
//   chunkSuffix  — everything per-chunk/per-file (policy, knowledge, consumers, evidence, tier-1,
//                  tool statuses, arbitration, path instructions, prior findings) with the chunk
//                  DIFF as the LAST block (stable→variable ordering is load-bearing for caching).
//
// The legacy buildUserMessage stays byte-frozen for the Python parity oracle; this split builder is
// the NEW assembly doReview feeds to the LLM. Content parity between the two assemblies (no block
// gained/lost, only reordered) is asserted below.

import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { buildCachedReviewPrompt, buildUserMessage } from "#backend/review/prompt_builder.js";
import { CLOSE_TRUSTED_SUFFIX } from "#backend/security/trust_tier_wrapping.js";

import { ReviewContextV1 } from "#contracts/review_context.v1.js";

const PR_ID = "11111111-1111-4111-8111-111111111111";
const INST_ID = "22222222-2222-4222-8222-222222222222";
const REPO_ID = "33333333-3333-4333-8333-333333333333";
const SHA64 = "a".repeat(64);

// ── fixture helpers (shapes mirror test/parity/review_prompt.parity.test.ts) ────────────────────

function sha1Hex(s: string): string {
  return createHash("sha1").update(Buffer.from(s, "utf-8")).digest("hex");
}

function deterministicUuid(seed: string): string {
  const h = sha1Hex(seed);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

function chunk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunk_id: deterministicUuid(`chunk:${JSON.stringify(overrides)}`),
    path: "src/app/handler.ts",
    language: "typescript",
    start_line: 10,
    end_line: 22,
    body: "export function handler(req: Request): Response {\n  return new Response('ok');\n}",
    chunk_kind: "function",
    token_estimate: 42,
    ...overrides,
  };
}

function knowledgeChunk(
  relativePath: string,
  headingPath: ReadonlyArray<string>,
  body: string,
): Record<string, unknown> {
  return {
    chunk_id: deterministicUuid(`kc:${relativePath}:${headingPath.join("/")}`),
    installation_id: INST_ID,
    repo_id: REPO_ID,
    relative_path: relativePath,
    chunk_index: 0,
    heading_path: headingPath,
    body,
    doc_kind: "other",
  };
}

function evidence(
  sourceType: string,
  path: string | null,
  excerpt: string,
): Record<string, unknown> {
  const hex = sha1Hex(`${sourceType}:${path}:${excerpt}`).slice(0, 16);
  return { evidence_id: `ev_${hex}`, source_type: sourceType, path, excerpt };
}

function topology(
  entries: ReadonlyArray<readonly [string, string, number, number]>,
): Array<Record<string, unknown>> {
  return entries.map(([path, kind, start, end]) => ({
    chunk_id: deterministicUuid(`top:${path}:${start}:${end}`),
    path,
    start_line: start,
    end_line: end,
    kind,
  }));
}

function toolStatus(
  toolName: string,
  status: string,
  scanned: number,
  total: number,
): Record<string, unknown> {
  return {
    tool_name: toolName,
    status,
    files_scanned: scanned,
    files_total: total,
    started_at: "2026-01-01T00:00:00+00:00",
    finished_at: "2026-01-01T00:00:01+00:00",
    duration_ms: 1000,
    findings_produced: 0,
    error_class: null,
  };
}

function rule(
  ruleId: string,
  scopeDir: string,
  body: string,
  headingPath: ReadonlyArray<string>,
): Record<string, unknown> {
  return {
    rule_id: ruleId,
    normalized_hash: SHA64,
    source_file: `${scopeDir || "."}/CLAUDE.md`,
    source_file_sha256: SHA64,
    scope_dir: scopeDir,
    heading_path: headingPath,
    rule_index: 0,
    title: `${ruleId} title`,
    body,
    category: "security",
    intent: "forbid",
    priority: 100,
  };
}

/** PR-level fields shared by every chunk context of one review. */
function prLevelFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pr_id: PR_ID,
    installation_id: INST_ID,
    repo: "acme/widgets",
    pr_title: "Refactor request handling",
    pr_description: "Multi-file refactor of the handler pipeline.",
    policy_revision: 2,
    pr_topology_manifest: topology([
      ["src/app/handler.ts", "code", 10, 22],
      ["src/app/handler.ts", "code", 30, 60],
      ["src/app/router.ts", "code", 1, 40],
      ["docs/architecture.md", "doc", 1, 200],
    ]),
    manifests: [
      {
        path: "package.json",
        raw_body: '{\n  "name": "widgets"\n}',
        fetch_status: "success",
        detected_ecosystem: "npm",
        byte_length: 24,
      },
      { path: "go.mod", fetch_status: "not_found", detected_ecosystem: "go" },
    ],
    tool_statuses: [toolStatus("ruff", "completed", 3, 7), toolStatus("eslint", "timed_out", 1, 8)],
    ...overrides,
  };
}

/** A rich per-chunk context: every per-chunk/per-file field populated. */
function richChunkContext(args: {
  pr?: Record<string, unknown>;
  chunkOverrides?: Record<string, unknown>;
  perChunk?: Record<string, unknown>;
}): ReviewContextV1 {
  return ReviewContextV1.parse({
    ...prLevelFields(args.pr ?? {}),
    chunk: chunk(args.chunkOverrides ?? {}),
    retrieved_knowledge: [
      knowledgeChunk("docs/architecture.md", ["Overview", "Goals"], "Architectural overview body."),
    ],
    retrieved_evidence: [
      evidence("chunk_body", "src/app/handler.ts", "The handler returns a bare Response."),
    ],
    matched_path_instructions: [
      { path: "src/**", instructions: "Prefer Response.json over new Response." },
    ],
    prior_findings: [
      {
        file: "src/app/handler.ts",
        start_line: 11,
        end_line: 12,
        severity: "issue",
        category: "bug",
        title: "Missing null check",
        body: "Body text.",
        confidence: 0.9,
      },
    ],
    applicable_policy: {
      changed_path: "src/app/handler.ts",
      applicable_rules: [
        {
          rule: rule("R-1", "src/app", "Never use <eval> & raw new Response().", ["Rules"]),
          sources: [rule("R-1", "src/app", "Never use <eval> & raw new Response().", ["Rules"])],
        },
      ],
      resolution_explanation: ["R-1 nearest-ancestor"],
    },
    removed_or_changed_symbols: [
      {
        target_symbol_id: "99999999-9999-4999-8999-999999999999",
        qualified_name: "app.handler",
        change_kind: "signature_changed",
        new_signature: "(req: Request, ctx: Ctx) => Response",
      },
    ],
    consumer_hits: [
      {
        consumer_repo_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        consumer_relative_path: "svc/caller.ts",
        consumer_line: 14,
        confidence: "high",
        excerpt: "handler(req)",
      },
    ],
    tier1_findings: [
      {
        finding_id: "77777777-7777-4777-8777-777777777777",
        tool: "ruff",
        rule_id: "E501",
        file: "src/app/handler.ts",
        start_line: 11,
        end_line: 11,
        severity_raw: "warning",
        message: "line too long",
      },
    ],
    retrieval_degraded: true,
    retrieval_degradation_reason: "dense index timed out",
    ...(args.perChunk ?? {}),
  });
}

/** A second chunk of the SAME review: every per-chunk field differs from richChunkContext's. */
function siblingChunkContext(): ReviewContextV1 {
  return richChunkContext({
    chunkOverrides: {
      path: "src/app/router.ts",
      language: "typescript",
      start_line: 1,
      end_line: 40,
      body: "export const route = (p: string): string => p.toLowerCase();",
      chunk_kind: "module",
      token_estimate: 17,
    },
    perChunk: {
      retrieved_knowledge: [
        knowledgeChunk("src/app/router.ts", [], "Router conventions doc — keep routes flat."),
      ],
      retrieved_evidence: [evidence("retrieved_knowledge", "src/app/router.ts", "Routes are flat.")],
      matched_path_instructions: [],
      prior_findings: [],
      applicable_policy: {
        changed_path: "src/app/router.ts",
        applicable_rules: [
          {
            rule: rule("R-9", "src", "Never build routes from user input.", ["Routing"]),
            sources: [rule("R-9", "src", "Never build routes from user input.", ["Routing"])],
          },
        ],
        resolution_explanation: ["R-9 ancestor"],
      },
      removed_or_changed_symbols: [],
      consumer_hits: [],
      tier1_findings: [],
      retrieval_degraded: false,
      retrieval_degradation_reason: "",
    },
  });
}

// ── the W2.2 pin: stable prefix is BYTE-IDENTICAL across chunks ──────────────────────────────────

describe("buildCachedReviewPrompt — stable prefix byte-identity across chunks (the W2.2 pin)", () => {
  it("two chunks of the same review (every per-chunk field different) share an IDENTICAL stablePrefix", () => {
    const a = buildCachedReviewPrompt(richChunkContext({}));
    const b = buildCachedReviewPrompt(siblingChunkContext());
    expect(a.stablePrefix).toBe(b.stablePrefix);
    // ... and the per-chunk halves genuinely differ (the split is not degenerate).
    expect(a.chunkSuffix).not.toBe(b.chunkSuffix);
  });

  it("tier-3 manifests (>80 chunks): cited-path retention must NOT leak per-chunk retrieval into the prefix", () => {
    const entries: Array<readonly [string, string, number, number]> = [];
    for (let i = 0; i < 100; i += 1) {
      const dir = i % 3 === 0 ? "src" : i % 3 === 1 ? "lib" : "pkg";
      entries.push([`${dir}/file_${String(i).padStart(3, "0")}.ts`, "code", 1, 5] as const);
    }
    const big = { pr_topology_manifest: topology(entries) };
    const a = buildCachedReviewPrompt(
      richChunkContext({
        pr: big,
        chunkOverrides: { path: "src/file_000.ts" },
        perChunk: {
          retrieved_knowledge: [knowledgeChunk("lib/file_001.ts", [], "Cited library doc.")],
        },
      }),
    );
    const b = buildCachedReviewPrompt(
      richChunkContext({
        pr: big,
        chunkOverrides: { path: "pkg/file_002.ts" },
        perChunk: {
          retrieved_knowledge: [knowledgeChunk("pkg/file_005.ts", [], "Different cited doc.")],
        },
      }),
    );
    expect(a.stablePrefix).toBe(b.stablePrefix);
  });

  it("manifest array ORDER does not perturb the prefix bytes (sorted render, no iteration-order leak)", () => {
    const entries: Array<readonly [string, string, number, number]> = [
      ["src/app/handler.ts", "code", 10, 22] as const,
      ["src/app/router.ts", "code", 1, 40] as const,
      ["docs/architecture.md", "doc", 1, 200] as const,
    ];
    const reversed = [...entries].reverse();
    const a = buildCachedReviewPrompt(
      richChunkContext({ pr: { pr_topology_manifest: topology(entries) } }),
    );
    const b = buildCachedReviewPrompt(
      richChunkContext({ pr: { pr_topology_manifest: topology(reversed) } }),
    );
    expect(a.stablePrefix).toBe(b.stablePrefix);
  });

  it("is deterministic: the same context renders byte-identically twice", () => {
    const ctx = richChunkContext({});
    const a = buildCachedReviewPrompt(ctx);
    const b = buildCachedReviewPrompt(ctx);
    expect(a.stablePrefix).toBe(b.stablePrefix);
    expect(a.chunkSuffix).toBe(b.chunkSuffix);
  });

  it("the stable prefix carries NO per-chunk bytes (markers, chunk body, per-chunk knowledge)", () => {
    const ctx = richChunkContext({});
    const { stablePrefix } = buildCachedReviewPrompt(ctx);
    expect(stablePrefix).not.toContain("← THIS CHUNK");
    expect(stablePrefix).not.toContain("← contains THIS CHUNK");
    expect(stablePrefix).not.toContain("Current chunk:");
    expect(stablePrefix).not.toContain(ctx.chunk.body);
    expect(stablePrefix).not.toContain("Architectural overview body.");
  });
});

// ── stable→variable ordering: PR context first, diff LAST ────────────────────────────────────────

describe("buildCachedReviewPrompt — block placement", () => {
  it("stablePrefix = PR header + chunk-independent PR scope + project manifests", () => {
    const { stablePrefix } = buildCachedReviewPrompt(richChunkContext({}));
    expect(stablePrefix).toContain("# pull request: acme/widgets");
    expect(stablePrefix).toContain("## title\nRefactor request handling");
    expect(stablePrefix).toContain("## description\nMulti-file refactor of the handler pipeline.");
    expect(stablePrefix).toContain("## PR scope (you are reviewing 1 chunk of 4;");
    expect(stablePrefix).toContain("- src/app/handler.ts [code] (2 chunks)");
    expect(stablePrefix).toContain("Do NOT infer absence of code, files, or PR scope");
    expect(stablePrefix).toContain("## Project manifests");
    expect(stablePrefix).toContain('<manifest trust="untrusted">');
  });

  it("chunkSuffix carries every per-chunk block, with the diff as the LAST block", () => {
    const ctx = richChunkContext({});
    const { chunkSuffix } = buildCachedReviewPrompt(ctx);

    // every per-chunk block present
    expect(chunkSuffix).toContain('<policy rule_id="R-1"');
    expect(chunkSuffix).toContain("Architectural overview body.");
    expect(chunkSuffix).toContain("<!-- retrieval degraded: dense index timed out -->");
    expect(chunkSuffix).toContain("# cross-repo consumers");
    expect(chunkSuffix).toContain("## Evidence manifest");
    expect(chunkSuffix).toContain("Static analysis has already produced the following findings");
    expect(chunkSuffix).toContain("<tool_statuses>");
    expect(chunkSuffix).toContain("<arbitration_instructions>");
    expect(chunkSuffix).toContain("## team-specific guidance for this file");
    expect(chunkSuffix).toContain("## prior findings (do not repeat)");

    // ordering: policy precedes knowledge precedes the diff; the diff is the FINAL block.
    const policyAt = chunkSuffix.indexOf('<policy rule_id="R-1"');
    const knowledgeAt = chunkSuffix.indexOf("Architectural overview body.");
    const chunkHeaderAt = chunkSuffix.indexOf("## chunk: src/app/handler.ts (lines 10-22");
    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(knowledgeAt).toBeGreaterThan(policyAt);
    expect(chunkHeaderAt).toBeGreaterThan(knowledgeAt);
    // the prompt ENDS with the chunk body inside its untrusted wrapper — the per-chunk diff LAST.
    expect(chunkSuffix.endsWith(`${ctx.chunk.body}${CLOSE_TRUSTED_SUFFIX}`)).toBe(true);
  });

  it("chunk header renders language=unknown for a null language (legacy formatting preserved)", () => {
    const ctx = richChunkContext({ chunkOverrides: { language: null } });
    const { chunkSuffix } = buildCachedReviewPrompt(ctx);
    expect(chunkSuffix).toContain(
      "## chunk: src/app/handler.ts (lines 10-22, language=unknown, kind=function)",
    );
  });

  it("minimal context: empty optional blocks render nothing extra, diff still last", () => {
    const ctx = ReviewContextV1.parse({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Tiny",
      pr_description: "One chunk.",
      chunk: chunk({}),
      policy_revision: 0,
    });
    const { stablePrefix, chunkSuffix } = buildCachedReviewPrompt(ctx);
    expect(stablePrefix).toContain("# pull request: acme/widgets");
    expect(stablePrefix).not.toContain("## PR scope");
    expect(stablePrefix).not.toContain("## Project manifests");
    expect(chunkSuffix).not.toContain("## team-specific guidance");
    expect(chunkSuffix).not.toContain("## prior findings");
    expect(chunkSuffix.endsWith(`${ctx.chunk.body}${CLOSE_TRUSTED_SUFFIX}`)).toBe(true);
  });
});

// ── content parity with the legacy assembly (reordered, never gained/lost) ───────────────────────

describe("buildCachedReviewPrompt — no content gained or lost vs buildUserMessage", () => {
  it("every legacy block marker appears exactly once across stablePrefix + chunkSuffix", () => {
    const ctx = richChunkContext({});
    const legacy = buildUserMessage(ctx);
    const { stablePrefix, chunkSuffix } = buildCachedReviewPrompt(ctx);
    const combined = `${stablePrefix}\n\n${chunkSuffix}`;

    const markers = [
      "# pull request: acme/widgets",
      "## title",
      "## description",
      "## PR scope (you are reviewing 1 chunk of 4;",
      "## Project manifests",
      '<policy rule_id="R-1"',
      "Architectural overview body.",
      "# cross-repo consumers",
      "## Evidence manifest",
      "Static analysis has already produced the following findings",
      "<tool_statuses>",
      "<arbitration_instructions>",
      "## team-specific guidance for this file",
      "## prior findings (do not repeat)",
      "## chunk: src/app/handler.ts (lines 10-22",
    ];
    for (const marker of markers) {
      expect(legacy, `legacy lost marker ${marker}`).toContain(marker);
      const first = combined.indexOf(marker);
      expect(first, `cached assembly lost marker ${marker}`).toBeGreaterThanOrEqual(0);
      expect(
        combined.indexOf(marker, first + 1),
        `cached assembly duplicated marker ${marker}`,
      ).toBe(-1);
    }
    // the chunk body appears exactly once, in the suffix.
    expect(combined.indexOf(ctx.chunk.body)).toBe(combined.lastIndexOf(ctx.chunk.body));
  });

  it("budget enforcement still runs in the split builder (overflow style rule dropped, security kept)", () => {
    // Three ~990-token style rules + the security rule overflow the 3000-token policy budget: the
    // greedy fill keeps SEC-1 (forbid/security ranks first) + STY-1 + STY-2 and DROPS STY-3.
    const styleBody = "Prefer composition over inheritance. " + "t".repeat(3_900);
    const styleRule = (id: string): Record<string, unknown> => ({
      ...rule(id, "src", styleBody, ["Style"]),
      category: "style",
      intent: "recommend",
      priority: 20,
    });
    const ctx = richChunkContext({
      perChunk: {
        budget_enforcement: true,
        applicable_policy: {
          changed_path: "src/app/handler.ts",
          applicable_rules: [
            {
              rule: rule("SEC-1", "src/app", "Never call eval() on untrusted input.", ["Security"]),
              sources: [
                rule("SEC-1", "src/app", "Never call eval() on untrusted input.", ["Security"]),
              ],
            },
            { rule: styleRule("STY-1"), sources: [styleRule("STY-1")] },
            { rule: styleRule("STY-2"), sources: [styleRule("STY-2")] },
            { rule: styleRule("STY-3"), sources: [styleRule("STY-3")] },
          ],
          resolution_explanation: ["SEC-1", "STY-1", "STY-2", "STY-3"],
        },
      },
    });
    const { chunkSuffix } = buildCachedReviewPrompt(ctx);
    expect(chunkSuffix).toContain('<policy rule_id="SEC-1"');
    expect(chunkSuffix).toContain('<policy rule_id="STY-1"');
    expect(chunkSuffix).not.toContain('<policy rule_id="STY-3"');
  });
});
