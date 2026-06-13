// Activity/job-input JSON-safety gate (smoke-#10 dict[UUID, UUID] crash class).
//
// ── Why this gate exists (the Python incident, transposed) ──
// Temporal serializes every activity input through a JSON payload converter; the background/review
// job runner persists payloads into jsonb columns. Both are WIRE boundaries: a value that
// type-checks in-process but cannot survive `parse(JSON.parse(JSON.stringify(value)))` crashes (or
// silently corrupts) at DISPATCH, before the activity/handler body ever runs. The Python original
// caught `dict[UUID, UUID]` keys on `@activity.defn` Pydantic inputs; the TS equivalents of that
// crash class are:
//   * `z.date()`            — a validated Date serializes to an ISO STRING; re-parse rejects it.
//                             (`z.coerce.date()` is ALLOWED: coercion accepts the post-round-trip
//                             string — the documented row-contract idiom, e.g. background_job.v1.)
//   * `z.bigint()` / `z.coerce.bigint()` — JSON.stringify THROWS on bigint (producer-side crash).
//   * `z.map()` / `z.set()` — JSON.stringify(Map/Set) is "{}"; re-parse rejects it.
//   * `z.nan()`             — NaN serializes to null; re-parse rejects it.
//   * `z.undefined()`/`z.void()`/`z.symbol()`/`z.function()`/`z.promise()`/`z.instanceof(X)` —
//                             not representable in JSON at all (the background_jobs_repo.enqueue
//                             runtime guard's unsafe set, W4c.1 #9 — this gate is its STATIC half).
//   * `z.record(K, V)` with a non-string K — JSON object keys are strings; `z.record(z.number(),…)`
//                             re-parse fails on the stringified keys (the literal dict[UUID, UUID]
//                             analogue; apply_arbitration_input.v1 documents the str-key fix).
//   * plain-TS payload types with `Date` / `Map` / `Set` / `bigint` fields or `Record<K,…>` keyed
//                             by non-string — same round-trip failures, declared at the type level.
//
// ── Dispatch roots (what "reachable" means — the @activity.defn analogue) ──
// The Python gate walked Pydantic models reachable as the FIRST positional argument of an
// `@activity.defn` function. The TS surfaces it adapts onto:
//   (a) Temporal activity inputs — every EXPORTED function under apps/backend/src/activities/**
//       whose FIRST parameter is typed with a name imported from `#contracts/...` (ADR-0047 /
//       CLAUDE.md invariant 11: one typed positional input per activity). Helpers taking inline
//       `args: {...}` objects are not wire boundaries and are skipped, exactly as the Python gate
//       skipped unannotated/out-of-file inputs.
//   (b) background_jobs / review_jobs payloads — every `<Contract>.parse(...)` / `.safeParse(...)`
//       call under apps/backend/src/runner/** whose receiver is imported from `#contracts/...`
//       (the W2b opaque-payload posture: each handler owns parsing its payload with its OWN Zod
//       contract; review_jobs_repo parses ReviewPullRequestPayloadV1 at enqueue/verify).
// From each root the walker recurses through same-file declarations AND cross-file contract
// imports (`./sibling.v1.js`, `#contracts/x.v1.js`) — nesting at ANY depth is covered, mirroring
// the Python walker's recursion through list/tuple/Optional/Annotated/dict-value positions.
// Imports pointing OUTSIDE libs/contracts are not followed (the Python gate equally could not
// follow cross-module aliases); `z.lazy` self-references are cycle-guarded.
//
// ── Modes & escape hatches ──
// ERROR-mode: any violation returns 1. WARN is reserved for `z.record(K, V)` keys the gate cannot
// statically classify.
// Exemptions (S23.AR.17 P-2 rotation discipline — both forms require a follow-up):
//   * inline marker on the construct's line or the line above:
//       // json-safe:exempt reason=<short> follow_up=<story-id>
//   * an EXEMPTED entry keyed "<repo-relative contract path>::<SchemaName>" carrying
//     reason + follow_up_story (walked by check_exempted_lists_pointed / rotation-age meta-gates).
// Post-ADR-0034 note: the TS worker uses the default JSON-ish converter semantics for these
// surfaces, so this gate is load-bearing, not belt-and-suspenders.
import * as path from "node:path";

