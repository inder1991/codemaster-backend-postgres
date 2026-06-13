/**
 * Suppression policy loader — Phase D / static-analysis-coverage-gap.
 *
 * Consulted by the Finding Arbitration Layer ({@link isSuppressible} from `./arbitrate.js`) per-finding to
 * decide whether an LLM-proposed SUPPRESS intent is honored.
 *
 * ## Schema
 *
 * Zod schema tree with `.strict()` (extra=forbid); the six tool branches are ALL required
 * (typed-Literal sealing — a missing branch is a config error, not a permissive fallback).
 *
 * ## Bundled default + YAML loader
 *
 * The bundled default content is validated through {@link SuppressionPolicy} so the embedded literal can
 * never drift out of the contract. {@link loadPolicyFromYaml} parses + validates an arbitrary YAML string
 * (operator overrides / tests); {@link loadBundledPolicy} returns the parsed default (the production path).
 * Per-tenant overrides are NOT supported by design (single-company internal tool).
 *
 * ## is_suppressible
 *
 * {@link isSuppressible}: per-rule first, then per-tool default; unknown tools return the
 * SUPPRESS-forbidden sentinel (`suppressible=false, min_confidence=1.0`) so a new tool added to the
 * orchestrator without a corresponding policy edit FAILS CLOSED rather than open.
 */

import { load as yamlLoad } from "js-yaml";
import { z } from "zod";

// ── Pydantic schema mirroring the YAML (Zod port) ──

/** One per-rule (or per-tool default) entry. */
export const RuleSuppressibility = z
  .object({
    suppressible: z.boolean(),
    min_confidence: z.number().gte(0).lte(1),
  })
  .strict();
export type RuleSuppressibility = z.infer<typeof RuleSuppressibility>;

/** Per-tool policy — a default plus zero-or-more per-rule overrides. */
export const ToolPolicy = z
  .object({
    default: RuleSuppressibility,
    rules: z.record(z.string(), RuleSuppressibility).default({}),
  })
  .strict();
export type ToolPolicy = z.infer<typeof ToolPolicy>;

/**
 * Top-level suppression policy. All six tool branches are required (typed-Literal sealing; a missing
 * branch is a config error, not a permissive fallback). `.strict()` enforces extra=forbid.
 */
export const SuppressionPolicy = z
  .object({
    schema_version: z.literal(1).default(1),
    ruff: ToolPolicy,
    gitleaks: ToolPolicy,
    semgrep: ToolPolicy,
    trivy: ToolPolicy,
    eslint: ToolPolicy,
    llm: ToolPolicy,
  })
  .strict();
export type SuppressionPolicy = z.infer<typeof SuppressionPolicy>;

// ── Lookup result ──

/**
 * One lookup result. `suppressible` rolls the policy + confidence check into a single boolean for the
 * arbitration layer's call site.
 */
export type SuppressionDecision = {
  readonly suppressible: boolean;
  readonly min_confidence: number;
};

// ── Tool keys that exist on the SuppressionPolicy model ──

/** Used by {@link isSuppressible} to guard against unknown tools without raising (fail-closed). */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "ruff",
  "gitleaks",
  "semgrep",
  "trivy",
  "eslint",
  "llm",
]);

// ── Bundled default policy ──
//
// Embedded as a typed literal (validated through SuppressionPolicy at module load) rather than read from a
// copied YAML asset, so the production path is build-safe (no asset-copy step) and deterministic.
const BUNDLED_POLICY_INPUT = {
  schema_version: 1,
  // Ruff (Python) — style + correctness lints. Most are LLM-suppressible at high confidence.
  ruff: {
    default: { suppressible: true, min_confidence: 0.85 },
    rules: {
      // Unused-import — frequent false positive for entry-point modules with side-effect imports.
      F401: { suppressible: true, min_confidence: 0.9 },
      // Line-too-long — almost always safe to suppress for URLs / long literals / auto-formatted lines.
      E501: { suppressible: true, min_confidence: 0.8 },
    },
  },
  // Gitleaks (secret scanner) — STRUCTURALLY non-suppressible. Secrets are never LLM-overridable.
  gitleaks: { default: { suppressible: false, min_confidence: 1.0 }, rules: {} },
  // Semgrep (multi-language pattern scanner) — most rules LLM-suppressible at high confidence.
  semgrep: { default: { suppressible: true, min_confidence: 0.9 }, rules: {} },
  // Trivy (vulnerability scanner) — STRUCTURALLY non-suppressible. CVEs are operator-evaluated.
  trivy: { default: { suppressible: false, min_confidence: 1.0 }, rules: {} },
  // ESLint (JS/TS) — symmetric to Ruff.
  eslint: {
    default: { suppressible: true, min_confidence: 0.85 },
    rules: {
      // Unused-vars — same rationale as Ruff's F401.
      "no-unused-vars": { suppressible: true, min_confidence: 0.9 },
    },
  },
  // LLM-emitted findings — currently unused in Phase D (Tier-2 findings pass through untouched); kept for
  // forward-compat shape stability.
  llm: { default: { suppressible: true, min_confidence: 0.85 }, rules: {} },
};

