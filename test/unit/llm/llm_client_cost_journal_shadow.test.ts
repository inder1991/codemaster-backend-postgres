import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import type { CostJournalAppendArgs, CostJournalShadowPort } from "#backend/cost/cost_journal.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import type {
  LlmInvocationKeyInputs,
  LlmInvocationLedgerEntry,
  LlmInvocationLedgerPort,
} from "#backend/integrations/llm/invocation_ledger.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

// de-Temporal Phase 0 checklist #4 — the client-side DUAL-READ seam: when an OPTIONAL `costJournal`
// collaborator is injected, the paid path shadow-writes signed journal rows BESIDE the aggregate
// cost-cap calls — reserve(+estimated) beside checkOrRaise, settle(actual − estimated) beside
// recordCallCost, settle(0 − estimated) beside the failure-path release — keyed by call_id = the
// ADR-0068 ledger idempotency key (the requestId uuid4 for un-ledgered calls). The journal NEVER
// decides anything and NEVER perturbs the paid path: writes are guarded fail-safe, a replay HIT
// writes nothing (the spend was journaled on the first invoke), and the DEFAULT posture (no
// collaborator — what every production composition root builds until the
// CODEMASTER_COST_JOURNAL_SHADOW=1 flip) leaves the client byte-identical to before this seam.

const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys" },
  { role: "user", content: "review this chunk" },
];

const RESPONSE: Record<string, unknown> = {
  content: [{ type: "text", text: "I will surface findings." }],
  usage: { input_tokens: 220, output_tokens: 180 },
  stop_reason: "end_turn",
};

const TEST_INSTALLATION_ID = "11111111-2222-3333-4444-555555555555";
const IDEMPOTENCY = {
  reviewId: "22222222-3333-4444-5555-666666666666",
  chunkId: "33333333-4444-5555-6666-777777777777",
  toolSchemaVersion: "tsv-1",
} as const;

/** An in-memory shadow journal recording every append in arrival order. */
class FakeCostJournal implements CostJournalShadowPort {
  public readonly appends: Array<{ kind: "reserve" | "settle"; args: CostJournalAppendArgs }> = [];
  public async appendReserve(args: CostJournalAppendArgs): Promise<void> {
    this.appends.push({ kind: "reserve", args });
  }
  public async appendSettle(args: CostJournalAppendArgs): Promise<void> {
    this.appends.push({ kind: "settle", args });
  }
}

/** A shadow journal whose every write FAILS — the guarded-swallow case. */
class ThrowingCostJournal implements CostJournalShadowPort {
  public async appendReserve(): Promise<void> {
    throw new Error("journal down");
  }
  public async appendSettle(): Promise<void> {
    throw new Error("journal down");
  }
}

/** Deterministic in-memory ledger (the idempotency-test fake) — keys join the inputs with `|`. */
class FakeLedger implements LlmInvocationLedgerPort {
  private readonly rows = new Map<string, Record<string, unknown>>();
  public computeKey(i: LlmInvocationKeyInputs): string {
    return [i.reviewId, i.chunkId, i.role, i.model, i.promptSha256, i.toolSchemaVersion].join("|");
  }
  public async lookup(args: { key: string; installationId: string }): Promise<Record<string, unknown> | null> {
    return this.rows.get(args.key) ?? null;
  }
  public async store(args: { key: string; entry: LlmInvocationLedgerEntry }): Promise<void> {
    if (!this.rows.has(args.key)) this.rows.set(args.key, args.entry.providerResponse);
  }
}

function makeClient(opts: {
  journal?: CostJournalShadowPort;
  ledger?: LlmInvocationLedgerPort;
  sdk?: LlmSdk;
}): LlmClient {
  return new LlmClient({
    sdk: opts.sdk ?? { async createMessage() { return RESPONSE; } },
    costCap: new InMemoryCostCapEnforcer(),
    blobStore: new InMemoryBlobStoreAdapter(),
    clock: new FakeClock({ now: new Date("2026-06-11T00:00:00.000Z") }),
    ...(opts.journal !== undefined ? { costJournal: opts.journal } : {}),
    ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
  });
}

