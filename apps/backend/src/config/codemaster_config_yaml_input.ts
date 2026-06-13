/**
 * `.codemaster.yaml` untrusted-boundary input normalizer (dedicated boundary parser).
 *
 * ## Why this layer exists
 *
 * The TS port parses `.codemaster.yaml` with **js-yaml (YAML 1.2)** and validates with the **STRICT**
 * {@link CodemasterConfigV1} Zod contract (`.strict()` + no `z.coerce`). The source-of-truth
 * parses with **PyYAML (YAML 1.1)** and validates with **lax Pydantic v2** (which coerces scalars). Those
 * two stacks DIVERGE on realistic customer scalars, and the divergence is MATERIAL:
 *
 *   * `enabled: no`  → js-yaml yields the STRING `"no"` (YAML 1.2 dropped the `yes/no/on/off` bool words).
 *     Strict `z.boolean()` REJECTS a string → the WHOLE config falls to defaults → `enabled` stays its
 *     `true` default → **review stays ON for a customer who explicitly opted OUT.** Pydantic v2, by
 *     contrast, coerces `"no" → False`, so the frozen behaviour is "disabled". A silent, customer-visible,
 *     safety-relevant fidelity gap.
 *
 * This module is the SINGLE place leniency lives. It walks the js-yaml-parsed object and, GUIDED BY the
 * {@link CodemasterConfigV1} field types (the bool fields incl. nested `knowledge.enabled`, and the int
 * fields), coerces ONLY those fields to the JS types the strict Zod contract accepts — replicating EXACTLY
 * what Pydantic v2 accepts (observed empirically against the frozen venv; NOT guessed). Every other field
 * (the opaque `policy` block, strings, lists, nested label tuples) is left UNTOUCHED.
 *
 * `CodemasterConfigV1` itself STAYS `.strict()` and UNCHANGED — Temporal / DB / internal consumers MUST
 * keep validating strictly. All leniency is confined to THIS `.codemaster.yaml` boundary.
 *
 * ## Confidence-gated coercion (criterion 4: invalid coercions still fail the WHOLE config to defaults)
 *
 * A value this normalizer cannot CONFIDENTLY coerce (e.g. `enabled: "2"`, `schema_version: "abc"`) is left
 * AS-IS. The strict `CodemasterConfigV1.safeParse` then rejects it, and the loader's fail-open branch
 * returns full defaults — matching Pydantic, which ALSO rejects those values. The normalizer never invents
 * a value; it only bridges the cases Pydantic would have accepted.
 *
 * ## YAML 1.2 (js-yaml) vs YAML 1.1 (PyYAML) — what this layer does and does NOT bridge
 *
 * js-yaml is a YAML **1.2** parser; PyYAML's `safe_load` is YAML **1.1**. This normalizer bridges the
 * REALISTIC scalar/coercion divergences that occur AFTER parsing — the cases where js-yaml hands us a
 * string/number/boolean that Pydantic would have coerced to the contract type (bool words, quoted
 * numerics, underscore-grouped numerics, bool→int).
 *
 * It does NOT (and cannot, without a YAML-1.1 parser dependency) bridge the EXOTIC YAML-1.1-ONLY *parse*
 * divergences, which happen INSIDE js-yaml before this normalizer ever sees the value:
 *
 *   * sexagesimal `1:30` — PyYAML 1.1 reads base-60 int `90`; js-yaml 1.2 reads the string `"1:30"`.
 *   * leading-zero octal `017` / `0o17` — PyYAML 1.1 octal `15` for `017` and a STRING for `0o17`;
 *     js-yaml 1.2 decimal `17` for `017` and octal `15` for `0o17`.
 *   * bool words inside string lists (`ignore_paths: [yes, no]`) — PyYAML yields `[True, False]`;
 *     js-yaml yields `["yes", "no"]`. (These land in str/opaque fields the normalizer leaves untouched.)
 *   * duplicate mapping keys (`enabled: true\nenabled: false`) — PyYAML keeps the LAST; js-yaml THROWS.
 *
 * These are a DOCUMENTED RESIDUAL (FOLLOW-UP-config-yaml-1.1-exotic-scalars). They are never present in a
 * real `.codemaster.yaml` (no human writes a sexagesimal finding cap or octal schema_version), and they
 * are not worth taking on a new YAML-1.1 parser dependency to close. The parity corpus asserts the EXACT
 * known PY-vs-TS divergence for each so it can never silently regress into "we think they match".
 *
 * ## Observed Pydantic v2 coercion ground truth (frozen venv, recorded NOT guessed)
 *
 * BOOL (case-insensitive string set + numeric + JS-boolean passthrough):
 *   true  ← `true`,`yes`,`on`,`y`,`t`,`1`   and numeric `1`/`1.0`   and JS `true`
 *   false ← `false`,`no`,`off`,`n`,`f`,`0`  and numeric `0`/`0.0`   and JS `false`
 *   Anything else (`"2"`, `""`, `null`, `"yes "` with surrounding spaces, `2`) → NOT coerced → left as-is.
 *
 * INT (Pydantic-v2 `int`-coercion, observed):
 *   numeric strings with optional surrounding whitespace, optional `+`/`-` sign, decimal digits with
 *   SINGLE underscores BETWEEN digits (`1_000`, `1_0_0`), AND integral-valued decimal-point strings whose
 *   fraction is all-zeros (`10.00 → 10`, `1_000.0 → 1000`). REJECTED: octal/hex/binary prefixes
 *   (`0o17`,`0x10`,`0b1`), exponents (`1e3`), sexagesimal (`1:30`), non-integral floats (`10.5`),
 *   leading/trailing/double underscores (`_1`,`1_`,`1__0`), bare `.5`/`1.`. JS booleans coerce
 *   (`true → 1`, `false → 0`); integral JS floats coerce (`5.0 → 5`).
 */

