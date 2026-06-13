import { z } from "zod";

// Zod port of contracts/notifications/v1.py. Parity-validated in
// notifications.v1.parity.test.ts.
//
// This module carries TWO families of envelope (per the Python module docstring):
//   1. Outbound delivery payload (NotificationPayloadV1) — Sprint 0; Slack/Email/PagerDuty sinks.
//      ConfigDict(extra="ignore") → Zod's default .strip() (unknown keys silently dropped, NOT rejected).
//   2. The S19.C rule envelopes (NotificationRuleV1, *CreateRequestV1, *UpdateRequestV1,
//      NotificationRulesPageV1) + the RecipientV1 discriminated union. Every response model is
//      ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
//
// Source members ported (every public one in v1.py):
//   - NotificationChannelV1   (str, Enum)              → z.enum on the .value strings
//   - NotificationSeverityV1  (str, Enum)              → z.enum on the .value strings
//   - NotificationPayloadV1   (ConfigDict extra=ignore)→ z object, .strip() (default)
//   - SlackRecipientV1        (extra=forbid, frozen)   → .strict() + _channel_format @field_validator
//   - EmailRecipientV1        (extra=forbid, frozen)   → .strict() + EmailStr → z.string().email()
//   - WebhookRecipientV1      (extra=forbid, frozen)   → .strict() + HttpUrl → z.string().url()
//   - JiraRecipientV1         (extra=forbid, frozen)   → .strict() + _project_key_uppercase @field_validator
//   - RecipientV1             (Annotated discriminated union over `type`) → z.discriminatedUnion("type", …)
//   - NotificationRuleV1      (extra=forbid, frozen)   → .strict() + _cron_valid @field_validator
//   - NotificationRuleCreateRequestV1 (extra=forbid)   → .strict() + _cron_valid
//   - NotificationRuleUpdateRequestV1 (extra=forbid)   → .strict() + _cron_valid (PATCH: all optional)
//   - NotificationRulesPageV1 (extra=forbid, frozen)   → .strict()
//   - _validate_cron          (module-level helper)    → isValidCron + cronCheck superRefine
//
// Field notes:
//   - schema_version is `Literal[1] = 1` on EVERY envelope (NOT a plain int default), so the wire
//     value is fixed to 1 → z.literal(1).default(1) (matches review_findings / tool_status / arbitration).
//   - rule_id: uuid.UUID — Pydantic model_dump(mode="json") emits lowercase RFC4122 strings; the
//     Zod port validates the string form via z.string().uuid() (parity payloads use lowercase UUIDs).
//   - created_at / updated_at: datetime — ISO-8601 string on the wire (Pydantic dumps as `…Z`; the
//     canonicalizer normalizes Z↔+00:00 + fractional precision, so any valid RFC3339 string matches).
//   - filters: dict[str, Any] (default_factory=dict) → z.record(z.string(), z.unknown()).default({}).
//   - recipients: tuple[RecipientV1, ...] (default_factory=tuple) → z.array(RecipientV1).default([]).
//   - HttpUrl / EmailStr NORMALIZE on the Python side (bare host gains a trailing slash; host is
//     lowercased; email domain is lowercased). Zod's .url()/.email() pass the input through verbatim,
//     so parity payloads MUST already be in normalized form (lowercase host + trailing slash; lowercase
//     email domain) for the canonical diff to match. See the parity test header.

// NotificationChannelV1(str, Enum) — model_dump(mode="json") emits the .value strings.
export const NotificationChannelV1 = z.enum(["slack", "email", "pagerduty"]);
export type NotificationChannelV1 = z.infer<typeof NotificationChannelV1>;

// NotificationSeverityV1(str, Enum) — model_dump(mode="json") emits the .value strings.
export const NotificationSeverityV1 = z.enum(["page", "ticket", "notify"]);
export type NotificationSeverityV1 = z.infer<typeof NotificationSeverityV1>;