import {
  type CallExpression,
  type Identifier,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
} from "ts-morph";

/** Empty at landing — no production contract reachable from a dispatch boundary is JSON-unsafe.
 *  Shape matches the sibling gates (check_clock_random.ts) so the meta-gates
 *  (check_exempted_lists_pointed / check_exempted_rotation_age) walk it. Key shape:
 *  `"<repo-relative contract path>::<SchemaName>"`. New entries require reason + follow_up_story
 *  per S23.AR.17 P-2 rotation. Prefer the inline `// json-safe:exempt` marker for one-offs. */
export const EXEMPTED: Record<string, { reason: string; follow_up_story: string }> = {};

const RULE_ID = "activity_input_json_safe";

/** Inline exemption marker (same line as the construct, or the immediately preceding line). */
const MARKER_RE = /json-safe:exempt\s+reason=\S+\s+follow_up=\S+/;

/** Banned `z.<method>(...)` calls (receiver exactly `z`) → fix suggestion. `z.coerce.date()` is
 *  deliberately ABSENT: its output (Date) JSON-serializes to an ISO string that the coercion
 *  re-accepts, so it survives the round-trip — the row-contract idiom (background_job.v1.ts). */
const BANNED_Z_METHODS: ReadonlyMap<string, string> = new Map([
  [
    "date",
    "use z.coerce.date() (re-accepts the post-round-trip ISO string) or z.string().datetime({ offset: true }) for wire instants (the apply_arbitration_input.v1 idiom)",
  ],
  ["bigint", "JSON.stringify throws on bigint; carry a decimal z.string() (or z.number().int()) and convert at the edges"],
  ["map", "JSON.stringify(new Map()) is {}; model the wire shape as z.record(z.string(), V) and stringify keys at the call site"],
  ["set", "JSON.stringify(new Set()) is {}; model the wire shape as z.array(V) (dedupe at the consumer)"],
  ["nan", "NaN serializes to null; use z.number().finite() and encode the sentinel explicitly"],
  ["symbol", "symbols are not representable in JSON; restructure the field"],
  ["function", "functions are not representable in JSON; restructure the field"],
  ["promise", "promises are not representable in JSON; await and ship the resolved value"],
  ["undefined", "undefined is dropped by JSON.stringify (null inside arrays); use .optional() for key absence or .nullable()"],
  ["void", "undefined is dropped by JSON.stringify; use .optional() for key absence or .nullable()"],
  ["instanceof", "class instances do not survive a JSON round-trip (re-parse yields a plain object); model the wire shape structurally"],
]);

/** Banned plain-TS type references on payload types (the type-level half of the same set). */
const BANNED_TYPE_REFS: ReadonlySet<string> = new Set([
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ReadonlyMap",
  "ReadonlySet",
]);

/** One JSON-unsafe construct reachable from a dispatch boundary. */
export type Violation = {
  /** Repo-relative POSIX path of the file DECLARING the unsafe construct (usually a contract). */
  file: string;
  /** 1-based line of the construct. */
  line: number;
  /** Top-level declaration (schema/type) the construct lives in. */
  schema: string;
  /** Short label, e.g. "z.date()" or "Date (TS type)". */
  construct: string;
  /** The dispatch root that reaches it, e.g. "apps/backend/src/activities/x.activity.ts:90 fooActivity() → FooInputV1". */
  root: string;
  suggestion: string;
};

/** A site the gate cannot statically classify (z.record key behind an opaque expression). */
export type Warning = { file: string; line: number; schema: string; message: string };

/** One dispatch-boundary contract: where a payload crosses a JSON wire. */
export type DispatchRoot = { schemaName: string; contractFile: SourceFile; via: string };

export type GateResult = {
  errors: Array<Violation>;
  warnings: Array<Warning>;
  roots: Array<DispatchRoot>;
  exemptedCount: number;
};

// ── Path scoping (mirrors check_clock_random.ts) ────────────────────────────────────────────────