/**
 * The subset of {@link CodemasterConfigV1} fields whose declared type is a Pydantic `bool`. Pydantic v2's
 * lax bool coercion runs on these; the strict Zod port does not — so the normalizer must coerce them here.
 *
 * Two scopes:
 *   * top-level `enabled` (the master review switch — the safety-critical opt-out)
 *   * nested `knowledge.enabled` (the policy-engine customer-side opt-out)
 *
 * Derived from the contract field types (see `libs/contracts/src/codemaster_config.v1.ts`):
 * `z.boolean()` on `CodemasterConfigV1.enabled` and `KnowledgeConfigV1.enabled`.
 */
const TOP_LEVEL_BOOL_FIELDS: ReadonlySet<string> = new Set(["enabled"]);
const KNOWLEDGE_BOOL_FIELDS: ReadonlySet<string> = new Set(["enabled"]);

/**
 * The subset of {@link CodemasterConfigV1} top-level fields whose declared type is a Pydantic `int`
 * (`z.number().int()` in the port). Pydantic v2's lax int coercion runs on these.
 *
 *   * `schema_version`         (`z.number().int()`, no bounds)
 *   * `max_findings_per_file`  (`z.number().int().gte(1).lte(100)`)
 *   * `max_findings_per_review`(`z.number().int().gte(1).lte(500)`)
 *
 * The numeric-coercion path only converts the value to a `number`; the strict Zod `.gte/.lte` bounds still
 * run AFTER coercion, so an out-of-range coerced number (`max_findings_per_file: "9999"`) still fails the
 * whole config to defaults — exactly as Pydantic's own bounds reject it (criterion 4).
 */
const TOP_LEVEL_INT_FIELDS: ReadonlySet<string> = new Set([
  "schema_version",
  "max_findings_per_file",
  "max_findings_per_review",
]);

/** The nested-object field carrying the knowledge sub-block, so we can reach `knowledge.enabled`. */
const KNOWLEDGE_FIELD = "knowledge";

