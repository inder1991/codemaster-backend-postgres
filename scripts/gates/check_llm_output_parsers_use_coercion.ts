// LLM-output-parser coercion gate (ts-morph port of the frozen Python gate
// vendor/codemaster-py/scripts/check_llm_output_parsers_use_coercion.py).
//
// For every `<Contract>.parse(<payload>)` / `<Contract>.safeParse(<payload>)` call in production
// source where `<Contract>` is a registered LLM-output contract, the gate requires a preceding
// (strictly earlier line) `coerceForContract(<payload>, <Contract>, ...)` binding in the SAME
// function body. Closes the loophole the 2026-05-17 LLM-output resilience plan documents: LLM-output
// drift on string-length constraints must NEVER crash the parser; the platform-mandated boundary is
// the `coerceForContract` helper (apps/backend/src/llm/contract_coercion.ts — the 1:1 port of the
// Python `coerce_for_contract`, same payload-then-schema positional shape).
//
// REGISTERED LLM-OUTPUT CONTRACTS — ported VERBATIM from the Python gate's LLM_OUTPUT_CONTRACTS
// frozenset (the gate's durable artifact). Future contracts that come from LLM output (any new
// tool_use parser) add their schema's exported name here; the gate then forces every new parser to
// route through coercion. Removal must be ADR-justified. NON-LLM contracts are NOT subject to this
// gate: webhook / DB-loaded contracts hard-fail on shape mismatch by design (different threat model
// — they're not from a non-deterministic source).
//
// PYTHON → ZOD (v3) ADAPTATIONS
// -----------------------------
// The Python gate AST-matches Pydantic's `<C>.model_validate(payload)`. The Zod v3 equivalents and
// the deliberate divergences:
//
//  1. `model_validate` → the Zod validation surface: `.parse` / `.safeParse` (+ the async forms).
//     `safeParse` is gated too — the registered TS parsers (tool_schema.ts, walkthrough_schema.ts,
//     curator_schema.ts) safeParse AFTER coercion so length drift is truncated rather than turned
//     into a dropped block; an uncoerced safeParse re-opens the smoke-#7 degraded-review class.
//  2. `coerce_for_contract(payload, C, ...)` → `coerceForContract(payload, C, ...)` — schema is the
//     2nd positional in both. Only the bare-identifier helper name is matched (the convention across
//     the registered parser sites is to import the helper by name), mirroring the Python gate's
//     bare-Name-only `_is_coerce_call`.
//  3. CONSTRUCTOR IDIOM: Pydantic keyword-construction `C(field=...)` is structurally invisible to
//     the Python gate (it only matches `model_validate`). Zod has no separate constructor — passing
//     an INLINE OBJECT LITERAL to `.parse({...})` is how the codebase builds a validated instance
//     from already-typed parts (curator autoPromote, ReviewChunkResponseV1 envelope assembly,
//     synthesized config-notice findings, DB-row hydration in review_findings_repo). Object-literal
//     arguments are therefore NOT gated — the faithful port of the Python's constructor blindness.
//  4. Any OTHER non-identifier payload (property access, call expression, no argument) is
//     conservatively rejected, exactly like the Python's non-Name first-positional rule: the gate
//     cannot reason about such payloads, and real LLM-output parsers always bind the payload to a
//     name first. By-design revalidation sites land in EXEMPTED instead (see below).
//  5. Function-body scoping mirrors the Python walker: a coerce binding in an OUTER function does
//     NOT cover a parse call in a NESTED function (nested functions get their own context). Python
//     lambdas are transparent to the walker (`visit_Lambda` → `generic_visit`); the TS analogue is
//     the concise-body arrow (expression body) — transparent. Block-body arrows are full nested
//     functions — their own context, like a nested `def`. Module-scope parse calls are not walked
//     (the Python iterates function bodies only).
//  6. Scope: the Python's `codemaster/` (production-only) → `{libs,apps}/<pkg>/src/**` excluding
//     `*.test.ts`, matching the sibling gates (check_clock_random.ts).
//
// EXEMPTED registry — key shape `"<repo-relative path>::<line>"` (line of the `.parse(...)` call,
// NOT the function definition), each entry carrying `symbol` + `reason` + `follow_up_story` per
// S23.AR.17 P-2 rotation discipline. `PERMANENT-EXEMPTION-*` marks by-design revalidations of
// already-coerced content — the same class as the Python gate's day-one workflow-body
// `PERMANENT-EXEMPTION-activity-result-revalidation` entries. The exempted-lists-pointed and
// rotation-age meta-gates walk this object automatically (they scan every top-level `EXEMPTED`).
//
// Mode: ERROR (matches the frozen Python gate). Any unexempted bypass returns 1.
import * as path from "node:path";