/** Repo-relative POSIX path anchored on the libs/ or apps/ segment (identical for the real tree,
 *  the ts-morph in-memory FS, and already-relative inputs — cwd differs, the anchor doesn't). */
function toRepoRelPosix(absPath: string): string {
  const posix = absPath.split(path.sep).join("/");
  const match = /(?:^|\/)((?:libs|apps)\/.*)$/.exec(posix);
  if (match) return match[1]!;
  const rel = path.isAbsolute(absPath) ? path.relative(process.cwd(), absPath) : absPath;
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

/** Temporal activity modules — surface (a). Tests are never dispatch roots. */
function isActivitySource(rel: string): boolean {
  return rel.startsWith("apps/backend/src/activities/") && rel.endsWith(".ts") && !rel.endsWith(".test.ts");
}

/** Background/review job runner modules — surface (b). */
function isRunnerSource(rel: string): boolean {
  return rel.startsWith("apps/backend/src/runner/") && rel.endsWith(".ts") && !rel.endsWith(".test.ts");
}

// ── Contract-import resolution (the gate's own resolver: no type-checker, works in-memory) ──────

/** Resolve an import specifier to a CONTRACT source file. Followed: `#contracts/<x>.js` (the
 *  package-imports alias for libs/contracts/src) and relative specifiers BETWEEN contract files.
 *  Anything else (zod, #platform, node:*) is out of scope — the Python gate equally refused to
 *  follow cross-module aliases. */
function resolveSpecifier(fromFile: SourceFile, spec: string): SourceFile | undefined {
  const project = fromFile.getProject();
  if (spec.startsWith("#contracts/")) {
    const suffix = "libs/contracts/src/" + spec.slice("#contracts/".length).replace(/\.js$/, ".ts");
    return project.getSourceFiles().find((sf) => sf.getFilePath().endsWith("/" + suffix));
  }
  if (spec.startsWith(".")) {
    const fromDir = path.posix.dirname(fromFile.getFilePath());
    const resolved = path.posix.join(fromDir, spec).replace(/\.js$/, ".ts");
    return project.getSourceFile(resolved);
  }
  return undefined;
}

/** Find the contract file (and original exported name) a local NAMED import binds to. */
function findContractImport(
  sf: SourceFile,
  localName: string,
): { file: SourceFile; exportedName: string } | undefined {
  for (const imp of sf.getImportDeclarations()) {
    for (const named of imp.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName();
      if (local !== localName) continue;
      const target = resolveSpecifier(sf, imp.getModuleSpecifierValue());
      if (target !== undefined) return { file: target, exportedName: named.getName() };
    }
  }
  return undefined;
}

// ── Dispatch-root discovery ─────────────────────────────────────────────────────────────────────

/** All identifier names referenced inside a type annotation (e.g. `FooInputV1`, the `T` of
 *  `ReadonlyArray<T>`). Non-contract names simply fail import resolution downstream. */
function typeReferenceNames(tn: TypeNode): Array<string> {
  const names: Array<string> = [];
  const all = Node.isIdentifier(tn)
    ? [tn]
    : tn.getDescendantsOfKind(SyntaxKind.Identifier);
  for (const id of all) names.push(id.getText());
  return names;
}

/** Surface (a): contracts typed as the FIRST parameter of an exported activity function. */
export function findActivityInputRoots(project: Project): Array<DispatchRoot> {
  const out: Array<DispatchRoot> = [];
  for (const sf of project.getSourceFiles()) {
    const rel = toRepoRelPosix(sf.getFilePath());
    if (!isActivitySource(rel)) continue;
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) continue;
      const first = fn.getParameters()[0];
      const tn = first?.getTypeNode();
      if (tn === undefined) continue;
      for (const name of typeReferenceNames(tn)) {
        const imp = findContractImport(sf, name);
        if (imp === undefined) continue;
        out.push({
          schemaName: imp.exportedName,
          contractFile: imp.file,
          via: `${rel}:${fn.getStartLineNumber()} ${fn.getName() ?? "<fn>"}()`,
        });
      }
    }
  }
  return out;
}

/** Surface (b): contracts whose `.parse(...)`/`.safeParse(...)` runs in the job runner (handler
 *  payload parses, review_jobs_repo enqueue/verifyPayload, background-job row contracts). */