// NotificationPayloadV1 — ConfigDict(extra="ignore") → default .strip() (NOT .strict()):
// unknown wire keys are silently dropped, never rejected.
export const NotificationPayloadV1 = z.object({
  schema_version: z.literal(1).default(1),
  channel: NotificationChannelV1,
  severity: NotificationSeverityV1,
  title: z.string().max(256),
  body_markdown: z.string().max(8192),
  // `runbook_url: str | None = None` — a plain str, NOT HttpUrl (no normalization on the Python side).
  runbook_url: z.string().nullable().default(null),
  correlation_id: z.string().nullable().default(null),
  created_at: z.string().datetime({ offset: true }),
});
export type NotificationPayloadV1 = z.infer<typeof NotificationPayloadV1>;

// ─── S19.C — recipient discriminated union ────────────────────────

// SlackRecipientV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// _channel_format @field_validator: channel must start with '#' (name) or 'C' (id).
export const SlackRecipientV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    type: z.literal("slack"),
    channel: z.string().min(1).max(80),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!(v.channel.startsWith("#") || v.channel.startsWith("C"))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channel"],
        message: `Slack channel must start with '#' (channel name) or 'C' (channel id); got ${JSON.stringify(v.channel)}`,
      });
    }
  });
export type SlackRecipientV1 = z.infer<typeof SlackRecipientV1>;

// EmailRecipientV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// address: EmailStr (RFC-5322) → z.string().email(). Python lowercases the domain on dump; parity
// payloads supply already-lowercase domains so Zod's pass-through matches the canonical output.
export const EmailRecipientV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    type: z.literal("email"),
    address: z.string().email(),
  })
  .strict();
export type EmailRecipientV1 = z.infer<typeof EmailRecipientV1>;

// WebhookRecipientV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// url: HttpUrl → z.string().url(). Python normalizes (lowercases host, appends trailing slash to a
// bare host); parity payloads supply already-normalized URLs so Zod's pass-through matches.
export const WebhookRecipientV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    type: z.literal("webhook"),
    url: z.string().url(),
    secret_vault_path: z.string().min(1).max(512),
  })
  .strict();
export type WebhookRecipientV1 = z.infer<typeof WebhookRecipientV1>;

// JiraRecipientV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// _project_key_uppercase @field_validator: project_key must be 1..10 uppercase letters.
const PROJECT_KEY_PATTERN = /^[A-Z]+$/;
export const JiraRecipientV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    type: z.literal("jira"),
    project_key: z.string().min(1).max(10),
    issue_type: z.enum(["Bug", "Task", "Story"]),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Python: `value.isupper() and value.isalpha()`. str.isupper() requires ≥1 cased char AND no
    // lowercase; str.isalpha() requires all-alphabetic + non-empty. The anchored A-Z pattern captures
    // both (min_length=1 already forbids empty), matching croniter-free accept/reject parity.
    if (!PROJECT_KEY_PATTERN.test(v.project_key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project_key"],
        message: `JIRA project_key must be 1..10 uppercase letters; got ${JSON.stringify(v.project_key)}`,
      });
    }
  });
export type JiraRecipientV1 = z.infer<typeof JiraRecipientV1>;

// RecipientV1 = Annotated[Slack | Email | Webhook | Jira, Discriminator("type")].
// z.discriminatedUnion requires the discriminator key to live directly on each member object; the
// .strict() members above wrap z.object via .superRefine() on two variants, so we discriminate on the
// raw union and lean on each member's own type literal. A bad `type` tag is rejected with a pointer.
export const RecipientV1 = z.discriminatedUnion("type", [
  // .superRefine wrappers are ZodEffects, not ZodObject; z.discriminatedUnion only accepts ZodObject
  // members, so the two refined variants are re-expressed as plain objects here and their field-level
  // checks are re-applied via the union-level superRefine below.
  z
    .object({
      schema_version: z.literal(1).default(1),
      type: z.literal("slack"),
      channel: z.string().min(1).max(80),
    })
    .strict(),
  EmailRecipientV1,
  WebhookRecipientV1,
  z
    .object({
      schema_version: z.literal(1).default(1),
      type: z.literal("jira"),
      project_key: z.string().min(1).max(10),
      issue_type: z.enum(["Bug", "Task", "Story"]),
    })
    .strict(),
]).superRefine((v, ctx) => {
  if (v.type === "slack" && !(v.channel.startsWith("#") || v.channel.startsWith("C"))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["channel"],
      message: `Slack channel must start with '#' (channel name) or 'C' (channel id); got ${JSON.stringify(v.channel)}`,
    });
  }
  if (v.type === "jira" && !PROJECT_KEY_PATTERN.test(v.project_key)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["project_key"],
      message: `JIRA project_key must be 1..10 uppercase letters; got ${JSON.stringify(v.project_key)}`,
    });
  }
});
export type RecipientV1 = z.infer<typeof RecipientV1>;

