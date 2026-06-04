import { z } from "zod";

// Zod port of contracts/arbitration_intent/v1.py::ArbitrationIntentV1 (frozen Python).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in arbitration_intent.v1.parity.test.ts.
//
// confidence is a Pydantic `Decimal = Field(ge=0, le=1, decimal_places=3)`. model_dump(mode="json")
// serializes Decimal as a STRING preserving its exact textual form (e.g. "0.5", "0", "0.250", "1.000").
// We carry it as a STRING here so the wire shape matches Pydantic byte-for-byte.
// We re-author the ge/le range + ≤3-decimal-places invariants by hand via .superRefine().
//
// The LLM tool schema declares `confidence: {"type": "number"}` (review/tool_schema.py), so the REAL
// wire form is a JSON NUMBER, not a string. Frozen Python's field is a LAX Pydantic Decimal that
// COERCES the number (0.9 → Decimal('0.9'), KEPT) — it does NOT require a string. An over-strict
// string-only port here silently drops an arbitration intent Python keeps. So we preprocess a numeric
// input to its canonical decimal string (`String(n)`, which reproduces Python's `str(float)` for every
// fractional value the LLM emits) BEFORE the string invariants run; the regex then rejects >3-place /
// out-of-range numbers exactly as Pydantic's decimal_places/ge/le do. A round-tripped canonical STRING
// (e.g. "0.250") still passes through untouched, preserving trailing zeros.
//
// KNOWN RESIDUAL (non-realistic): a wire whole-number float WITH an explicit decimal point — `1.0`/`0.0`.
// Python preserves float-ness (str(1.0) → "1.0"); JS `JSON.parse`/`JSON.stringify` collapse `1.0` → the
// number 1 → we render "1". This is unreachable via the parity oracle (JS collapses it before transmit)
// and never emitted by the LLM (it sends fractional confidence, or the integer 1/0). Documented, not gated.

export const MAX_REASON_CHARS = 2048;
export const CONFIDENCE_DECIMAL_PLACES = 3;

// Canonical decimal text: optional sign-free non-negative number with ≤3 fractional digits.
// (Restricting to the canonical Decimal form keeps the pass-through string identical to Pydantic's
// model_dump output. Pydantic accepts looser forms like ".5"/"1e-1" but normalizes them on dump;
// callers cite the contract with canonical strings.)
// eslint-disable-next-line security/detect-unsafe-regex -- bounded + anchored, no nested/ambiguous quantifiers (no ReDoS); mirrors the frozen Pydantic contract pattern
const CONFIDENCE_TEXT = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;

export const ArbitrationIntentV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    // Pydantic uuid.UUID: validates UUID syntax, model_dump emits lowercase canonical form.
    target_finding_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    action: z.literal("SUPPRESS").default("SUPPRESS"),
    // Decimal in [0, 1] with ≤3 decimal places, carried as its canonical string form. Accepts the
    // LLM's numeric wire form by coercing it to the canonical string first (see header note).
    confidence: z.preprocess(
      (value) => (typeof value === "number" && Number.isFinite(value) ? String(value) : value),
      z
        .string()
        .regex(CONFIDENCE_TEXT, "confidence must be a canonical decimal with ≤3 fractional digits")
        .superRefine((value, ctx) => {
          const fractional = value.split(".")[1];
          if (fractional !== undefined && fractional.length > CONFIDENCE_DECIMAL_PLACES) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "confidence has too many decimal places" });
          }
          const n = Number(value);
          if (!(n >= 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "confidence must be ≥ 0" });
          if (!(n <= 1)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "confidence must be ≤ 1" });
        }),
    ),
    reason: z.string().min(1).max(MAX_REASON_CHARS),
  })
  .strict();

export type ArbitrationIntentV1 = z.infer<typeof ArbitrationIntentV1>;