export function findJobPayloadRoots(project: Project): Array<DispatchRoot> {
  const out: Array<DispatchRoot> = [];
  for (const sf of project.getSourceFiles()) {
    const rel = toRepoRelPosix(sf.getFilePath());
    if (!isRunnerSource(rel)) continue;
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const method = expr.getName();
      if (method !== "parse" && method !== "safeParse") continue;
      const recv = expr.getExpression();
      if (!Node.isIdentifier(recv)) continue;
      const imp = findContractImport(sf, recv.getText());
      if (imp === undefined) continue;
      out.push({
        schemaName: imp.exportedName,
        contractFile: imp.file,
        via: `${rel}:${call.getStartLineNumber()} ${recv.getText()}.${method}(...)`,
      });
    }
  }
  return out;
}

// ── The recursive walker ────────────────────────────────────────────────────────────────────────

type WalkCtx = {
  /** Declarations already walked, keyed `<path>::<name>` (cycle guard — z.lazy self-refs). */
  visited: Set<string>;
  /** Violation/warning dedupe, keyed `<file>:<line>:<construct>` (multi-root reachability). */
  seen: Set<string>;
  errors: Array<Violation>;
  warnings: Array<Warning>;
  exempted: Set<string>;
  /** The dispatch root currently being walked (stamped onto findings). */
  root: string;
};

/** Walk the named top-level declaration in `sf`: schema consts and helper functions walk their
 *  VALUE tree; plain type aliases walk their TYPE tree; named re-exports are followed. */
function walkNamedDecl(name: string, sf: SourceFile, ctx: WalkCtx): void {
  const key = `${sf.getFilePath()}::${name}`;
  if (ctx.visited.has(key)) return;
  ctx.visited.add(key);

  const varDecl = sf.getVariableDeclaration(name);
  if (varDecl !== undefined) {
    const init = varDecl.getInitializer();
    if (init !== undefined) walkValueNode(init, sf, name, ctx);
    return;
  }
  const fnDecl = sf.getFunction(name);
  if (fnDecl !== undefined) {
    walkValueNode(fnDecl, sf, name, ctx);
    return;
  }
  const alias = sf.getTypeAlias(name);
  if (alias !== undefined) {
    const tn = alias.getTypeNode();
    if (tn !== undefined) walkTypeNode(tn, sf, name, ctx);
    return;
  }
  // Named re-export (`export { X } from "./y.v1.js"`) — follow it.
  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec === undefined) continue;
    for (const named of exp.getNamedExports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName();
      if (local !== name) continue;
      const target = resolveSpecifier(sf, spec);
      if (target !== undefined) walkNamedDecl(named.getName(), target, ctx);
    }
  }
}

/** True iff `id` is a VALUE reference (not the name half of a property access/assignment,
 *  declaration, parameter, import/export specifier, or member signature). */
function isReferenceIdentifier(id: Identifier): boolean {
  const parent = id.getParent();
  if (parent === undefined) return false;
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() !== id;
  if (Node.isPropertyAssignment(parent)) return parent.getNameNode() !== id;
  if (Node.isShorthandPropertyAssignment(parent)) return true;
  if (Node.isParameterDeclaration(parent)) return false;
  if (Node.isBindingElement(parent)) return false;
  if (Node.isVariableDeclaration(parent)) return parent.getNameNode() !== id;
  if (Node.isFunctionDeclaration(parent)) return false;
  if (Node.isTypeAliasDeclaration(parent)) return false;
  if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent)) return false;
  if (Node.isMethodDeclaration(parent) || Node.isMethodSignature(parent)) return parent.getNameNode() !== id;
  if (Node.isPropertySignature(parent)) return parent.getNameNode() !== id;
  return true;
}

/** Walk a value expression tree (a Zod schema or helper): flag banned `z.*` calls, recurse into
 *  every referenced same-file/contract-imported declaration (nesting at any depth). */
