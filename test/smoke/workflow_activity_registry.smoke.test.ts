/**
 * STRUCTURAL SMOKE — every workflow + every activity is WIRED (no `ActivityNotRegistered` /
 * `WorkflowNotRegistered` drift), across ALL dispatch code paths.
 *
 * ── Why STATIC (the crux) ──
 * `proxyActivities<{ camelName(input): Promise<…> }>()` encodes the dispatched activity NAME in a
 * COMPILE-TIME TYPE; the stub can only execute inside the Temporal V8-isolate workflow sandbox. So the set
 * of DISPATCHED activity names CANNOT be read at runtime — it must be extracted by STATIC AST analysis of
 * the workflow source. The REGISTERED activity names (the keys of `buildActivities()` / `buildOutboxActivities()`
 * return-object literals) and the SERVED workflow names (the exported function names of the bundles each
 * worker's `workflowsPath` points at) are likewise read STATICALLY from the source object/export shapes —
 * so this smoke needs NO env, NO DB, NO network, NO Temporal server. Pure ts-morph AST walk (the SAME
 * `ts-morph` idiom `scripts/gates/check_tenant_scoped_raw_sql.ts` uses).
 *
 * ── The three structural cross-checks ──
 *  A. Every DISPATCHED activity ∈ REGISTERED activities  (else `ActivityNotRegistered` at dispatch).
 *  B. Every STARTED workflow type ∈ SERVED workflows      (else `WorkflowNotRegistered` at start).
 *  C. Sanity/coverage: each extracted set is non-empty (guards a silent false-green from an extractor that
 *     matched nothing) and the counts are reported.
 *
 * ── Name matching ──
 * EXACT string equality (no lowercasing/normalization). The registered keys span BOTH camelCase
 * (`persistReviewFindings`, `bedrockReviewChunk`) AND snake_case Temporal names (`reconcile_installation_activity`,
 * `fetch_space_pages_activity`); the dispatched proxyActivities type-member names match those exactly. A
 * lenient match would defeat the whole point (catching a real `ActivityNotRegistered`).
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Node,
  Project,
  SyntaxKind,
  type ObjectLiteralExpression,
  type SourceFile,
  type TypeLiteralNode,
} from "ts-morph";
import { describe, expect, it } from "vitest";

// Repo root = three levels up from test/smoke/<this file>.
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const WORKFLOWS_DIR = join(REPO_ROOT, "apps", "backend", "src", "workflows");
const WORKER_DIR = join(REPO_ROOT, "apps", "backend", "src", "worker");
const INGEST_DIR = join(REPO_ROOT, "apps", "backend", "src", "ingest");

/**
 * Build the ts-morph project from the repo tsconfig (resolves the `#backend`/`#contracts` path aliases the
 * source uses) but do NOT load the WHOLE tree — add only the specific source files each extractor needs.
 * The default `tsConfigFilePath` would eagerly load every included file; we keep it surgical + fast.
 */