/** The bundled default policy, parsed + validated through {@link SuppressionPolicy} once. */
export const BUNDLED_SUPPRESSION_POLICY: SuppressionPolicy =
  SuppressionPolicy.parse(BUNDLED_POLICY_INPUT);

/** Return the bundled default policy — the production path. */
export function loadBundledPolicy(): SuppressionPolicy {
  return BUNDLED_SUPPRESSION_POLICY;
}

/**
 * Parse + validate a YAML policy string. The operator-override / test path. Throws on malformed YAML or
 * a contract violation (ZodError).
 */
export function loadPolicyFromYaml(yamlText: string): SuppressionPolicy {
  const raw = yamlLoad(yamlText);
  return SuppressionPolicy.parse(raw);
}

/**
 * Per-rule first, then per-tool default. Unknown tools return the SUPPRESS-forbidden sentinel
 * (`suppressible=false, min_confidence=1.0`) so a new tool added to the orchestrator without a policy edit
 * FAILS CLOSED.
 *
 * Object-injection note: the tool branch is selected via an explicit switch (NOT dynamic `policy[tool]`)
 * after the `KNOWN_TOOLS` guard, so no untrusted key reaches a property lookup. Per-rule lookup uses a
 * Map-free `Object.hasOwn` guard + bounded indexing on the validated `rules` record.
 */
export function isSuppressible(args: {
  policy: SuppressionPolicy;
  tool: string;
  rule_id: string;
  confidence: number;
}): SuppressionDecision {
  const { policy, tool, rule_id, confidence } = args;
  if (!KNOWN_TOOLS.has(tool)) {
    return { suppressible: false, min_confidence: 1.0 };
  }
  const toolPolicy = selectToolBranch(policy, tool);
  const rule = lookupRuleOrDefault(toolPolicy, rule_id);
  return {
    suppressible: rule.suppressible && confidence >= rule.min_confidence,
    min_confidence: rule.min_confidence,
  };
}

/**
 * Per-rule override first, then the per-tool default. Resolves via a fresh `Map` over the validated
 * `rules` record so there is NO dynamic property-access sink (the rule_id key is LLM-influenced; a
 * `Map.get` is injection-safe).
 */
export function lookupRuleOrDefault(toolPolicy: ToolPolicy, rule_id: string): RuleSuppressibility {
  const rules = new Map<string, RuleSuppressibility>(Object.entries(toolPolicy.rules));
  return rules.get(rule_id) ?? toolPolicy.default;
}

/**
 * Resolve a tool name (already guarded by {@link KNOWN_TOOLS}) to its {@link ToolPolicy} branch via an
 * explicit switch — no dynamic property access, so the object-injection sink is structurally absent.
 */
export function selectToolBranch(policy: SuppressionPolicy, tool: string): ToolPolicy {
  switch (tool) {
    case "ruff":
      return policy.ruff;
    case "gitleaks":
      return policy.gitleaks;
    case "semgrep":
      return policy.semgrep;
    case "trivy":
      return policy.trivy;
    case "eslint":
      return policy.eslint;
    case "llm":
      return policy.llm;
    default:
      // Unreachable: callers pass the KNOWN_TOOLS guard first. Fail-closed sentinel branch as defence.
      return policy.gitleaks;
  }
}