import { type CallExpression, Node, Project, type SourceFile, SyntaxKind } from "ts-morph";

// ── Registered LLM-output contracts (ported VERBATIM from the Python frozenset) ──────────────────
export const LLM_OUTPUT_CONTRACTS: ReadonlySet<string> = new Set([
  "WalkthroughV1",
  "ReviewFindingV1",
  // Listed for future additions. Today the contract has zero max-length string fields; coerce is a
  // no-op. The gate still forces parsers to route through it, so the FIRST new `.max()` addition
  // inherits coverage automatically. (The live TS site — review_activity.ts envelope assembly — is
  // the constructor idiom and not gated; see adaptation 3.)
  "ReviewChunkResponseV1",
  // Phase D deferred (per the Python plan audit, 2026-05-17). Listed so any parser lands with
  // coerce coverage on day one — the TS tool_schema.ts intent branch already complies.
  "ArbitrationIntentV1",
]);

/** The Zod validation methods gated as the `model_validate` equivalents (see adaptation 1). */
const PARSE_METHODS: ReadonlySet<string> = new Set([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
]);

/** The sanctioned coercion helper, matched by bare identifier name only (adaptation 2). */
const COERCE_HELPER = "coerceForContract";

// ── EXEMPTED registry ─────────────────────────────────────────────────────────────────────────────
//
// Day-one entries: the two `ReviewWalkthroughsRepo` sites that revalidate a WalkthroughV1 across
// the Postgres JSONB round-trip. The LLM-output side already ran `coerceForContract` inside
// `parseWalkthrough` (apps/backend/src/review/walkthrough_schema.ts:125) before the value ever
// reached the repo. These sites are NOT LLM-output parsers; they're DB-roundtrip revalidation —
// the exact class the Python gate's docstring carves out ("DB-loaded contracts hard-fail on shape
// mismatch by design") and permanently exempts at its own workflow-body revalidation sites.
export type ExemptedEntry = {
  symbol: string;
  reason: string;
  /** Story id (S\d+\.[A-Z]+\.\d+ / S\d+\.X-<slug>) or PERMANENT-EXEMPTION-* for by-design sites. */
  follow_up_story: string;
};

export const EXEMPTED: Record<string, ExemptedEntry> = {
  "apps/backend/src/domain/repos/review_walkthroughs_repo.ts::132": {
    symbol: "ReviewWalkthroughsRepo.upsert",
    follow_up_story: "PERMANENT-EXEMPTION-db-roundtrip-revalidation",
    reason:
      "Write-path defensive revalidation of an already-typed WalkthroughV1 before JSONB " +
      "serialisation (the analogue of Python's `walkthrough.model_dump_json()`, which performs no " +
      "validation at all). The payload was coerced + validated by parseWalkthrough " +
      "(walkthrough_schema.ts) when first parsed from LLM output; coerce here would be a no-op.",
  },
  "apps/backend/src/domain/repos/review_walkthroughs_repo.ts::170": {
    symbol: "ReviewWalkthroughsRepo.get",
    follow_up_story: "PERMANENT-EXEMPTION-db-roundtrip-revalidation",
    reason:
      "Read-path re-deserialisation of the persisted walkthrough from Postgres JSONB (the analogue " +
      "of Python's `WalkthroughV1.model_validate_json(...)` on a DB row). Strings were coerced " +
      "within max-length BEFORE persist, so this is not an LLM-output parse — the DB-loaded " +
      "revalidation class the frozen Python gate permanently exempts by design.",
  },
};

/** One LLM-output-parser bypass finding (mirrors the Python `Violation` dataclass). */
export type Violation = {
  /** Repo-relative POSIX path of the offending file. */
  file: string;
  /** 1-based line number of the offending `.parse(...)` call. */
  line: number;
  /** The registered LLM-output contract being validated. */
  contract: string;
  /** The Zod method used (`parse` / `safeParse` / ...). */
  method: string;
  /** The payload identifier, or `"<non-name>"` for conservatively rejected shapes. */
  payloadArg: string;
};

