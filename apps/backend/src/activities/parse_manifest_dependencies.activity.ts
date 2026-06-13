/**
 * `parseManifestDependencies` activity (FOLLOW-UP-manifest-dependency-parsing commit 6).
 *
 * Architectural condition #7: a SEPARATE activity from the fetch. Reads a
 * {@link ParseManifestDependenciesInputV1} (a tuple of {@link ManifestSnapshot}); returns the same tuple
 * with each snapshot's `parsed_dependency_records` + `dependency_parsing_state` populated per the
 * per-parser outcome.
 *
 * Resource caps (architectural condition #4):
 *   - {@link MAX_DEPENDENCIES_PER_MANIFEST} = 5000 — truncate to the first N deterministically (parser
 *     emission order) → TRUNCATED state.
 *   - {@link MAX_MANIFEST_PARSE_MS} = 250 — wall-clock budget per manifest → over-budget surfaces PARTIAL.
 *
 * ## State logic
 *   - UNSUPPORTED_FORMAT — basename matched the matcher but no parser exists (`_dispatch` → null).
 *   - FAILED — non-empty body but the parser emitted zero records (malformed / unparseable body).
 *   - TRUNCATED — emitted > the dependency cap (takes priority over PARTIAL — louder signal).
 *   - PARTIAL — the parser surfaced rejections OR the parse ran over the time budget.
 *   - PARSED — clean parse (records, no rejections, within both caps; OR an empty/absent body).
 *
 * ## Telemetry
 * There is NO OTel metrics module yet; this activity DROPS the metric emission and keeps ONLY the
 * structured rejection log — emitted as `console.warn(JSON.stringify(...))`. The record_attempt /
 * record_outcome / record_duration_ms / record_entries_emitted counters are omitted; they are pure
 * observability with no behavioral effect on the returned snapshots.
 *
 * ## Clock seam (CLAUDE.md clock-and-random protocol)
 * The banned-primitive gate forbids
 * `performance.now()` / `Date.now()` outside `libs/platform/src/clock.ts`, so the per-manifest duration is
 * read from an INJECTED {@link Clock}.`monotonic()` (seconds → multiplied by 1000 for ms). Production wires
 * a {@link WallClock}; tests wire a `FakeClock` and `advance(...)` it to drive the time-budget branch.
 *
 * Per-manifest failure isolation: a malformed body for one manifest never aborts the others.
 *
 * See plan: `docs/superpowers/plans/2026-05-27-confluence-pr-context-manifests-v1.md`.
 */

import {
  ParseManifestDependenciesInputV1,
  ParseManifestDependenciesOutputV1,
} from "#contracts/parse_manifest_dependencies.v1.js";
import {
  type ManifestDependencyParsingState,
  ManifestSnapshot,
} from "#contracts/pr_context.v1.js";

import { type Clock, WallClock } from "#platform/clock.js";

import {
  parseCargoLock,
  parseCargoToml,
} from "#backend/review/manifest_parsers/cargo_parser.js";
import {
  parseComposerJson,
  parseComposerLock,
} from "#backend/review/manifest_parsers/composer_parser.js";
import { parseGoMod, parseGoSum } from "#backend/review/manifest_parsers/go_parser.js";
import {
  parsePackageJson,
  parsePackageLockJson,
} from "#backend/review/manifest_parsers/node_parser.js";
import type { ParseOutcome } from "#backend/review/manifest_parsers/parse_outcome.js";
import {
  parsePipfile,
  parsePipfileLock,
  parsePyproject,
  parseRequirementsTxt,
} from "#backend/review/manifest_parsers/python_parser.js";

// ─── Resource caps (architectural condition #4) ────────────────────────────────────────────────────────

/** Truncate the per-manifest record set to the first N. */
export const MAX_DEPENDENCIES_PER_MANIFEST = 5000;
/** Per-manifest wall-clock budget in ms. */
export const MAX_MANIFEST_PARSE_MS = 250;

// ─── Dispatcher table — path basename → parser callable ─────────────────────────────────────────────────

/**
 * A bound parser callable: `(body, source) → ParseOutcome`. The dispatch table normalizes the
 * ecosystem parsers' differing argument shapes behind this uniform signature.
 */
type ParserCallable = (body: string, source: string) => ParseOutcome;

