// Exempted-lists-pointed gate (ts-morph port of the frozen scripts/check_exempted_lists_pointed.py).
//
// Self-referential infrastructure validation: every AST-gate `EXEMPTED` entry must reference a
// follow-up story so an exemption can't sit forever and defeat the purpose of the gate.
//
// The Python gate AST-walks a fixed list of gate files for a top-level `EXEMPTED: dict = {...}`.
// The TS equivalent: gate files under scripts/gates/ export `EXEMPTED: Record<string, ExemptedEntry>`
// (the shape defined in scripts/gates/_registry.ts). For every property of that object literal,
// the entry value (itself an object literal) MUST carry a `follow_up_story` string property whose
// value matches the story-id pattern (sprint-aligned `S\d+\.[A-Z]+\.\d+`, hotfix `S\d+\.X-<slug>`,
// short-form `S\d+\.[A-Z]+`, or `PERMANENT-EXEMPTION-<slug>`).
//
// ERROR-mode (matches the frozen Python gate): any violation makes main() return 1. This is the
// rare-but-real ERROR-mode gate — it is NOT the WARN-mode GF-3 tenancy gate. Do NOT soften to WARN.
import { Node, type ObjectLiteralElementLike, Project, type SourceFile } from "ts-morph";

// Sprint-aligned IDs accept a single-letter area (`S16.A.1`, `S15.H`) or a multi-letter area code
// (`S23.AR.7`); hotfix IDs (`S15.X-token-provider`); or `PERMANENT-EXEMPTION-*` for by-design
// exemptions covered by sibling gates. Ported VERBATIM from the Python gate's _STORY_ID_RE.
const STORY_ID_RE = /^(S\d+\.([A-Z]+\.\d+|X-[\w-]+|[A-Z]+)|PERMANENT-EXEMPTION-[\w-]+)$/;

export type Violation = {
  file: string;
  /** The EXEMPTED entry key whose value is malformed. */
  key: string;
  /** Human-readable description of why the entry is malformed. */
  message: string;
}

/**
 * Find every malformed EXEMPTED entry across the project's gate files.
 *
 * Pure function over a ts-morph Project (mirrors findTenancyViolations). For each source file,
 * locate the top-level `EXEMPTED` variable initialized with an object literal, then validate each
 * property's value object carries a well-formed `follow_up_story`.
 */
export function findExemptedListsViolations(project: Project): Array<Violation> {
  const out: Array<Violation> = [];
  for (const sf of project.getSourceFiles()) {
    const exempted = extractExemptedObject(sf);
    if (exempted === undefined) continue; // No EXEMPTED export — different exclusion mechanism. Skip.
    const file = sf.getFilePath();
    for (const prop of exempted.getProperties()) {
      const entry = readEntry(prop);
      if (entry === undefined) continue; // spread / shorthand / non-literal key — skip silently (no key to report).
      const err = validateEntryValue(entry.value);
      if (err !== undefined) out.push({ file, key: entry.key, message: err });
    }
  }
  return out;
}

/** Locate the top-level `EXEMPTED = {...}` object-literal initializer in a source file. */
function extractExemptedObject(sf: SourceFile) {
  const decl = sf.getVariableDeclaration("EXEMPTED");
  if (decl === undefined) return undefined;
  const init = decl.getInitializer();
  if (init === undefined || !Node.isObjectLiteralExpression(init)) return undefined;
  return init;
}

/** Extract `{ key, value }` for a property assignment whose value is an expression node. */
function readEntry(
  prop: ObjectLiteralElementLike,
): { key: string; value: Node | undefined } | undefined {
  if (!Node.isPropertyAssignment(prop)) return undefined;
  const nameNode = prop.getNameNode();
  let key: string;
  if (Node.isStringLiteral(nameNode)) {
    key = nameNode.getLiteralValue();
  } else if (Node.isIdentifier(nameNode)) {
    key = nameNode.getText();
  } else {
    return undefined; // computed / numeric key — not part of the EXEMPTED string-keyed contract.
  }
  return { key, value: prop.getInitializer() };
}

/**
 * Return undefined when the entry value carries a well-formed `follow_up_story`; otherwise a
 * description of the violation. Mirrors the Python gate's _validate_entry_value.
 */
function validateEntryValue(value: Node | undefined): string | undefined {
  if (value === undefined || !Node.isObjectLiteralExpression(value)) {
    return "value is not an object literal";
  }
  const followUp = value.getProperty("follow_up_story");
  if (followUp === undefined) return "missing `follow_up_story` key";
  if (!Node.isPropertyAssignment(followUp)) {
    return "`follow_up_story` is not a string literal";
  }
  const init = followUp.getInitializer();
  if (init === undefined || !Node.isStringLiteral(init)) {
    return "`follow_up_story` is not a string literal";
  }
  const story = init.getLiteralValue();
  if (!STORY_ID_RE.test(story)) {
    return (
      `\`follow_up_story\` '${story}' doesn't match the ` +
      "story-id pattern S<N>.<area>.<n> or S<N>.X-<slug>"
    );
  }
  return undefined;
}

/** CLI entry: emit H-16-format ERROR lines; return 1 on any violation (ERROR-mode). */
export function main(): number {
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  const violations = findExemptedListsViolations(project);
  if (violations.length === 0) {
    process.stdout.write("[INFO] exempted-lists-pointed gate: ok\n");
    return 0;
  }
  for (const v of violations) {
    process.stderr.write(
      `[ERROR] file=${v.file} rule=exempted-lists-pointed ` +
        `message="EXEMPTED['${v.key}'] ${v.message}" ` +
        `suggestion="add a \`follow_up_story\` field with a well-formed story-id (e.g., \\"S17.X-some-fix\\")"\n`,
    );
  }
  process.stderr.write(
    `[ERROR] exempted-lists-pointed gate: ${violations.length} violation(s)\n`,
  );
  return 1; // ERROR-mode: block on drift (matches the frozen Python gate's behavior).
}