/**
 * Pydantic-v2 int-string acceptance regex (observed). Optional surrounding whitespace is stripped by the
 * caller before this matches. Matches: optional sign, digit-groups joined by SINGLE underscores, and an
 * OPTIONAL all-zeros fractional tail (`10.00`, `1_000.0`). Rejects everything Pydantic rejects: prefixed
 * radices, exponents, non-zero fractions, leading/trailing/double underscores, sexagesimal.
 *
 *   ^[+-]?            optional sign
 *   \d+               leading digit run
 *   (_\d+)*           zero or more underscore-separated digit groups — each `_` MUST be followed by ≥1
 *                     digit, so `_1`/`1_`/`1__0` (leading/trailing/double underscore) all fail
 *   (\.0+)?           optional integral fractional tail — only all-zeros (so `10.00 → 10`; `10.5` rejected)
 *   $
 *
 * Linear / no-backtracking by construction: every `(_\d+)` iteration consumes a `_` plus ≥1 digit, the
 * groups are non-overlapping, and the optional `(\.0+)?` tail is anchored — there is no ambiguous /
 * nested quantifier, so there is no catastrophic-backtracking (ReDoS) surface.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, no nested/overlapping quantifiers: each `(_\d+)` iteration consumes `_`+≥1 digit and the `(\.0+)?` tail is bounded, so no catastrophic backtracking (heuristic false positive)
const PYDANTIC_INT_STRING = /^[+-]?\d+(_\d+)*(\.0+)?$/;

/** Case-insensitive string tokens Pydantic v2 coerces to bool `true` (exact match, no surrounding space). */
const BOOL_TRUE_TOKENS: ReadonlySet<string> = new Set(["true", "yes", "on", "y", "t", "1"]);
/** Case-insensitive string tokens Pydantic v2 coerces to bool `false` (exact match, no surrounding space). */
const BOOL_FALSE_TOKENS: ReadonlySet<string> = new Set(["false", "no", "off", "n", "f", "0"]);

/**
 * Coerce one value to a boolean iff Pydantic v2 would, else return the value UNCHANGED.
 *
 *   * JS boolean → passthrough (js-yaml already produced the right type for YAML-1.2 `true/false`).
 *   * String → lowercased exact-match against the observed true/false token sets. NO trimming: Pydantic
 *     rejects `"  yes  "`, so we must too (a trimmed match would WIDEN beyond the frozen behaviour).
 *   * Number → only exact `0`/`1` (incl. `0.0`/`1.0`) map; any other number is left as-is (Pydantic
 *     rejects `2`, `-1`).
 *   * Anything else (null, object, array) → left as-is so the strict contract rejects it → fail-open.
 */
function coerceBool(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (BOOL_TRUE_TOKENS.has(lowered)) {
      return true;
    }
    if (BOOL_FALSE_TOKENS.has(lowered)) {
      return false;
    }
    return value; // not a recognized bool word → leave for strict reject (e.g. "2", "nope", "")
  }
  if (typeof value === "number") {
    if (value === 0) {
      return false;
    }
    if (value === 1) {
      return true;
    }
    return value; // other numbers are NOT bools in Pydantic (2, -1 reject) → leave as-is
  }
  return value;
}

/**
 * Coerce one value to an integer `number` iff Pydantic v2 would, else return the value UNCHANGED.
 *
 *   * JS boolean → `true → 1`, `false → 0` (Pydantic coerces bool→int).
 *   * Number → integral numbers pass through; integral-valued floats (`5.0`) are floored to the int;
 *     non-integral floats (`1.5`) are LEFT AS-IS so the strict `.int()` rejects them (matches Pydantic).
 *   * String → trimmed, matched against {@link PYDANTIC_INT_STRING}; on match, underscores stripped and
 *     `Number(...)` produces the int (the `\.0+` tail makes `Number` yield an integral float, floored).
 *     A non-matching string is left as-is → strict reject → fail-open (matches Pydantic rejecting it).
 *
 * The bounds (`.gte/.lte`) are NOT applied here — the strict Zod schema enforces them AFTER coercion, so
 * an out-of-range coerced int still fails the whole config to defaults (criterion 4).
 */