function walkValueNode(node: Node, sf: SourceFile, schema: string, ctx: WalkCtx): void {
  const nodes: Array<Node> = [node, ...node.getDescendants()];
  for (const n of nodes) {
    if (Node.isCallExpression(n)) {
      const finding = classifyBannedZodCall(n);
      if (finding !== null) {
        if (finding.kind === "error") {
          report(n, sf, schema, finding.construct, finding.suggestion, ctx);
        } else {
          warn(n, sf, schema, finding.message, ctx);
        }
      }
    }
    if (Node.isIdentifier(n) && isReferenceIdentifier(n)) {
      resolveAndRecurse(n.getText(), sf, ctx);
    }
  }
}

/** Recurse into a referenced name: same-file top-level declaration first, else a contract import. */
function resolveAndRecurse(name: string, sf: SourceFile, ctx: WalkCtx): void {
  if (name === "z") return; // the zod namespace itself
  if (
    sf.getVariableDeclaration(name) !== undefined ||
    sf.getFunction(name) !== undefined ||
    sf.getTypeAlias(name) !== undefined
  ) {
    walkNamedDecl(name, sf, ctx);
    return;
  }
  const imp = findContractImport(sf, name);
  if (imp !== undefined) walkNamedDecl(imp.exportedName, imp.file, ctx);
}

type CallFinding =
  | { kind: "error"; construct: string; suggestion: string }
  | { kind: "warn"; message: string };

/** Classify one CallExpression against the banned-construct table. Whitespace-normalized receiver
 *  text keeps multi-line chains (`z\n.string()`) matching. */
function classifyBannedZodCall(call: CallExpression): CallFinding | null {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return null;
  const method = expr.getName();
  const receiver = expr.getExpression().getText().replace(/\s+/g, "");

  // z.coerce.bigint(): coercion cannot rescue bigint — JSON.stringify still throws on the OUTPUT.
  if (receiver === "z.coerce" && method === "bigint") {
    return { kind: "error", construct: "z.coerce.bigint()", suggestion: BANNED_Z_METHODS.get("bigint")! };
  }
  if (receiver !== "z") return null;

  const suggestion = BANNED_Z_METHODS.get(method);
  if (suggestion !== undefined) {
    return { kind: "error", construct: `z.${method}()`, suggestion };
  }
  if (method === "record") return classifyRecordCall(call);
  return null;
}

/** `z.record(V)` (implicit string keys) is fine; `z.record(K, V)` requires a string-shaped K. */
function classifyRecordCall(call: CallExpression): CallFinding | null {
  const args = call.getArguments();
  if (args.length < 2) return null;
  const key = args[0]!;
  const verdict = classifyRecordKeySchema(key, call.getSourceFile());
  if (verdict === "string") return null;
  const head = key.getText().replace(/\s+/g, "").slice(0, 40);
  if (verdict === "non-string") {
    return {
      kind: "error",
      construct: `z.record(${head}, …) non-string key`,
      suggestion:
        "JSON object keys are strings; use z.record(z.string()…, V) and stringify keys at the call site (the smoke-#10 dict[UUID,UUID] fix)",
    };
  }
  return {
    kind: "warn",
    message: `z.record key schema '${head}' is not statically verifiable as string-keyed; inline a z.string()-based key schema`,
  };
}