/**
 * Dispatch table — basename → parser callable. Keys are the 13 v1-supported patterns; lookup misses fall
 * through to `undefined` (→ UNSUPPORTED_FORMAT). Matches the ManifestMatcher Tier 1+2 basenames.
 * Insertion order is immaterial (basename lookup, not iteration).
 */
const PARSER_TABLE: ReadonlyMap<string, ParserCallable> = new Map<string, ParserCallable>([
  // Python
  ["pyproject.toml", (body, source): ParseOutcome => parsePyproject({ body, source_manifest: source })],
  [
    "requirements.txt",
    (body, source): ParseOutcome =>
      parseRequirementsTxt({ body, source_manifest: source, isDev: false }),
  ],
  [
    "requirements-dev.txt",
    (body, source): ParseOutcome =>
      parseRequirementsTxt({ body, source_manifest: source, isDev: true }),
  ],
  ["Pipfile", (body, source): ParseOutcome => parsePipfile({ body, source_manifest: source })],
  ["Pipfile.lock", (body, source): ParseOutcome => parsePipfileLock({ body, source_manifest: source })],
  // Node
  ["package.json", (body, source): ParseOutcome => parsePackageJson({ body, source_manifest: source })],
  [
    "package-lock.json",
    (body, source): ParseOutcome => parsePackageLockJson({ body, source_manifest: source }),
  ],
  // Go
  ["go.mod", (body, source): ParseOutcome => parseGoMod({ body, source_manifest: source })],
  ["go.sum", (body, source): ParseOutcome => parseGoSum({ body, source_manifest: source })],
  // Rust
  ["Cargo.toml", (body, source): ParseOutcome => parseCargoToml({ body, source_manifest: source })],
  ["Cargo.lock", (body, source): ParseOutcome => parseCargoLock({ body, source_manifest: source })],
  // PHP
  ["composer.json", (body, source): ParseOutcome => parseComposerJson({ body, source_manifest: source })],
  ["composer.lock", (body, source): ParseOutcome => parseComposerLock({ body, source_manifest: source })],
]);

/**
 * Extract a path's basename (the segment after the last `/`).
 */
function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Route to the right parser based on the manifest's basename. Returns `null` when the basename matches a
 * path the matcher knows but no parser exists (→ UNSUPPORTED_FORMAT).
 */
export function dispatch(manifest: ManifestSnapshot): ParseOutcome | null {
  const parser = PARSER_TABLE.get(basenameOf(manifest.path));
  if (parser === undefined) {
    return null;
  }
  return parser(manifest.raw_body, manifest.path);
}

// ─── Per-manifest parse ──────────────────────────────────────────────────────────────────────────────────

/**
 * Options for {@link parseOne}. `clock` supplies the monotonic duration reader (default {@link WallClock});
 * `maxDependencies` supplies the truncation cap (default {@link MAX_DEPENDENCIES_PER_MANIFEST}). The
 * `maxDependencies` seam is a test seam on the module constant — production callers never pass it.
 */
export type ParseOneOptions = {
  readonly clock?: Clock;
  readonly maxDependencies?: number;
};

/**
 * Apply the dispatcher to one manifest + handle resource caps. Returns a NEW snapshot with the parsed
 * fields populated. Pure-ish: the only side effect is the structured rejection log (`console.warn`).
 */