function coerceInt(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return value;
    }
    // Integral-valued float (e.g. js-yaml never emits these for our int fields, but be exact): floor it.
    // A genuinely non-integral float is left as-is so strict `.int()` rejects (Pydantic rejects 1.5 too).
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!PYDANTIC_INT_STRING.test(trimmed)) {
      return value; // not a Pydantic-acceptable int string → leave for strict reject
    }
    const normalized = trimmed.replace(/_/g, "");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      return value; // unreachable for a matched string, but never invent a value
    }
    // The regex guarantees an integral magnitude (digits + all-zeros fraction), so flooring is exact and
    // only strips a `.0…` tail; it never changes the represented integer.
    return Math.trunc(parsed);
  }
  return value;
}

/** Type guard: a plain (non-array, non-null) object whose keys we can walk. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize the js-yaml-parsed `.codemaster.yaml` object so the STRICT {@link CodemasterConfigV1} sees
 * Pydantic-v2-compatible scalar types at the bool/int fields — the dedicated untrusted-boundary parser.
 *
 * Behaviour:
 *   * Non-object input (array, scalar, null/undefined) → returned UNCHANGED. The strict contract rejects a
 *     non-mapping top level on its own (mirrors Pydantic rejecting a non-dict), so there is nothing to
 *     normalize and nothing to invent.
 *   * Object input → a SHALLOW-rebuilt copy where ONLY the contract's bool fields (top-level `enabled`,
 *     `knowledge.enabled`) and int fields (`schema_version`, `max_findings_per_file`,
 *     `max_findings_per_review`) are run through the confidence-gated coercers above. Every other key —
 *     the opaque `policy` block, string fields, lists, label tuples, `path_instructions`, `model_overrides`
 *     — is copied through verbatim. Nested coercion is scoped to the documented `knowledge.enabled` field
 *     only; we do NOT deep-walk arbitrary structure (the contract has no other nested bool/int leaf).
 *   * Any field the coercers cannot confidently coerce is left AS-IS so the strict parse rejects it and
 *     the loader falls open to defaults (criterion 4) — identical to Pydantic rejecting the same value.
 *
 * Pure and side-effect-free: no clock, no randomness, no I/O. Returns `unknown` (the loader hands the
 * result straight to `CodemasterConfigV1.safeParse`, which re-narrows it).
 */
export function normalizeCodemasterYaml(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) {
    return parsed; // non-mapping top level → strict contract rejects → fail-open (nothing to bridge)
  }

  const out: Record<string, unknown> = {};
  // `key` is bound by `Object.entries` from the parsed input and only ever WRITES into the fresh local
  // `out` literal (never reads back, never indexes an attacker-named property of an existing object), so
  // the detect-object-injection sink is a false positive here — the writes cannot escape `out`.
  /* eslint-disable security/detect-object-injection -- write-only into a fresh local object; keys come from Object.entries of the parsed config, no prototype-chain read */
  for (const [key, value] of Object.entries(parsed)) {
    if (TOP_LEVEL_BOOL_FIELDS.has(key)) {
      out[key] = coerceBool(value);
      continue;
    }
    if (TOP_LEVEL_INT_FIELDS.has(key)) {
      out[key] = coerceInt(value);
      continue;
    }
    if (key === KNOWLEDGE_FIELD && isPlainObject(value)) {
      out[key] = normalizeKnowledgeBlock(value);
      continue;
    }
    out[key] = value; // opaque / string / list / nested-model field → copied verbatim, untouched
  }
  /* eslint-enable security/detect-object-injection */
  return out;
}

/**
 * Normalize the nested `knowledge` sub-block: coerce ONLY `knowledge.enabled` (the documented nested bool
 * field); copy `file_patterns`, `confluence`, and any other key through verbatim. A non-object knowledge
 * value is handled by the caller (it stays verbatim so the strict contract rejects it).
 */
function normalizeKnowledgeBlock(knowledge: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Same write-only-into-fresh-local rationale as normalizeCodemasterYaml above (false-positive sink).
  /* eslint-disable security/detect-object-injection -- write-only into a fresh local object; keys come from Object.entries of the knowledge sub-block, no prototype-chain read */
  for (const [key, value] of Object.entries(knowledge)) {
    if (KNOWLEDGE_BOOL_FIELDS.has(key)) {
      out[key] = coerceBool(value);
      continue;
    }
    out[key] = value;
  }
  /* eslint-enable security/detect-object-injection */
  return out;
}