const STRINGISH_KEY_RE = /z\.(string\(|enum\(|literal\(["'`])/;
const NON_STRING_KEY_RE = /^z\.(number\(|boolean\(|bigint\(|date\(|nan\(|symbol\(|coerce\.)/;

/** Classify a record KEY schema expression: "string" (JSON-safe), "non-string" (refused), or
 *  "unknown" (opaque — WARN). Identifier / helper-call keys are resolved through same-file
 *  declarations and contract imports, then matched textually (the uuidLower()-style helper: its
 *  declaration text contains `z.string(`). */
function classifyRecordKeySchema(expr: Node, sf: SourceFile): "string" | "non-string" | "unknown" {
  const norm = expr.getText().replace(/\s+/g, "");
  if (/^z\.(string\(|enum\(|literal\(["'`])/.test(norm)) return "string";
  if (NON_STRING_KEY_RE.test(norm)) return "non-string";

  let name: string | undefined;
  if (Node.isIdentifier(expr)) name = expr.getText();
  else if (Node.isCallExpression(expr) && Node.isIdentifier(expr.getExpression())) {
    name = expr.getExpression().getText();
  }
  if (name !== undefined) {
    const declText = resolveDeclText(name, sf);
    if (declText !== undefined) {
      const dn = declText.replace(/\s+/g, "");
      if (NON_STRING_KEY_RE.test(dn.replace(/^[^=]*=>?/, ""))) return "non-string";
      if (STRINGISH_KEY_RE.test(dn)) return "string";
    }
  }
  return "unknown";
}

/** Text of the declaration `name` binds to (same file, or one contract-import hop). */
function resolveDeclText(name: string, sf: SourceFile): string | undefined {
  const local = sf.getVariableDeclaration(name) ?? sf.getFunction(name);
  if (local !== undefined) return local.getText();
  const imp = findContractImport(sf, name);
  if (imp === undefined) return undefined;
  const remote = imp.file.getVariableDeclaration(imp.exportedName) ?? imp.file.getFunction(imp.exportedName);
  return remote?.getText();
}

// ── Type-level walking (plain-TS payload types) ─────────────────────────────────────────────────

/** True iff a Record key TYPE argument is string-shaped (string keyword, string literal, template
 *  literal, or a union of those). */
function typeArgIsStringish(tn: TypeNode): boolean {
  if (tn.getKind() === SyntaxKind.StringKeyword) return true;
  if (tn.getKind() === SyntaxKind.TemplateLiteralType) return true;
  if (Node.isLiteralTypeNode(tn)) return Node.isStringLiteral(tn.getLiteral());
  if (Node.isUnionTypeNode(tn)) return tn.getTypeNodes().every((t) => typeArgIsStringish(t));
  return false;
}

/** Walk a type tree: flag Date/Map/Set/bigint-typed fields + Record keyed by non-string; recurse
 *  through same-file aliases, contract imports, and `typeof X` queries back into value schemas. */
function walkTypeNode(tn: TypeNode, sf: SourceFile, schema: string, ctx: WalkCtx): void {
  const nodes: Array<Node> = [tn, ...tn.getDescendants()];
  for (const n of nodes) {
    if (n.getKind() === SyntaxKind.BigIntKeyword) {
      report(n, sf, schema, "bigint (TS type)", BANNED_Z_METHODS.get("bigint")!, ctx);
      continue;
    }
    if (n.getKind() === SyntaxKind.SymbolKeyword) {
      report(n, sf, schema, "symbol (TS type)", "symbols are not representable in JSON; restructure the field", ctx);
      continue;
    }
    if (Node.isTypeQuery(n)) {
      // `z.infer<typeof X>` — hop back into the VALUE schema X.
      const en = n.getExprName();
      const name = Node.isQualifiedName(en) ? en.getRight().getText() : en.getText();
      resolveAndRecurse(name, sf, ctx);
      continue;
    }
    if (!Node.isTypeReference(n)) continue;
    const tnName = n.getTypeName();
    const name = Node.isQualifiedName(tnName) ? tnName.getRight().getText() : tnName.getText();
    if (BANNED_TYPE_REFS.has(name)) {
      report(
        n,
        sf,
        schema,
        `${name} (TS type)`,
        "Date/Map/Set instances do not survive a JSON round-trip; use ISO-string instants, Record<string, V>, or Array<V> on wire types",
        ctx,
      );
      continue;
    }
    if (name === "Record") {
      const keyArg = n.getTypeArguments()[0];
      if (keyArg !== undefined && !typeArgIsStringish(keyArg)) {
        report(
          n,
          sf,
          schema,
          `Record<${keyArg.getText()}, …> non-string key (TS type)`,
          "JSON object keys are strings; key wire Records by string and stringify at the call site",
          ctx,
        );
      }
      continue;
    }
    // A named type (possibly another contract) — follow it like the value walker follows schemas.
    resolveAndRecurse(name, sf, ctx);
  }
}

// ── Finding emission (marker + EXEMPTED escape hatches, multi-root dedupe) ──────────────────────

function hasInlineMarker(node: Node, sf: SourceFile): boolean {
  const line = node.getStartLineNumber(); // 1-based
  const lines = sf.getFullText().split("\n");
  return MARKER_RE.test(lines[line - 1] ?? "") || MARKER_RE.test(lines[line - 2] ?? "");
}

function report(node: Node, sf: SourceFile, schema: string, construct: string, suggestion: string, ctx: WalkCtx): void {
  const file = toRepoRelPosix(sf.getFilePath());
  const line = node.getStartLineNumber();
  if (hasInlineMarker(node, sf)) return;
  const exemptKey = `${file}::${schema}`;
  if (EXEMPTED[exemptKey] !== undefined) {
    ctx.exempted.add(exemptKey);
    return;
  }
  const dedupe = `${file}:${line}:${construct}`;
  if (ctx.seen.has(dedupe)) return;
  ctx.seen.add(dedupe);
  ctx.errors.push({ file, line, schema, construct, root: ctx.root, suggestion });
}

function warn(node: Node, sf: SourceFile, schema: string, message: string, ctx: WalkCtx): void {
  const file = toRepoRelPosix(sf.getFilePath());
  const line = node.getStartLineNumber();
  if (hasInlineMarker(node, sf)) return;
  const dedupe = `${file}:${line}:WARN:${message}`;
  if (ctx.seen.has(dedupe)) return;
  ctx.seen.add(dedupe);
  ctx.warnings.push({ file, line, schema, message });
}

// ── Public entry points ─────────────────────────────────────────────────────────────────────────

/** Pure finder: walk every dispatch root and return all JSON-unsafe findings. */
export function findJsonUnsafeViolations(project: Project): GateResult {
  const byKey = new Map<string, DispatchRoot>();
  for (const root of [...findActivityInputRoots(project), ...findJobPayloadRoots(project)]) {
    const key = `${root.contractFile.getFilePath()}::${root.schemaName}`;
    if (!byKey.has(key)) byKey.set(key, root);
  }
  const roots = [...byKey.values()];
  const ctx: WalkCtx = {
    visited: new Set(),
    seen: new Set(),
    errors: [],
    warnings: [],
    exempted: new Set(),
    root: "",
  };
  for (const root of roots) {
    ctx.root = `${root.via} → ${root.schemaName}`;
    walkNamedDecl(root.schemaName, root.contractFile, ctx);
  }
  return { errors: ctx.errors, warnings: ctx.warnings, roots, exemptedCount: ctx.exempted.size };
}

/** CLI entry: emit H-16-format lines; return 1 on any violation (ERROR-mode). */
export function main(): number {
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  const result = findJsonUnsafeViolations(project);

  for (const w of result.warnings) {
    process.stderr.write(
      `[WARN] file=${w.file}:${w.line} rule=${RULE_ID} ` +
        `message="schema ${w.schema}: ${w.message}" ` +
        'suggestion="inline a z.string()-based key schema so the gate can verify it"\n',
    );
  }
  if (result.exemptedCount > 0) {
    process.stderr.write(
      `[INFO] activity-input-json-safe(ts): ${result.exemptedCount} EXEMPTED site(s) skipped (each with follow_up_story)\n`,
    );
  }
  if (result.errors.length === 0) {
    process.stdout.write(
      `[INFO] activity-input-json-safe(ts): ${result.roots.length} dispatch root(s) walked; 0 violations\n`,
    );
    return 0;
  }
  for (const v of result.errors) {
    process.stderr.write(
      `[ERROR] file=${v.file}:${v.line} rule=${RULE_ID} ` +
        `message="${v.construct} in ${v.schema} (reachable from ${v.root}) cannot survive the JSON payload round-trip" ` +
        `suggestion="${v.suggestion}"\n`,
    );
  }
  process.stderr.write(`[ERROR] activity-input-json-safe(ts): ${result.errors.length} violation(s)\n`);
  return 1; // ERROR-mode: a JSON-unsafe dispatch contract is the smoke-#10 crash class.
}

// CLI shim: run main() when invoked directly (`npx tsx scripts/gates/check_activity_input_json_safe.ts`).
// The aggregate runner (run_all.ts) imports main() instead, so this branch is dormant there.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
