import { z } from "zod";

// Zod port of contracts/arbitration_intent/v1.py::ArbitrationIntentV1 (frozen Python).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in arbitration_intent.v1.parity.test.ts.
//
// confidence is a Pydantic `Decimal = Field(ge=0, le=1, decimal_places=3)`. model_dump(mode="json")
// serializes Decimal as a STRING preserving its exact textual form (e.g. "0.5", "0", "0.250", "1.000").
// We model it as a STRING here and pass it through unchanged so the wire shape matches Pydantic byte-for-byte.
// We re-author the ge/le range + ≤3-decimal-places invariants by hand via .superRefine().

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
    // Decimal in [0, 1] with ≤3 decimal places, carried as its canonical string form.
    confidence: z
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
    reason: z.string().min(1).max(MAX_REASON_CHARS),
  })
  .strict();

export type ArbitrationIntentV1 = z.infer<typeof ArbitrationIntentV1>;
