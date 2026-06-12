# Phase 0 — Cost-accounting compensating journal (implementation plan)

> Detailing the "must detail before coding" checklist of
> `2026-06-09-de-temporal-review-jobs-runner.md` (Phase 0 rows). Decision already taken there:
> **compensating signed journal** — additive; heals orphans by *appending* a release row, never a
> destructive subtract against the shared aggregate; **no Pattern-D rewrite** of the parity-critical
> `PostgresCostCapEnforcer`.

## 0. Posture (the conservative readings, fixed up front)

- **Production behavior is unchanged.** The enforcer (`apps/backend/src/cost/postgres_enforcer.ts`)
  keeps sole authority over cap decisions. The journal is **shadow-write-only**, and even the shadow
  writes are **default OFF**: `LlmClient` takes an *optional* `costJournal` collaborator (absent →
  byte-identical paths), and the composition roots wire it only when
  `CODEMASTER_COST_JOURNAL_SHADOW=1` (unset in every environment today).
- Shadow writes are **fail-safe guarded** (mirror the `recordLedgerStoreFailed` idiom): a journal
  write failure never perturbs the paid path; it increments a
  `codemaster_cost_journal_shadow_write_failed_total` counter so the swallow is visible.
- The journal's own *deciding* surface (`checkOrRaise`/`recordCallCost` over `SUM(journal)`) exists
  for the parity suite and the future cutover flip — **nothing in production calls it in Phase 0**.
- Deliberately deferred to the cutover flip (documented, not forgotten): DB-resolved live caps
  (`core.cost_cap_overrides`/`cost_cap_settings`) on the journal's deciding path (constructor caps
  only for now — the parity suite drives both sides with constructor caps); a scheduled reconciler
  job (Phase-3 scheduler wiring is runner surface — out of Phase-0 scope); journal retention sweep;
  divergence metrics/alerting (the seam returns a report; ops wiring comes with cutover).

## 1. Schema — `migrations/0043_cost_journal.sql` (checklist #1, #6)

Next free number after head `0042_background_jobs_state_and_indexes`. Brand-new cold table → plain
`CREATE TABLE`, no expand-contract. Purely additive: no existing table/column/index touched.

```sql
CREATE TABLE telemetry.cost_journal (
  journal_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id           text NOT NULL,
  installation_id   uuid NOT NULL,   -- zero-UUID sentinel = platform scope (global-only spend)
  today             date NOT NULL,   -- the accounting day, SAME value the aggregate keys on
  entry_kind        text NOT NULL CHECK (entry_kind IN ('reserve','settle','release')),
  amount_cents      bigint NOT NULL, -- SIGNED integer cents
  closes_journal_id uuid REFERENCES telemetry.cost_journal(journal_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (entry_kind <> 'reserve' OR amount_cents >= 0),
  CHECK (entry_kind <> 'release' OR amount_cents <= 0),
  CHECK (closes_journal_id IS NULL OR entry_kind = 'release')
);
CREATE INDEX  ix_cost_journal_today_installation ON telemetry.cost_journal (today, installation_id);
CREATE INDEX  ix_cost_journal_call_id            ON telemetry.cost_journal (call_id);
CREATE UNIQUE INDEX uq_cost_journal_closes       ON telemetry.cost_journal (closes_journal_id)
  WHERE closes_journal_id IS NOT NULL;
```