/** Production source files the gate walks: {libs,apps}/<pkg>/src/**, excluding *.test.ts. */
export function isProductionSource(absPath: string): boolean {
  const rel = toRepoRelPosix(absPath);
  if (rel.endsWith(".test.ts")) return false;
  if (!rel.endsWith(".ts")) return false;
  return /^(?:libs|apps)\/[^/]+\/src\//.test(rel);
}

/**
 * Repo-relative POSIX path, anchored on the `libs/` or `apps/` segment so the predicate (and the
 * EXEMPTED keys) are identical for the real tree, the ts-morph in-memory FS, and already-relative
 * inputs. Copied from the sibling check_clock_random.ts.
 */
function toRepoRelPosix(absPath: string): string {
  const posix = absPath.split(path.sep).join("/");
  const match = /(?:^|\/)((?:libs|apps)\/.*)$/.exec(posix);
  if (match) return match[1]!;
  const rel = path.isAbsolute(absPath) ? path.relative(process.cwd(), absPath) : absPath;
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * The nearest enclosing function context, or undefined at module scope. Concise-body arrows are
 * TRANSPARENT (the Python walker generic_visits lambdas as part of the enclosing def); block-body
 * arrows and every declared function/method form are their own context (adaptation 5).
 */
function enclosingFunctionContext(node: Node): Node | undefined {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (isFunctionContext(current)) return current;
    current = current.getParent();
  }
  return undefined;
}

function isFunctionContext(node: Node): boolean {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    return true;
  }
  if (Node.isArrowFunction(node)) return Node.isBlock(node.getBody());
  return false;
}

/** A Name known to hold coerced output for a contract, from `line` onward, within `fn`. */
type CoerceBinding = {
  /** The enclosing function context's compiler node (undefined at module scope). */
  fn: unknown;
  boundName: string;
  contract: string;
  line: number;
};

/**
 * Collect every coerce-output binding in `sf` — both shapes the registered parser sites use
 * (mirroring the Python visit_Assign / visit_AnnAssign):
 *
 *   1. `const coerced = coerceForContract(payload, C, ...)`  — declaration binding.
 *   2. `payload = coerceForContract(payload, C, ...)`        — in-place rebind.
 *
 * A bare un-bound `coerceForContract(...)` call is a no-op for the gate: coerce returns a NEW
 * object and does not mutate its input, so the result must be captured. Destructuring / other
 * exotic targets are not matched — rare, and the gate prefers explicit coverage over false
 * negatives (verbatim Python policy).
 */
function collectCoerceBindings(sf: SourceFile): Array<CoerceBinding> {
  const bindings: Array<CoerceBinding> = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== COERCE_HELPER) continue;
    const args = call.getArguments();
    const second = args[1];
    if (second === undefined || !Node.isIdentifier(second)) continue; // schema must be a bare Name
    const contract = second.getText();

    const bound = boundNameFor(call);
    if (bound === undefined) continue; // un-captured call — no-op for the gate
    bindings.push({
      fn: enclosingFunctionContext(call)?.compilerNode,
      boundName: bound.name,
      contract,
      line: bound.bindNode.getStartLineNumber(),
    });
  }
  return bindings;
}

/** The single-Name binding target of a coerce call, or undefined (matches the Python shapes). */
function boundNameFor(call: CallExpression): { name: string; bindNode: Node } | undefined {
  const parent = call.getParent();
  if (parent === undefined) return undefined;
  // Shape 1: `const coerced = coerceForContract(...)` (type annotations included — TS AnnAssign).
  if (Node.isVariableDeclaration(parent)) {
    const nameNode = parent.getNameNode();
    if (Node.isIdentifier(nameNode)) return { name: nameNode.getText(), bindNode: parent };
    return undefined;
  }
  // Shape 2: `payload = coerceForContract(...)` — in-place rebind.
  if (
    Node.isBinaryExpression(parent) &&
    parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
    parent.getRight() === call
  ) {
    const left = parent.getLeft();
    if (Node.isIdentifier(left)) return { name: left.getText(), bindNode: parent };
  }
  return undefined;
}