function invoke(client: LlmClient, withIdempotency: boolean) {
  return client.invokeModel({
    role: "primary",
    model: "claude-sonnet-4-6",
    messages: MESSAGES,
    installationId: TEST_INSTALLATION_ID,
    ...(withIdempotency ? { idempotency: IDEMPOTENCY } : {}),
  });
}

describe("LlmClient — Phase-0 cost-journal shadow writes (dual-read seam)", () => {
  it("paid MISS path appends reserve(+estimated) then settle(actual − estimated) under call_id = the ledger key", async () => {
    const journal = new FakeCostJournal();
    const ledger = new FakeLedger();
    const client = makeClient({ journal, ledger });

    const r = await invoke(client, true);

    expect(journal.appends).toHaveLength(2);
    const [reserve, settle] = journal.appends;
    expect(reserve!.kind).toBe("reserve");
    expect(settle!.kind).toBe("settle");
    // call_id = the ADR-0068 idempotency key, IDENTICAL on both rows (the reconciler pairs by it).
    expect(reserve!.args.callId).toContain(`${IDEMPOTENCY.reviewId}|${IDEMPOTENCY.chunkId}|primary|`);
    expect(settle!.args.callId).toBe(reserve!.args.callId);
    // Signed amounts: reserve carries the pre-call estimate (≥0); settle carries actual − estimated,
    // so reserve + settle == the billed final cents the result reports.
    expect(reserve!.args.amountCents).toBeGreaterThanOrEqual(0);
    expect(reserve!.args.amountCents + settle!.args.amountCents).toBe(r.cost_usd_cents);
    // Scope + day mirror the aggregate calls exactly.
    expect(reserve!.args.installationId).toBe(TEST_INSTALLATION_ID);
    expect(settle!.args.installationId).toBe(TEST_INSTALLATION_ID);
    expect(reserve!.args.today).toBe("2026-06-11");
    expect(settle!.args.today).toBe("2026-06-11");
  });

  it("a replay HIT writes NOTHING (the spend was journaled on the first invoke — no double count)", async () => {
    const ledger = new FakeLedger();
    await invoke(makeClient({ journal: new FakeCostJournal(), ledger }), true); // populate

    const journal2 = new FakeCostJournal();
    await invoke(makeClient({ journal: journal2, ledger }), true); // replay on a fresh client

    expect(journal2.appends).toHaveLength(0);
  });

  it("an SDK failure settles the reservation back: settle(0 − estimated) beside the aggregate release", async () => {
    const journal = new FakeCostJournal();
    const client = makeClient({
      journal,
      sdk: { async createMessage(): Promise<Record<string, unknown>> { throw new Error("boom"); } },
    });

    await expect(invoke(client, false)).rejects.toThrow(/bedrock invocation failed/);

    expect(journal.appends).toHaveLength(2);
    const [reserve, settle] = journal.appends;
    expect(reserve!.kind).toBe("reserve");
    expect(settle!.kind).toBe("settle");
    expect(settle!.args.amountCents).toBe(-reserve!.args.amountCents);
    expect(settle!.args.callId).toBe(reserve!.args.callId);
  });

  it("an UN-LEDGERED paid call keys both rows on the per-call requestId (rows still pair for the reconciler)", async () => {
    const journal = new FakeCostJournal();
    const client = makeClient({ journal }); // no ledger, no idempotency context

    const r = await invoke(client, false);

    expect(journal.appends).toHaveLength(2);
    expect(journal.appends[0]!.args.callId).toBe(r.request_id);
    expect(journal.appends[1]!.args.callId).toBe(r.request_id);
  });

  it("journal failures are SWALLOWED — the paid invocation succeeds untouched (fail-safe shadow)", async () => {
    const client = makeClient({ journal: new ThrowingCostJournal() });
    const r = await invoke(client, false);
    expect(r.content).toBe("I will surface findings.");
  });

  it("DEFAULT posture (no costJournal collaborator) invokes exactly as before — the seam is invisible", async () => {
    const client = makeClient({});
    const r = await invoke(client, false);
    expect(r.content).toBe("I will surface findings.");
  });
});