function makeProject(): Project {
  return new Project({
    tsConfigFilePath: join(REPO_ROOT, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
}

function addFile(project: Project, absPath: string): SourceFile {
  return project.addSourceFileAtPath(absPath);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// (1) SERVED workflows — the exported workflow-function NAMES of the two `workflowsPath` bundles.
//
//   - review worker (`worker/main.ts` → `workflowsPath: ../workflows/all_workflows`): the re-exported
//     workflow function names of `all_workflows.ts`.
//   - outbox-dispatcher worker (`worker/outbox_dispatcher_main.ts` → `workflowsPath:
//     ../workflows/outbox_dispatcher.workflow`): the `OutboxDispatcherWorkflow` async function export.
//
// We parse the EXPORT declarations of those two bundle files: re-exports (`export { a, b } from "..."`)
// AND local function exports (`export async function X()`). Each exported binding name IS a registered
// workflow TYPE (Temporal registers a workflow by its bundled function name).
// ───────────────────────────────────────────────────────────────────────────────────────────────────

function extractExportedNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();

  // `export { a, b as c } from "./x.js"` and `export { a, b }` re-exports / aggregations.
  for (const decl of sf.getExportDeclarations()) {
    for (const spec of decl.getNamedExports()) {
      // The EXPORTED name is the alias when present (`a as c` → `c`), else the local name.
      const alias = spec.getAliasNode();
      names.add(alias !== undefined ? alias.getText() : spec.getName());
    }
  }

  // `export async function X() {}` / `export function X() {}` — local function exports (the dispatcher
  // bundle exports its workflow this way, not via a re-export).
  for (const fn of sf.getFunctions()) {
    if (fn.isExported()) {
      const name = fn.getName();
      if (name !== undefined) names.add(name);
    }
  }

  return names;
}

function extractServedWorkflows(): Set<string> {
  const project = makeProject();
  const served = new Set<string>();
  for (const name of extractExportedNames(addFile(project, join(WORKFLOWS_DIR, "all_workflows.ts")))) {
    served.add(name);
  }
  for (const name of extractExportedNames(
    addFile(project, join(WORKFLOWS_DIR, "outbox_dispatcher.workflow.ts")),
  )) {
    served.add(name);
  }
  return served;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// (2) REGISTERED activities — the property KEYS of the object literal returned by `buildActivities()` and
// `buildOutboxActivities()`.
//
// Both return a FLAT object literal (verified: `build_activities.ts::buildActivities` returns `{...} as
// Record<...>`; `build_outbox_activities.ts::buildOutboxActivities` returns `{ claimPendingRows, ... } as
// unknown as Record<...>`). No `...spread`. We still resolve a spread defensively (fail LOUD if one ever
// appears) so a future refactor to spreads can't silently drop names from the registered set.
//
// Keys come in three syntactic shapes — all handled:
//   - shorthand:        `persistReviewFindings,`                 → key = "persistReviewFindings"
//   - property:         `staticAnalysis: staticAnalysisActivity.staticAnalysis,` → key = "staticAnalysis"
//   - computed-string:  `["reconcile_installation_activity"]: reconcileInstallation,` → key = the literal
// ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Find the object literal a `return { ... } as ...` returns inside a named function. */
function findReturnedObjectLiteral(sf: SourceFile, fnName: string): ObjectLiteralExpression {
  const fn = sf.getFunctionOrThrow(fnName);
  for (const ret of fn.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expr = ret.getExpression();
    if (expr === undefined) continue;
    // Unwrap `<obj> as <Type>` / `<obj> as unknown as <Type>` and parenthesized expressions.
    let inner: Node = expr;
    while (Node.isAsExpression(inner) || Node.isParenthesizedExpression(inner)) {
      const child = inner.getExpression();
      if (child === undefined) break;
      inner = child;
    }
    if (Node.isObjectLiteralExpression(inner)) {
      return inner;
    }
  }
  throw new Error(`could not find a returned object literal in ${fnName}() of ${sf.getBaseName()}`);
}

function extractObjectLiteralKeys(obj: ObjectLiteralExpression, where: string): Set<string> {
  const keys = new Set<string>();
  for (const prop of obj.getProperties()) {
    if (Node.isShorthandPropertyAssignment(prop)) {
      keys.add(prop.getName());
    } else if (Node.isPropertyAssignment(prop)) {
      const nameNode = prop.getNameNode();
      if (Node.isComputedPropertyName(nameNode)) {
        // `["literal_name"]: value` — read the string-literal inside the computed name.
        const lit = nameNode.getExpression();
        if (Node.isStringLiteral(lit) || Node.isNoSubstitutionTemplateLiteral(lit)) {
          keys.add(lit.getLiteralText());
        } else {
          throw new Error(
            `${where}: non-literal computed key ${nameNode.getText()} — cannot statically resolve the registered name`,
          );
        }
      } else if (Node.isStringLiteral(nameNode)) {
        keys.add(nameNode.getLiteralText());
      } else {
        // Identifier / numeric / etc.
        keys.add(prop.getName());
      }
    } else if (Node.isSpreadAssignment(prop)) {
      // Defensive: the current return objects are flat. A spread would hide names from this extractor, so
      // fail LOUD rather than silently under-count the registered set (which would make assertion A lenient).
      throw new Error(
        `${where}: a ...spread (${prop.getText().slice(0, 60)}) appears in the registered-activities object — ` +
          `the registry extractor must be extended to resolve the spread source before this smoke is trustworthy`,
      );
    }
  }
  return keys;
}

function extractRegisteredActivities(): Set<string> {
  const project = makeProject();
  const registered = new Set<string>();

  const buildActivitiesSf = addFile(project, join(WORKER_DIR, "build_activities.ts"));
  for (const k of extractObjectLiteralKeys(
    findReturnedObjectLiteral(buildActivitiesSf, "buildActivities"),
    "buildActivities()",
  )) {
    registered.add(k);
  }

  const buildOutboxSf = addFile(project, join(WORKER_DIR, "build_outbox_activities.ts"));
  for (const k of extractObjectLiteralKeys(
    findReturnedObjectLiteral(buildOutboxSf, "buildOutboxActivities"),
    "buildOutboxActivities()",
  )) {
    registered.add(k);
  }

  return registered;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// (3) DISPATCHED activities — every activity name a workflow proxies.
//
// Parse EVERY `apps/backend/src/workflows/*.workflow.ts` + `activity_proxy.ts` for `proxyActivities<{
// name1(...): ...; name2(...): ...; }>(opts)` and read the TYPE-LITERAL member names (each is a dispatched
// activity name). Handles single-member AND multi-member type literals, regardless of how the result is
// bound (`const { name } = ...`, multi-line destructure, or `const acts = ...`). Also scans for any
// string-literal `executeActivity("name", …)` call sites (none today; covered for completeness).
//
// We collect per (workflowFile, activityName) so assertion A can name the exact offending site on failure.
// ───────────────────────────────────────────────────────────────────────────────────────────────────

type Dispatch = { file: string; activity: string };

/** Read the activity names declared as members of a `proxyActivities<{ ... }>` type literal. */
function typeLiteralMemberNames(typeLit: TypeLiteralNode): Array<string> {
  const names: Array<string> = [];
  for (const member of typeLit.getMembers()) {
    if (Node.isMethodSignature(member)) {
      names.push(member.getName());
    } else if (Node.isPropertySignature(member)) {
      // A proxyActivities member could (in principle) be declared as a property-with-function-type; cover it.
      names.push(member.getName());
    }
  }
  return names;
}

function extractDispatchesFromFile(sf: SourceFile): Array<Dispatch> {
  const out: Array<Dispatch> = [];
  const file = sf.getBaseName();

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeName = call.getExpression().getText();

    // proxyActivities<{ ... }>(opts) / proxyLocalActivities<{ ... }>(opts) — the type argument is a type
    // literal whose method-signature names are the dispatched activity names.
    if (calleeName === "proxyActivities" || calleeName === "proxyLocalActivities") {
      const typeArgs = call.getTypeArguments();
      if (typeArgs.length === 0) {
        throw new Error(
          `${file}: ${calleeName}(...) without an explicit type argument — the dispatched activity name(s) ` +
            `cannot be statically extracted; this smoke would silently miss them`,
        );
      }
      const typeArg = typeArgs[0]!;
      if (!Node.isTypeLiteral(typeArg)) {
        throw new Error(
          `${file}: ${calleeName}<${typeArg.getText().slice(0, 40)}> uses a non-inline type argument — ` +
            `the extractor only resolves inline type literals; extend it before trusting this smoke`,
        );
      }
      for (const name of typeLiteralMemberNames(typeArg)) {
        out.push({ file, activity: name });
      }
      continue;
    }

    // executeActivity("name", …) / startActivity("name", …) — string-literal activity name (if ever used).
    if (calleeName === "executeActivity" || calleeName === "startActivity") {
      const firstArg = call.getArguments()[0];
      if (firstArg !== undefined && (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg))) {
        out.push({ file, activity: firstArg.getLiteralText() });
      }
    }
  }
  return out;
}

function extractDispatchedActivities(): Array<Dispatch> {
  const project = makeProject();
  const dispatches: Array<Dispatch> = [];

  // Every workflow body + the orchestrator's activity_proxy bridge.
  const workflowFiles = readdirSync(WORKFLOWS_DIR)
    .map((name) => basename(name))
    .filter((name) => name.endsWith(".workflow.ts"));
  // activity_proxy.ts is the orchestrator dispatch bridge (NOT named *.workflow.ts) — include it explicitly.
  workflowFiles.push("activity_proxy.ts");

  for (const name of workflowFiles) {
    const sf = addFile(project, join(WORKFLOWS_DIR, name));
    dispatches.push(...extractDispatchesFromFile(sf));
  }
  return dispatches;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// (4) STARTED workflow types — the workflow-type string literals the producers + schedules START.
//
// Scoped (per the task) to the sites we can confidently parse:
//   - the schedule `workflowType:` fields in `worker/outbox_dispatcher_main.ts` (camelCase TS names);
//   - the ingest producers' `*_WORKFLOW_TYPE` consts used as the outbox row `workflow_type` (the active
//     start path — `RealTemporalClient.startWorkflow` dispatches by these);
//   - the outbox-dispatcher singleton's start type (`worker/outbox_dispatcher_singleton.ts`).
//
// We read the STRING-LITERAL value of each `const X_WORKFLOW_TYPE = "..."` declaration in those producer
// files + the `workflowType:` object-property string literals in the schedule arrays. NOTE: the PascalCase
// `*_WORKFLOW_TYPE` consts that live in the WORKFLOW files themselves (e.g. `RunIdRetentionWorkflow`,
// `ConfluenceIngestWorkflow`) are vestigial Python-aligned names referenced ONLY in comments — they are NOT
// a start path, so the workflow files are deliberately OUT of this scope (including them would yield
// false-positive "started-but-not-served" offenders).
// ───────────────────────────────────────────────────────────────────────────────────────────────────

type StartedType = { source: string; workflowType: string };

/** Read `const NAME_WORKFLOW_TYPE = "literal"` declarations in a producer file. */
function extractWorkflowTypeConsts(sf: SourceFile): Array<StartedType> {
  const out: Array<StartedType> = [];
  const source = sf.getBaseName();
  for (const decl of sf.getVariableDeclarations()) {
    if (!decl.getName().endsWith("_WORKFLOW_TYPE")) continue;
    const init = decl.getInitializer();
    if (init !== undefined && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
      out.push({ source, workflowType: init.getLiteralText() });
    }
  }
  return out;
}

/** Read `workflowType: "literal"` object-property string literals (the schedule action fields). */
function extractWorkflowTypeProps(sf: SourceFile): Array<StartedType> {
  const out: Array<StartedType> = [];
  const source = sf.getBaseName();
  for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (prop.getName() !== "workflowType") continue;
    const init = prop.getInitializer();
    if (init !== undefined && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
      out.push({ source, workflowType: init.getLiteralText() });
    }
  }
  return out;
}

function extractStartedWorkflowTypes(): Array<StartedType> {
  const project = makeProject();
  const started: Array<StartedType> = [];

  // Schedule action `workflowType:` fields (the Wave-1/2/4 schedules).
  const dispatcherMain = addFile(project, join(WORKER_DIR, "outbox_dispatcher_main.ts"));
  started.push(...extractWorkflowTypeProps(dispatcherMain));

  // Ingest producers' `*_WORKFLOW_TYPE` consts (the active outbox-row start path).
  for (const rel of ["github_webhook_persistence.ts", "_push_emitters.ts", "_repair_dispatcher.ts"]) {
    started.push(...extractWorkflowTypeConsts(addFile(project, join(INGEST_DIR, rel))));
  }

  // The outbox-dispatcher singleton start type.
  started.push(
    ...extractWorkflowTypeConsts(addFile(project, join(WORKER_DIR, "outbox_dispatcher_singleton.ts"))),
  );

  return started;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The smoke.
// ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("workflow + activity registry structural smoke", () => {
  // Extract ONCE; share across the assertions + the coverage report.
  const served = extractServedWorkflows();
  const registered = extractRegisteredActivities();
  const dispatched = extractDispatchedActivities();
  const started = extractStartedWorkflowTypes();

  const dispatchedNames = new Set(dispatched.map((d) => d.activity));
  const startedTypes = new Set(started.map((s) => s.workflowType));

  it("reports the structural coverage (guards against a silent false-green extraction)", () => {
    // The smoke is intentionally LOUD: the count line proves the extractor matched a comprehensive surface
    // (not zero), so a future false-green is visible in CI logs.
    console.log(
      `[smoke] structural registry check: ${served.size} served workflows, ` +
        `${registered.size} registered activities, ${dispatchedNames.size} distinct dispatched activities ` +
        `(${dispatched.length} dispatch sites), ${startedTypes.size} started workflow types ` +
        `(${started.length} start sites).`,
    );

    // (C) Each extracted set must be non-empty — a zero count means the extractor silently matched nothing
    // (a false-green), so the gate is worthless until that's fixed.
    expect(served.size, "SERVED workflows extracted").toBeGreaterThanOrEqual(11);
    expect(registered.size, "REGISTERED activities extracted").toBeGreaterThanOrEqual(30);
    expect(dispatchedNames.size, "DISPATCHED activities extracted").toBeGreaterThan(0);
    expect(startedTypes.size, "STARTED workflow types extracted").toBeGreaterThan(0);
  });

  it("(A) every DISPATCHED activity is REGISTERED (no ActivityNotRegistered drift)", () => {
    const offenders = dispatched
      .filter((d) => !registered.has(d.activity))
      .map((d) => `${d.file}: ${d.activity}`)
      .sort();

    expect(
      offenders,
      `${offenders.length} dispatched activity name(s) are NOT in the registered set — each would throw ` +
        `ActivityNotRegistered at dispatch:\n  ${offenders.join("\n  ")}\n` +
        `Registered names (${registered.size}): ${[...registered].sort().join(", ")}`,
    ).toEqual([]);
  });

  it("(B) every STARTED workflow type is SERVED (no WorkflowNotRegistered drift)", () => {
    const offenders = started
      .filter((s) => !served.has(s.workflowType))
      .map((s) => `${s.source}: ${s.workflowType}`)
      .sort();

    expect(
      offenders,
      `${offenders.length} started workflow type(s) are NOT in the served set — each would throw ` +
        `WorkflowNotRegistered at start:\n  ${offenders.join("\n  ")}\n` +
        `Served workflows (${served.size}): ${[...served].sort().join(", ")}`,
    ).toEqual([]);
  });
});