/**
 * True iff a coerce-output binding precedes (strictly earlier line) the parse call, in the SAME
 * function context, binding the SAME Name for the SAME contract — the Python
 * `_has_preceding_coerce_binding`, all three conditions verbatim.
 */
function hasPrecedingCoerceBinding(
  bindings: ReadonlyArray<CoerceBinding>,
  fn: unknown,
  payloadArg: string,
  contract: string,
  parseLine: number,
): boolean {
  return bindings.some(
    (b) =>
      b.fn === fn && b.line < parseLine && b.boundName === payloadArg && b.contract === contract,
  );
}

/** Pure finder: every registered-contract parse site lacking its preceding coerce binding. */
export function findCoercionViolations(project: Project): Array<Violation> {
  const out: Array<Violation> = [];
  for (const sf of project.getSourceFiles()) {
    if (!isProductionSource(sf.getFilePath())) continue;
    const text = sf.getFullText();
    let mentionsContract = false;
    for (const contract of LLM_OUTPUT_CONTRACTS) {
      if (text.includes(contract)) {
        mentionsContract = true;
        break;
      }
    }
    if (!mentionsContract) continue;
    collectFileViolations(sf, toRepoRelPosix(sf.getFilePath()), out);
  }
  return out;
}

function collectFileViolations(sf: SourceFile, rel: string, out: Array<Violation>): void {
  const bindings = collectCoerceBindings(sf);

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    // `<Contract>.<parseMethod>(...)` — receiver must be a bare Identifier (the Python
    // `_attr_target_name` Name-only rule; attribute chains are not matched).
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName();
    if (!PARSE_METHODS.has(method)) continue;
    const receiver = callee.getExpression();
    if (!Node.isIdentifier(receiver)) continue;
    const contract = receiver.getText();
    if (!LLM_OUTPUT_CONTRACTS.has(contract)) continue;

    // Function bodies only — module-scope calls are not walked (the Python iterates
    // `_function_bodies`; see adaptation 5).
    const fn = enclosingFunctionContext(call);
    if (fn === undefined) continue;

    const first = call.getArguments()[0];
    // Constructor idiom: an inline object literal is built from already-typed parts — the Zod
    // analogue of Pydantic keyword-construction, which the Python gate never matches (adaptation 3).
    if (first !== undefined && Node.isObjectLiteralExpression(first)) continue;

    const line = call.getStartLineNumber();
    const payloadArg = first !== undefined && Node.isIdentifier(first) ? first.getText() : null;

    if (
      payloadArg !== null &&
      hasPrecedingCoerceBinding(bindings, fn.compilerNode, payloadArg, contract, line)
    ) {
      continue;
    }
    if (`${rel}::${line}` in EXEMPTED) continue;
    out.push({ file: rel, line, contract, method, payloadArg: payloadArg ?? "<non-name>" });
  }
}

/** CLI entry: emit H-16-format ERROR lines; return 1 on any violation (ERROR-mode). */
export function main(): number {
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  const violations = findCoercionViolations(project);

  if (violations.length === 0) {
    process.stdout.write(
      `[INFO] llm-output-parsers-use-coercion(ts): 0 violations ` +
        `(${Object.keys(EXEMPTED).length} exempted)\n`,
    );
    return 0;
  }

  for (const v of violations) {
    process.stderr.write(
      `[ERROR] file=${v.file}:${v.line} rule=llm-output-parser-bypasses-coercion ` +
        `message="${v.contract}.${v.method}(${v.payloadArg}) is not preceded by ` +
        `coerceForContract(${v.payloadArg}, ${v.contract}, ...) in the same function. ` +
        `LLM-output strings will crash on length-only validation errors. ` +
        `See docs/superpowers/plans/2026-05-17-llm-output-resilience.md." ` +
        `suggestion="Add: const coerced = coerceForContract(${v.payloadArg}, ${v.contract}, ` +
        `{ blockId }); then ${v.contract}.${v.method}(coerced) — or add to EXEMPTED with a ` +
        `follow_up_story."\n`,
    );
  }
  process.stderr.write(
    `[ERROR] llm-output-parsers-use-coercion(ts): ${violations.length} violation(s)\n`,
  );
  return 1; // ERROR-mode: block on any uncoerced LLM-output parse (matches the frozen Python gate).
}

// CLI shim: run main() when invoked directly (`npx tsx scripts/gates/check_llm_output_parsers_use_coercion.ts`).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