export function parseOne(manifest: ManifestSnapshot, options: ParseOneOptions = {}): ManifestSnapshot {
  const clock = options.clock ?? new WallClock();
  const maxDependencies = options.maxDependencies ?? MAX_DEPENDENCIES_PER_MANIFEST;

  // `monotonic()` is seconds; the delta is multiplied by 1000 to get ms.
  const start = clock.monotonic();
  let outcome: ParseOutcome | null;
  try {
    outcome = dispatch(manifest);
  } catch (err) {
    // Per-manifest failure isolation: a single throw must NOT abort the whole batch. A parser may throw
    // mid-iteration on a malformed body — e.g. a non-string dependency spec → TypeError. Mark THIS
    // manifest FAILED, log the parser exception, and let the caller continue with the rest; one bad
    // manifest must never abort the parse stage, which is what this activity's fail-open enrichment
    // contract promises.
    logParserException(manifest, err);
    return ManifestSnapshot.parse({
      ...manifest,
      dependency_parsing_state: "failed" satisfies ManifestDependencyParsingState,
    });
  }
  const durationMs = (clock.monotonic() - start) * 1000.0;

  // UNSUPPORTED_FORMAT — matched the matcher but no parser.
  if (outcome === null) {
    return ManifestSnapshot.parse({
      ...manifest,
      dependency_parsing_state: "unsupported_format" satisfies ManifestDependencyParsingState,
    });
  }

  // FAILED — parser ran but the body was malformed (non-empty body + zero records). An empty/whitespace
  // body with zero records is NOT a failure (the fetch side already flagged it via fetch_status).
  const bodyPresent = manifest.raw_body.trim().length > 0;
  const parserRanCleanly = outcome.records.length > 0 || !bodyPresent;

  if (!parserRanCleanly) {
    logRejections(manifest, outcome);
    return ManifestSnapshot.parse({
      ...manifest,
      dependency_parsing_state: "failed" satisfies ManifestDependencyParsingState,
    });
  }

  // Resource caps — TRUNCATED takes priority over PARTIAL (truncation is the louder signal).
  let records: ReadonlyArray<ParseOutcome["records"][number]> = outcome.records;
  let truncated = false;
  if (records.length > maxDependencies) {
    records = records.slice(0, maxDependencies);
    truncated = true;
  }

  let finalState: ManifestDependencyParsingState;
  if (truncated) {
    finalState = "truncated";
  } else if (outcome.rejections.length > 0 || durationMs > MAX_MANIFEST_PARSE_MS) {
    // Rejected entries OR over-time-budget means the input wasn't processed cleanly → PARTIAL.
    finalState = "partial";
  } else {
    finalState = "parsed";
  }

  logRejections(manifest, outcome);

  return ManifestSnapshot.parse({
    ...manifest,
    parsed_dependency_records: [...records],
    dependency_parsing_state: finalState,
  });
}

/**
 * Emit one structured `console.warn` per rejected entry. `raw_name` is truncated to 64 chars to
 * bound the log payload. NO metric emission (see the module docstring).
 */
function logRejections(manifest: ManifestSnapshot, outcome: ParseOutcome): void {
  // `detected_ecosystem or "other"` — null/empty falls back to "other".
  const ecosystem = manifest.detected_ecosystem ?? "other";
  for (const rej of outcome.rejections) {
    console.warn(
      JSON.stringify({
        event: "manifest_parser_entry_rejected",
        source_manifest: manifest.path,
        ecosystem,
        raw_name_truncated: rej.raw_name.slice(0, 64),
        reason: rej.reason,
      }),
    );
  }
}

/**
 * Emit one structured `console.warn` when a parser THROWS on a manifest body (per-manifest isolation —
 * the throwing manifest is marked FAILED and the batch continues). Distinct event name from
 * `manifest_parser_entry_rejected` so operators can grep parser crashes separately from per-entry
 * rejections. `error_msg` is truncated to bound the log payload.
 */
function logParserException(manifest: ManifestSnapshot, err: unknown): void {
  const ecosystem = manifest.detected_ecosystem ?? "other";
  console.warn(
    JSON.stringify({
      event: "manifest_parser_threw",
      source_manifest: manifest.path,
      ecosystem,
      error_class: err instanceof Error ? err.constructor.name : typeof err,
      error_msg: (err instanceof Error ? err.message : String(err)).slice(0, 256),
    }),
  );
}

// ─── Activity class ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Bound-method holder for `parseManifestDependencies`. The {@link Clock} is INJECTED at construction
 * (defaulting to a {@link WallClock}) so the activity stays deterministic under test.
 */
export class ParseManifestDependenciesActivity {
  readonly #clock: Clock;

  public constructor(args: { clock?: Clock } = {}) {
    this.#clock = args.clock ?? new WallClock();
  }

  /**
   * Parse every input manifest; return a NEW tuple with the parsed fields populated. Per-manifest failure
   * isolation: a malformed body for one manifest never aborts the others. UNSUPPORTED_FORMAT for patterns
   * the matcher knows but we don't yet parse. Validates I/O via the Zod contract at the dispatch boundary.
   */
  public async parseManifestDependencies(
    rawInput: ParseManifestDependenciesInputV1,
  ): Promise<ParseManifestDependenciesOutputV1> {
    const input = ParseManifestDependenciesInputV1.parse(rawInput);
    const parsed = input.manifests.map((m) => parseOne(m, { clock: this.#clock }));
    return ParseManifestDependenciesOutputV1.parse({ parsed_manifests: parsed });
  }
}
