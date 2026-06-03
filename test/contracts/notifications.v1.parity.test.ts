import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  EmailRecipientV1,
  JiraRecipientV1,
  NotificationPayloadV1,
  NotificationRuleCreateRequestV1,
  NotificationRuleUpdateRequestV1,
  NotificationRuleV1,
  NotificationRulesPageV1,
  SlackRecipientV1,
  WebhookRecipientV1,
} from "../../libs/contracts/src/notifications.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `<Model>(**payload).model_dump(mode="json")`) and through Zod
// (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
//
// HttpUrl / EmailStr NORMALIZE on the Python side (lowercase host, trailing slash on bare host,
// lowercase email domain). Zod's .url()/.email() pass the input through verbatim, so every parity
// payload supplies already-normalized URLs / emails — otherwise the canonical diff would spuriously
// fail on the Python-side normalization. UUIDs are lowercase (Pydantic lowercases on dump).
//
// RecipientV1 is an Annotated discriminated union (not a BaseModel), so the oracle cannot call it
// directly; its parity is exercised (a) per-variant via the concrete *RecipientV1 classes, and
// (b) indirectly via NotificationRuleV1.recipients.
const PY = "contracts.notifications.v1";

describe("NotificationPayloadV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = {
      channel: "slack",
      severity: "page",
      title: "Build failed",
      body_markdown: "**oops**",
      runbook_url: "https://runbook.example/x",
      correlation_id: "abc-123",
      created_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationPayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same null defaults (runbook_url / correlation_id) when omitted", async () => {
    const payload = {
      channel: "email",
      severity: "notify",
      title: "t",
      body_markdown: "b",
      created_at: "2026-06-03T10:00:00.123456+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationPayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both SILENTLY DROP an unknown extra field (extra=ignore ↔ default .strip())", async () => {
    const payload = {
      channel: "pagerduty",
      severity: "ticket",
      title: "t",
      body_markdown: "b",
      created_at: "2026-06-03T10:00:00+00:00",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationPayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    // extra=ignore drops `bogus` from the dump; Zod's .strip() drops it too → canonical match.
    expect(canonicalize(NotificationPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an invalid enum value (channel)", async () => {
    const bad = { channel: "carrier-pigeon", severity: "page", title: "t", body_markdown: "b", created_at: "2026-06-03T10:00:00+00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationPayloadV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => NotificationPayloadV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("SlackRecipientV1 parity (Pydantic ↔ Zod)", () => {
  it("validates a '#'-prefixed channel name identically", async () => {
    const payload = { type: "slack", channel: "#sec-alerts" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SlackRecipientV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SlackRecipientV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates a 'C'-prefixed channel id identically", async () => {
    const payload = { type: "slack", channel: "C12345" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SlackRecipientV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SlackRecipientV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a channel not starting with '#' or 'C'", async () => {
    const bad = { type: "slack", channel: "sec-alerts" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SlackRecipientV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SlackRecipientV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { type: "slack", channel: "#x", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "SlackRecipientV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SlackRecipientV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a wrong discriminator literal (type)", async () => {
    const bad = { type: "email", channel: "#x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SlackRecipientV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SlackRecipientV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("EmailRecipientV1 parity (Pydantic ↔ Zod)", () => {
  it("validates a normalized (lowercase-domain) address identically", async () => {
    const payload = { type: "email", address: "ops@example.com" };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmailRecipientV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(EmailRecipientV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a malformed address", async () => {
    const bad = { type: "email", address: "not-an-email" };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmailRecipientV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmailRecipientV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("WebhookRecipientV1 parity (Pydantic ↔ Zod)", () => {
  it("validates a normalized URL (lowercase host, explicit path) identically", async () => {
    const payload = { type: "webhook", url: "https://example.com/hook", secret_vault_path: "secret/data/wh" };
    const r = await pyRef({ pyModule: PY, pyCallable: "WebhookRecipientV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WebhookRecipientV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates a bare host that already carries the normalizing trailing slash", async () => {
    // Python HttpUrl appends `/` to a bare host; supply it pre-normalized so Zod pass-through matches.
    const payload = { type: "webhook", url: "https://example.com/", secret_vault_path: "p" };
    const r = await pyRef({ pyModule: PY, pyCallable: "WebhookRecipientV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WebhookRecipientV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a non-URL", async () => {
    const bad = { type: "webhook", url: "not-a-url", secret_vault_path: "p" };
    const r = await pyRef({ pyModule: PY, pyCallable: "WebhookRecipientV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WebhookRecipientV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("JiraRecipientV1 parity (Pydantic ↔ Zod)", () => {
  it("validates an uppercase project_key identically", async () => {
    const payload = { type: "jira", project_key: "SEC", issue_type: "Bug" };
    const r = await pyRef({ pyModule: PY, pyCallable: "JiraRecipientV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(JiraRecipientV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a non-uppercase project_key", async () => {
    const bad = { type: "jira", project_key: "Sec", issue_type: "Bug" };
    const r = await pyRef({ pyModule: PY, pyCallable: "JiraRecipientV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => JiraRecipientV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a project_key with a digit (isalpha fails)", async () => {
    const bad = { type: "jira", project_key: "SEC1", issue_type: "Bug" };
    const r = await pyRef({ pyModule: PY, pyCallable: "JiraRecipientV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => JiraRecipientV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown issue_type", async () => {
    const bad = { type: "jira", project_key: "SEC", issue_type: "Epic" };
    const r = await pyRef({ pyModule: PY, pyCallable: "JiraRecipientV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => JiraRecipientV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("NotificationRuleV1 parity (Pydantic ↔ Zod)", () => {
  it("validates a full rule (discriminated recipients + filters + cron) identically", async () => {
    const payload = {
      rule_id: "11111111-1111-1111-1111-111111111111",
      name: "sec alerts",
      trigger_event: "review.completed",
      filters: { repo: "x", min_severity: "blocker", count: 3 },
      recipients: [
        { type: "slack", channel: "#sec" },
        { type: "email", address: "a@b.com" },
        { type: "webhook", url: "https://hooks.example.com/h", secret_vault_path: "secret/data/h" },
        { type: "jira", project_key: "SEC", issue_type: "Task" },
      ],
      schedule_cron: "0 9 * * 1",
      state: "active",
      created_at: "2026-06-03T10:00:00+00:00",
      updated_at: "2026-06-03T11:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (filters={}, recipients=[]) and null schedule_cron", async () => {
    const payload = {
      rule_id: "22222222-2222-2222-2222-222222222222",
      name: "n",
      trigger_event: "e",
      state: "paused",
      created_at: "2026-06-03T10:00:00+00:00",
      updated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an invalid cron expression", async () => {
    const bad = {
      rule_id: "33333333-3333-3333-3333-333333333333",
      name: "n",
      trigger_event: "e",
      schedule_cron: "not a cron",
      state: "active",
      created_at: "2026-06-03T10:00:00+00:00",
      updated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => NotificationRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a bad recipient discriminator (union pointer)", async () => {
    const bad = {
      rule_id: "44444444-4444-4444-4444-444444444444",
      name: "n",
      trigger_event: "e",
      recipients: [{ type: "carrier-pigeon", channel: "#x" }],
      state: "active",
      created_at: "2026-06-03T10:00:00+00:00",
      updated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => NotificationRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      rule_id: "55555555-5555-5555-5555-555555555555",
      name: "n",
      trigger_event: "e",
      state: "active",
      created_at: "2026-06-03T10:00:00+00:00",
      updated_at: "2026-06-03T10:00:00+00:00",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => NotificationRuleV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("NotificationRuleCreateRequestV1 parity (Pydantic ↔ Zod)", () => {
  it("validates a create body identically", async () => {
    const payload = {
      name: "n",
      trigger_event: "review.completed",
      filters: { repo: "x" },
      recipients: [{ type: "slack", channel: "C9999" }],
      schedule_cron: "*/15 * * * *",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleCreateRequestV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationRuleCreateRequestV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (filters={}, recipients=[]) when omitted", async () => {
    const payload = { name: "n", trigger_event: "e" };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleCreateRequestV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationRuleCreateRequestV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { name: "n", trigger_event: "e", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleCreateRequestV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => NotificationRuleCreateRequestV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("NotificationRuleUpdateRequestV1 parity (Pydantic ↔ Zod)", () => {
  it("validates an all-omitted PATCH body (every field nulls out) identically", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleUpdateRequestV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationRuleUpdateRequestV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates a partial PATCH body (name + state set) identically", async () => {
    const payload = { name: "renamed", state: "paused" };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleUpdateRequestV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationRuleUpdateRequestV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an invalid cron in a PATCH body (too few fields)", async () => {
    // croniter rejects a 4-field expression; the Zod CRON_PATTERN requires 5-or-6 fields → both reject.
    const bad = { schedule_cron: "0 9 * *" };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRuleUpdateRequestV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => NotificationRuleUpdateRequestV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("NotificationRulesPageV1 parity (Pydantic ↔ Zod)", () => {
  it("validates an empty page identically", async () => {
    const payload = { rules: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRulesPageV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationRulesPageV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates a page with one rule identically", async () => {
    const payload = {
      rules: [
        {
          rule_id: "66666666-6666-6666-6666-666666666666",
          name: "n",
          trigger_event: "e",
          recipients: [{ type: "email", address: "a@b.com" }],
          state: "active",
          created_at: "2026-06-03T10:00:00+00:00",
          updated_at: "2026-06-03T10:00:00+00:00",
        },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRulesPageV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(NotificationRulesPageV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a missing required `rules` field", async () => {
    const bad = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "NotificationRulesPageV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => NotificationRulesPageV1.parse(bad)).toThrow();
  }, 30_000);
});