// ─── S19.C — cron validation ──────────────────────────────────────

// Python `_validate_cron` defers to `croniter(value)`. croniter is permissive (5- or 6-field; ranges,
// steps, lists, names). We port the common 5/6-field standard-cron grammar so accept/reject AGREE on
// the tested expressions. `None` short-circuits (PATCH "field absent" semantics; Pydantic skips it).
const CRON_FIELD = "(?:\\*|\\?|(?:\\d+)(?:-\\d+)?(?:/\\d+)?|\\*/\\d+)(?:,(?:\\d+(?:-\\d+)?(?:/\\d+)?|\\*/\\d+))*";
const CRON_PATTERN = new RegExp(`^${CRON_FIELD}(?:\\s+${CRON_FIELD}){4,5}$`);

export function isValidCron(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return CRON_PATTERN.test(value.trim());
}

function cronCheck(value: string | null | undefined, ctx: z.RefinementCtx): void {
  if (!isValidCron(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schedule_cron"],
      message: `invalid cron expression ${JSON.stringify(value)}`,
    });
  }
}

// ─── S19.C — rule envelopes ───────────────────────────────────────

// NotificationRuleV1 — ConfigDict(extra="forbid", frozen=True) → .strict() + _cron_valid.
export const NotificationRuleV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    rule_id: z.string().uuid(),
    name: z.string().min(1).max(200),
    trigger_event: z.string().min(1).max(100),
    filters: z.record(z.string(), z.unknown()).default({}),
    recipients: z.array(RecipientV1).default([]),
    schedule_cron: z.string().nullable().default(null),
    state: z.enum(["active", "paused"]),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((v, ctx) => cronCheck(v.schedule_cron, ctx));
export type NotificationRuleV1 = z.infer<typeof NotificationRuleV1>;

// NotificationRuleCreateRequestV1 — ConfigDict(extra="forbid") → .strict() + _cron_valid.
// state / created_at / updated_at / rule_id are server-assigned (absent from the request body).
export const NotificationRuleCreateRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    name: z.string().min(1).max(200),
    trigger_event: z.string().min(1).max(100),
    filters: z.record(z.string(), z.unknown()).default({}),
    recipients: z.array(RecipientV1).default([]),
    schedule_cron: z.string().nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => cronCheck(v.schedule_cron, ctx));
export type NotificationRuleCreateRequestV1 = z.infer<typeof NotificationRuleCreateRequestV1>;

// NotificationRuleUpdateRequestV1 — ConfigDict(extra="forbid") → .strict() + _cron_valid.
// PATCH semantics: every field optional (None = absent / no change). The cron validator still runs
// on a provided value; `None` short-circuits in _validate_cron (mirrored by isValidCron(null)===true).
export const NotificationRuleUpdateRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    name: z.string().min(1).max(200).nullable().default(null),
    trigger_event: z.string().min(1).max(100).nullable().default(null),
    filters: z.record(z.string(), z.unknown()).nullable().default(null),
    recipients: z.array(RecipientV1).nullable().default(null),
    schedule_cron: z.string().nullable().default(null),
    state: z.enum(["active", "paused"]).nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => cronCheck(v.schedule_cron, ctx));
export type NotificationRuleUpdateRequestV1 = z.infer<typeof NotificationRuleUpdateRequestV1>;

// NotificationRulesPageV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// `rules: tuple[NotificationRuleV1, ...]` is REQUIRED (no default_factory) → z.array, no default.
export const NotificationRulesPageV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    rules: z.array(NotificationRuleV1),
  })
  .strict();
export type NotificationRulesPageV1 = z.infer<typeof NotificationRulesPageV1>;