- **`call_id` derivation** = the ADR-0068 ledger `idempotency_key`
  (`LlmInvocationLedger.computeKey`: sha256 hex over reviewId + chunkId + role + model +
  promptSha256 + toolSchemaVersion; PR-level calls use the purpose-keyed `uuid5` chunkId surrogate).
  `text`, not `uuid` — the key is a 64-hex digest. Fallback for **un-ledgered** paid calls (platform
  jobs; the frozen-Python-parity path with no idempotency context): the client's per-call
  `requestId` (uuid4 from the client's randomness seam) so reserve/settle rows still pair for the
  reconciler. The same `call_id` legitimately appears across MULTIPLE attempt pairs (a runner retry
  of a failed paid call re-reserves under the same key — the aggregate counts both reservations
  too), hence the surrogate `journal_id` PK and *count*-based pairing (§3).
- **One row per cost event** (not one per scope): global(day) = `SUM(amount_cents)` over the day —
  platform-scope zero-UUID rows count only here; per-org(day, org) = `SUM` where
  `installation_id = org`. This mirrors the aggregate exactly (every event lands on the global row
  AND the org row) with half the writes; the spec's "per (day, scope[, scope_id])" sums are both
  derivable from the one row.
- **Sign invariants at the DB**: reserve ≥ 0, release ≤ 0, settle any sign (it is the
  `actual − estimated` diff: refund negative, top-up positive). `closes_journal_id` only on release
  rows; the **partial unique index** makes reconciliation idempotent (a reserve can be released at
  most once) and is the `ON CONFLICT` arbiter for racing reconcile passes.
- **Index consumers** (schema-with-consumer discipline): `(today, installation_id)` → the SUM reads
  (journal cap check + divergence seam); `(call_id)` → the reconciler's pairing GROUP BY;
  `uq_cost_journal_closes` → double-release impossibility.
- **Migration-safety chores**: append `"0043_cost_journal"` to `EXPECTED_MIGRATIONS` in
  `apps/backend/src/schema_preflight.ts` (the CS5 boot preflight; integration test (4) pins the
  constant byte-exact to `migrations/`, so the migration cannot land without it).
- Not registered in `TENANT_SCOPED_TABLES` — same scope-discriminated tenancy as
  `telemetry.cost_daily` (the enforcer header documents the rationale). Raw `sql` statements carry
  the enforcer's documentation-idiom marker
  (`// tenant:exempt reason=scope-discriminated-cost-journal follow_up=PERMANENT-EXEMPTION-cost-daily-scope`)
  wherever the statement does not naturally carry an `installation_id` token.

## 2. Module layout

- `apps/backend/src/cost/cost_journal.ts` — `PostgresCostJournal` (injected `Kysely` + `Clock`;
  `fromDsn` via `tenantKysely`, ADR-0062 single pool; constructor caps default to
  `DEFAULT_GLOBAL_CAP_CENTS` / `DEFAULT_PER_ORG_CAP_CENTS`):
  - `appendReserve({callId, installationId, amountCents, today})` /
    `appendSettle(...)` — the non-deciding shadow appends (plain INSERTs; no locks: the aggregate is
    authoritative in shadow mode, so the journal adds zero contention to the paid path). Exported
    narrow port `CostJournalShadowPort` = `{ appendReserve, appendSettle }` (the client depends on
    the port, mirroring `LlmInvocationLedgerPort`).
  - `checkOrRaise({callId, installationId, estimatedCents, today})` → `CostCapDecision` — the
    *deciding* twin of the enforcer's method, **cap checked against `SUM(journal)`** (checklist #2):
    one transaction; `SET LOCAL lock_timeout='2s'`;
    `pg_advisory_xact_lock(hashtext('cost_journal'), hashtext(today))` serializes every deciding
    call for the day (the analogue of the aggregate's global-row `FOR UPDATE` — every reservation
    contends on the global SUM anyway, so one day-keyed lock is the honest equivalent); SUM global +
    org; identical `RangeError` / `BedrockBudgetExceededError` (same reason strings/scopes) /
    55P03→`CostCapLockTimeoutError` semantics; on pass, append the `reserve` row in-tx; refusal
    throws → tx rollback → **no row appended** (mirrors "refused reservations don't leak").
  - `recordCallCost({callId, installationId, costCents, today, estimatedCents?})` — appends a
    `settle` row of `costCents − estimatedCents` under the same day lock. **Deliberate divergence**:
    the aggregate early-returns on `diff === 0`; the journal ALWAYS appends the settle row — a
    0-amount row leaves every SUM unchanged (decision parity preserved) but is load-bearing for the
    reconciler: it is the proof the call completed, without which a fully-settled zero-diff call
    would be "healed" with a spurious release and the SUMs would diverge.
  - `sumForDay({today, installationId?})` — the invariant read (tests + divergence).
  - `divergenceFromAggregate({today})` — the **dual-read comparison seam** (checklist #4): reads the
    day's `cost_daily` rows and the journal SUMs, compares global + every org key from either side
    (absent = 0), returns only the differing rows as
    `ReadonlyArray<{scope, scopeId, aggregateCents, journalCents}>`.
  - module-scoped OTel counter + `recordCostJournalShadowWriteFailed(kind)` (the ledger-counter
    idiom; bounded label `entry` ∈ {reserve, settle}).
  - `costJournalShadowEnabled(env)` — the feature seam predicate (`CODEMASTER_COST_JOURNAL_SHADOW
    === "1"`), default OFF.
- `apps/backend/src/cost/cost_journal_reconciler.ts` — window derivation + `CostJournalReconciler`.

## 3. Reconcile window + reconciler (checklist #3)

**Window derived from `RETRY_POLICIES` worst-case wall-time** (the spec's option A; the Phase-2
in-flight-ledger lease TTL is itself specced as "> worst-case + heartbeat", so deriving from the
same source constant is the non-circular choice). From
`apps/backend/src/review/pipeline/activity_ports.ts::RETRY_POLICIES.reviewChunk`
(startToClose **90s**, retry initial **5s**, max interval **60s**, backoff **2.0**, maxAttempts
**4**) and `apps/backend/src/runner/run_with_retry.ts` (per-attempt `Promise.race` timeout; sleeps
jittered `random.uniform(0.75, 1.25)`):

```
worst case = 4 × 90s  +  1.25 × (5s + 10s + 20s)  =  360 + 43.75  =  403.75s   (≈ 6.7 min — the spec's "≈6 min" plus jitter)
RECONCILE_WINDOW_SECONDS = ceil(2 × 403.75) = 808s (≈ 13.5 min)
```

Computed in code (`worstCaseWallTimeSeconds(RETRY_POLICIES.reviewChunk)` with a strict `"Ns"`
duration parser that throws on any other unit — fail-loud if a future policy edit changes format),
NOT hard-coded, so a policy change moves the window automatically. Safety factor ×2 covers: the
full retry **envelope** (an aborted attempt's orphaned handler promise can settle late, any time
inside the envelope — v4 #3), writer-vs-reconciler clock skew, and the client's
lock-timeout-retry tail.

**`CostJournalReconciler.releaseOrphanedReserves({olderThanSeconds = RECONCILE_WINDOW_SECONDS})`** —
one INSERT…SELECT in a transaction, `cutoff = clock.now() − olderThanSeconds`:

1. per `call_id`: `n_open = count(reserve) − count(settle) − count(release)`; candidate calls have
   `n_open > 0` **and** `max(created_at) of reserves < cutoff` (a call mid-retry with a fresh
   reserve is still live → skipped whole).
2. for each candidate call, pick the `n_open` **oldest** reserve rows not already referenced by a
   release (`NOT EXISTS … closes_journal_id = journal_id`; deterministic
   `ORDER BY created_at, journal_id`).
3. append one `release` row per picked reserve: `amount = −reserve.amount_cents`, same `call_id` /
   `installation_id` / `today` (heals the same day's SUM the reserve inflated),
   `closes_journal_id = reserve.journal_id`, `created_at = clock.now()`;
   `ON CONFLICT (closes_journal_id) WHERE closes_journal_id IS NOT NULL DO NOTHING` (racing pass →
   no double-heal). Returns the appended-row count.

**Release = append, never subtract** (checklist #2): healing only ever INSERTs; no UPDATE/DELETE of
journal rows and no write of any kind to `telemetry.cost_daily`. After healing, the journal SUM
*intentionally* diverges from the still-leaking aggregate for orphaned calls — that delta IS the
signal the divergence seam exists to report (it quantifies what the cutover fixes).

## 4. Dual-read seam — shadow writes beside the aggregate (checklist #4)

Call-site addition in `apps/backend/src/integrations/llm/client.ts` (the spec's "call-site addition
with a feature seam"; chosen over a `CostCapEnforcer` decorator because the decorator cannot see the
ADR-0068 `idempotencyKey`, which IS the mandated `call_id`). New optional constructor collaborator
`costJournal?: CostJournalShadowPort` (default `undefined` → no journal anywhere) + one private
fail-safe helper; `callId = idempotencyKey ?? requestId`; three guarded writes, each immediately
beside its aggregate twin:

1. **reserve** `+estimated` right after the `checkOrRaise` try/catch succeeds (paid MISS path only —
   replay HITs, budget refusals, aborts, and double lock-timeouts never reach it, exactly like the
   aggregate reservation), with the same `todayForCheck`.
2. **settle** `computedFinalCents − estimated` beside the success-path `recordCallCost`
   (inside `if (!isReplay)`; runs for output-safety-blocked completions too — tokens were burned).
3. **settle** `0 − estimated` in the SDK-failure catch beside `releaseCostCapReservation` (the
   failure-path release is the `actual = 0` settle; `releaseCostCapReservation` itself stays
   untouched).

Wiring (default OFF): `client_cache.ts::sharedClientCollaborators` adds
`costJournal: costJournalShadowEnabled(process.env) ? PostgresCostJournal.fromDsn({dsn, clock}) :
undefined` to the per-DSN memo; the three `new LlmClient({...})` factories
(`client_cache.ts::defaultClientFactory`, `build_activities.ts::buildLlmClientCache`,
`in_process_ports.ts::buildStrictLedgerCache`) destructure + pass it through. No other production
file changes.

## 5. Invariants (checklist #2 — restated as the testable contract)

- **SUM invariant**: for any event sequence applied to both sides,
  `cost_daily.daily_total_cents(today, 'global') = SUM(journal amounts, today)` and
  `…('per_org', org) = SUM(journal amounts, today, org)`.
- **Cap-from-SUM**: the journal's `checkOrRaise` admits/refuses exactly when the aggregate's does
  (same caps ⇒ same decisions, same error scope/reason, same "refusal leaks nothing").
- **Append-only healing**: rows are never updated or deleted; release restores cap headroom by
  appending a negative row (a previously refused reserve passes after the release lands).
- **At-most-once healing**: `uq_cost_journal_closes` + ON CONFLICT make reconcile idempotent under
  re-runs and races.

## 6. Test list (STRICT TDD; `[P0.x]` red→green pairs; integration on :5434 only)

| Slice | Red test | Green |
|---|---|---|
| **P0.1** schema | `test/integration/cost/cost_journal_schema.integration.test.ts` — table exists; defaults land (journal_id/created_at); entry_kind CHECK; reserve/release sign CHECKs; closes-only-on-release CHECK; FK; partial-unique double-close rejection | `migrations/0043_cost_journal.sql` + `EXPECTED_MIGRATIONS` append + `migrate:up` on :5434 (preflight suite stays green) |
| **P0.2** journal repo + SUM/cap invariants | `test/integration/cost/cost_journal.integration.test.ts` — appends + `sumForDay` (global vs org vs platform-scope); `checkOrRaise` admits under cap / refuses over cap (global + per_org scopes, error classes, no leaked row); `recordCallCost` always appends settle (incl. diff 0); release-append restores headroom (refused → release → admitted; row count only ever grows); RangeErrors | `cost_journal.ts` |
| **P0.3** window derivation | `test/unit/cost/cost_journal_window.test.ts` — `worstCaseWallTimeSeconds(RETRY_POLICIES.reviewChunk) === 403.75`; `RECONCILE_WINDOW_SECONDS === 808`; strict parser throws on `"5m"`/garbage | `cost_journal_reconciler.ts` (derivation half) |
| **P0.4** reconciler | same integration file, reconciler block — orphan older than window → exactly one release (amount/today/call_id/closes ref); settled call untouched; zero-diff-settled call untouched; younger-than-window untouched; fresh-reserve-mid-retry untouched; 2-reserve/1-settle call → exactly 1 release; re-run appends nothing | reconciler (healing half) |
| **P0.5** divergence seam | divergence block — equal sums → `[]`; skewed aggregate → reported row (both values); journal-only org key reported | `divergenceFromAggregate` |
| **P0.6** client shadow seam | `test/unit/llm/llm_client_cost_journal_shadow.test.ts` — paid MISS: reserve then settle, same `callId` = ledger key, amounts `+E` / `A−E`; replay HIT: zero journal calls; SDK failure: settle `−E`; journal throws → invocation unaffected; un-ledgered call: `callId` = requestId; default (no journal): nothing | `client.ts` seam + shadow-failed counter |
| **P0.7** wiring default-OFF | `test/unit/cost/cost_journal_shadow_flag.test.ts` — `costJournalShadowEnabled`: unset/`"0"`/garbage → false, `"1"` → true; `sharedClientCollaborators` threads `costJournal` per flag (unique fake DSNs; lazy pools — no connection) | `client_cache.ts` / `build_activities.ts` / `in_process_ports.ts` pass-through |
| **P0.8** parity (checklist #5) | `test/integration/cost/cost_journal_parity.integration.test.ts` — the SAME call sequences driven through `PostgresCostCapEnforcer` and `PostgresCostJournal`: mixed reserve/settle under cap; sequence crossing the global cap; crossing the per-org cap; top-up + refund; platform-scope zero-UUID; assert step-by-step identical decisions (allowed flags + spent fields + refusal scope/class at the same step) AND aggregate row totals == journal SUMs after every step | (verification suite over P0.2 — red-first applies where it drives new behavior; any divergence found becomes its own red) |

Run commands: unit `npx vitest run test/unit/cost test/unit/llm`; integration
`CODEMASTER_PG_CORE_DSN=postgresql://postgres:devpass@localhost:5434/postgres npx vitest run
test/integration/cost test/integration/runner/schema_preflight.integration.test.ts
--no-file-parallelism`. Final: `npm run gates && npm run lint && npm run typecheck && npx vitest run
test/unit` + the integration suites.
