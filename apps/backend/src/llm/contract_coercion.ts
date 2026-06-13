// Coerce LLM-output payloads to fit contract string-length constraints.
//
// The LLM overshoots `max_length`; this walks a contract's fields and truncates over-length string
// values BEFORE validation so a length violation never crashes the parser. Pure function (no I/O,
// clock, random). Introspects the Zod schema — unwrapping the `.strict().superRefine(...)` (+ optional /
// nullable / default) wrappers the registered contracts carry to reach the core ZodObject / ZodString.
//
// eslint-disable security/detect-object-injection -- every dynamic key is a CONTRACT-DECLARED field
// name (from the ZodObject shape) and the indexed object is a fresh shallow copy of the data payload
// being coerced — not a prototype-pollution sink.
/* eslint-disable security/detect-object-injection */

import { z } from "zod";

const TRUNCATION_SUFFIX = "...";

/** One truncation event. `contract` is the inner contract name. */
export type TruncationEvent = {
  readonly contract: string;
  readonly field: string;
  readonly originalLength: number;
  readonly truncatedLength: number;
  readonly blockId: string | null;
};

/** Strip ZodOptional / ZodNullable / ZodDefault / ZodEffects wrappers to reach the core schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional) current = current.unwrap() as z.ZodTypeAny;
    else if (current instanceof z.ZodNullable) current = current.unwrap() as z.ZodTypeAny;
    else if (current instanceof z.ZodDefault) current = current.removeDefault() as z.ZodTypeAny;
    else if (current instanceof z.ZodEffects) current = current.innerType() as z.ZodTypeAny;
    else return current;
  }
}

/** The `max` string-length constraint on a ZodString, or null. */
function maxLengthOf(schema: z.ZodString): number | null {
  for (const check of schema._def.checks) {
    if (check.kind === "max") return check.value;
  }
  return null;
}

/** True iff `value` is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * For an already-unwrapped field core, return the inner object-schema it bears (or null) and whether
 * the field is a container. A ZodObject is a nested model (not container); ZodArray/ZodTuple/ZodSet
 * are containers whose element may be a model. The returned `inner` may still be wrapped — coerce
 * unwraps it at the top.
 */
function innerModelAndContainer(core: z.ZodTypeAny): {
  inner: z.ZodTypeAny | null;
  isContainer: boolean;
} {
  if (core instanceof z.ZodObject) return { inner: core, isContainer: false };
  if (core instanceof z.ZodArray) {
    const element = core.element as z.ZodTypeAny;
    return { inner: unwrap(element) instanceof z.ZodObject ? element : null, isContainer: true };
  }
  if (core instanceof z.ZodTuple) {
    const items = core.items as ReadonlyArray<z.ZodTypeAny>;
    const first = items[0];
    return {
      inner: first && unwrap(first) instanceof z.ZodObject ? first : null,
      isContainer: true,
    };
  }
  if (core instanceof z.ZodSet) {
    const value = core._def.valueType as z.ZodTypeAny;
    return { inner: unwrap(value) instanceof z.ZodObject ? value : null, isContainer: true };
  }
  return { inner: null, isContainer: false };
}

/** Contract name for the TruncationEvent — best-effort (Zod schemas are anonymous). */
function contractName(schema: z.ZodTypeAny): string {
  return (schema as { description?: string }).description ?? "anonymous";
}

/**
 * Coerce `payload` to fit `schema`'s string-length constraints. Returns a NEW object (input never
 * mutated). For each field present in the payload: a non-null string longer than its `max` is
 * truncated to `value[:max-3] + "..."` (code-point-exact); a nested object recurses; a container of
 * objects recurses each element. Unknown / null / non-matching fields pass through untouched.
 * `onTruncate` fires once per truncation (default: no-op — the metric emission lives in the caller;
 * this helper stays pure).
 */
export function coerceForContract(
  payload: Record<string, unknown>,
  schema: z.ZodTypeAny,
  options: { onTruncate?: ((event: TruncationEvent) => void) | undefined; blockId?: string | null | undefined } = {},
): Record<string, unknown> {
  const onTruncate = options.onTruncate;
  const blockId = options.blockId ?? null;

  const core = unwrap(schema);
  if (!(core instanceof z.ZodObject)) return { ...payload };
  const shape = core.shape as Record<string, z.ZodTypeAny>;

  const coerced: Record<string, unknown> = { ...payload };
  for (const fieldName of Object.keys(shape)) {
    if (!(fieldName in coerced)) continue;
    const value = coerced[fieldName];
    if (value === null || value === undefined) continue;

    const fieldCore = unwrap(shape[fieldName]!);

    // Case 1: string field with a max-length constraint.
    if (fieldCore instanceof z.ZodString) {
      const maxLen = maxLengthOf(fieldCore);
      if (typeof value === "string" && maxLen !== null) {
        const codepoints = [...value]; // code-point units, matching Python str indexing
        if (codepoints.length > maxLen) {
          const truncated =
            codepoints.slice(0, maxLen - TRUNCATION_SUFFIX.length).join("") + TRUNCATION_SUFFIX;
          coerced[fieldName] = truncated;
          onTruncate?.({
            contract: contractName(schema),
            field: fieldName,
            originalLength: codepoints.length,
            truncatedLength: [...truncated].length,
            blockId,
          });
        }
      }
      continue;
    }

    const { inner, isContainer } = innerModelAndContainer(fieldCore);
    if (inner === null) continue;

    // Case 2: nested object.
    if (isPlainObject(value) && !isContainer) {
      coerced[fieldName] = coerceForContract(value, inner, { onTruncate, blockId });
      continue;
    }

    // Case 3: container of objects.
    if (Array.isArray(value) && isContainer) {
      coerced[fieldName] = value.map((item) =>
        isPlainObject(item) ? coerceForContract(item, inner, { onTruncate, blockId }) : item,
      );
      continue;
    }
  }
  return coerced;
}
