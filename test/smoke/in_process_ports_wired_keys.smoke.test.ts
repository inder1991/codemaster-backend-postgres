// In-process-bundle wiring completeness (cutover smoke finding, 2026-06-11 — live PR #137):
// runner/in_process_ports.ts dereferences buildActivities() by STRING KEY (`baseFn("<name>")`).
// A renamed/mistyped key is a silent `undefined` until the port actually FIRES mid-review — the
// output-safety audit port was wired to "emitOutputSafetyAudit" while the bundle registers
// "emitOutputSafetyAuditEvent", so every live review of a secret-bearing PR died in the chunk
// fan-out with `base(...)[name] is not a function`, invisible to every stubbed-port test.
//
// This is the in-process analogue of the worker-registry-completeness gate class: every baseFn key
// in in_process_ports.ts must be a property key of the object literal buildActivities() returns.
// Static (ts-morph) like workflow_activity_registry.smoke.test.ts — no env, runs in every lane.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from "ts-morph";

const REPO = join(import.meta.dirname, "..", "..");

function load(path: string): SourceFile {
  const project = new Project({ tsConfigFilePath: join(REPO, "tsconfig.json"), skipAddingFilesFromTsConfig: true });
  return project.addSourceFileAtPath(join(REPO, path));
}

/** The string literal passed to every `baseFn("…")` call. */
function wiredKeys(sf: SourceFile): Array<string> {
  const keys: Array<string> = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== "baseFn") continue;
    const arg = call.getArguments()[0];
    const lit = arg?.asKind(SyntaxKind.StringLiteral);
    expect(lit, `baseFn called with a non-literal arg: ${call.getText()}`).toBeDefined();
    keys.push(lit!.getLiteralText());
  }
  return keys;
}

/** The property keys of the object literal `buildActivities` returns (the registry smoke's idiom). */
function bundleKeys(sf: SourceFile): Set<string> {
  const fn = sf.getFunctionOrThrow("buildActivities");
  let obj: ObjectLiteralExpression | undefined;
  for (const ret of fn.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    let expr = ret.getExpression();
    while (expr !== undefined && expr.getKind() === SyntaxKind.AsExpression) {
      expr = expr.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
    }
    obj = expr?.asKind(SyntaxKind.ObjectLiteralExpression) ?? obj;
  }
  expect(obj, "buildActivities must return an object literal").toBeDefined();
  const keys = new Set<string>();
  for (const prop of obj!.getProperties()) {
    if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
      keys.add(prop.asKindOrThrow(SyntaxKind.ShorthandPropertyAssignment).getName());
    } else if (prop.getKind() === SyntaxKind.PropertyAssignment) {
      const name = prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getNameNode();
      const strLit = name.asKind(SyntaxKind.StringLiteral);
      const computed = name.asKind(SyntaxKind.ComputedPropertyName);
      if (computed !== undefined) {
        const inner = computed.getExpression().asKind(SyntaxKind.StringLiteral);
        expect(inner, `non-literal computed key: ${prop.getText()}`).toBeDefined();
        keys.add(inner!.getLiteralText());
      } else {
        keys.add(strLit !== undefined ? strLit.getLiteralText() : name.getText());
      }
    } else {
      throw new Error(`unsupported property shape in buildActivities return: ${prop.getText()}`);
    }
  }
  return keys;
}

describe("in-process ports — every baseFn key exists on the buildActivities bundle", () => {
  it("no wired key is missing from the bundle (the PR #137 silent-undefined class)", () => {
    const wired = wiredKeys(load("apps/backend/src/runner/in_process_ports.ts"));
    expect(wired.length).toBeGreaterThan(10); // the extractor actually found the wiring
    const bundle = bundleKeys(load("apps/backend/src/worker/build_activities.ts"));
    const missing = wired.filter((k) => !bundle.has(k));
    expect(missing, `baseFn keys missing from buildActivities(): ${missing.join(", ")}`).toEqual([]);
  });
});
