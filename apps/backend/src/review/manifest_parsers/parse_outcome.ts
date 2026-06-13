// The shared result type every ecosystem parser returns. Hoisted to its own module so the parsers + the
// parse activity share it without a cross-parser import.

import type { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

import type { NormalizationRejection } from "./normalize.js";

/**
 * One parser's result — records + rejections. The parse activity logs each rejection then drops it; only
 * `records` reach `ManifestSnapshot.parsed_dependency_records`.
 */
export type ParseOutcome = {
  readonly records: ReadonlyArray<ParsedDependencyV1>;
  readonly rejections: ReadonlyArray<NormalizationRejection>;
};
