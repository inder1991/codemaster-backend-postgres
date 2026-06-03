export const meta = {
  name: 'task-0-7-clock-random',
  description: 'Port clock/randomness infra primitives + uuid7 + no-wall-clock gate (1:1 from frozen Python), parity-proven',
  phases: [
    { title: 'Build', detail: 'clock.ts | check_clock_random gate | randomness+MT19937+parity-harness — parallel' },
    { title: 'Verify', detail: 'adversarial cross-impl parity vs the live frozen Python random.Random/uuid7' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['component', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    component: { type: 'string' },
    files_written: { type: 'array', items: { type: 'string' } },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cmd', 'passed'],
        properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } },
      },
    },
    all_green: { type: 'boolean' },
    bit_exact_parity: { type: 'string', description: 'for randomness: yes/no/n-a + what diverged if no' },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'parity_confirmed', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['REAL_PARITY', 'DIVERGENCE', 'INCONCLUSIVE'] },
    parity_confirmed: { type: 'boolean' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'pass'],
        properties: {
          name: { type: 'string' },
          pass: { type: 'boolean' },
          py: { type: 'string' },
          ts: { type: 'string' },
        },
      },
    },
    seeds_tested: { type: 'array', items: { type: 'number' } },
    test_is_real: { type: 'boolean', description: 'true if the parity test genuinely compares (not vacuous/skipped)' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

// ---- shared style preamble injected into every build brief ---------------------------------
const STYLE = `
WORKING DIR: ${REPO}. Use ABSOLUTE paths. The Bash cwd RESETS between calls — prefix every command with \`cd ${REPO} && ...\`. Do NOT cd into the worktree at /Users/ascoe/Projects/codemaster/.claude/worktrees.

TS STYLE (ENFORCED by eslint.config.js — validate-fast runs gates→lint→typecheck→test; your code MUST pass):
- ESM: import specifiers end in \`.js\` even for .ts sources (e.g. \`import { Clock } from "./clock.js"\`).
- \`type\` aliases NOT \`interface\` (consistent-type-definitions=type). \`Array<T>\`/\`ReadonlyArray<T>\` NOT \`T[]\` (array-type=generic).
- NO \`any\` → use \`unknown\` + narrow. Named exports only (no default). Explicit return types on EXPORTED functions.
- \`import { type X }\` consistent-type-imports. \`??\`/\`?.\` for null. \`readonly\`/\`as const\` where data is immutable. Single object arg for functions (except one primitive).
- Filenames snake_case (unicorn/filename-case); leading \`_\` allowed for internal infra (e.g. _mt19937.ts). camelCase locals/fns, PascalCase types, CAPITALIZED consts, \`is\`/\`has\` boolean prefixes, acronyms-as-words (Url not URL).
- Comments explain WHY not what; TSDoc on exported APIs. Tests: AAA, \`it("should ... when ...")\`, test behavior.

GUARDRAILS:
- Do NOT run \`eslint --fix\` on the whole repo or edit baseline/unrelated files. Touch ONLY your assigned files.
- Do NOT git add or git commit — the orchestrator commits after verification.
- Do NOT touch any database/cluster — these are pure unit/parity tests, no DB.
- The frozen Python source-of-truth is at ${REPO}/vendor/codemaster-py (submodule, READ-ONLY — never edit it). Its venv python is vendor/codemaster-py/.venv/bin/python (CPython 3.14).
- Mirror existing conventions: read a sibling file before writing a new one.
`

// =================================================================================================
phase('Build')

const CLOCK_BRIEF = `Port the clock seam 1:1 from the frozen Python to TypeScript.
${STYLE}

SOURCE (read it first): ${REPO}/vendor/codemaster-py/codemaster/infra/clock.py — Clock Protocol (now()->datetime, monotonic()->float, async sleep(seconds)), WallClock (real), FakeClock (now defaults 2026-01-01 UTC; requires tz-aware; .set(now), .advance(seconds) advances both wall+monotonic, .sleep records but does not sleep, .recordedSleeps()).

CREATE ${REPO}/libs/platform/src/clock.ts:
- \`export type Clock = { now(): Date; monotonic(): number; sleep(seconds: number): Promise<void> }\`. (Date is the TS analogue of tz-aware UTC datetime — Date is an absolute UTC instant.)
- \`export class WallClock implements Clock\`: now()=> new Date(); monotonic()=> performance.now()/1000 (SECONDS, mirroring Python time.monotonic which is seconds); sleep(s)=> new Promise(r => setTimeout(r, s*1000)).
- \`export class FakeClock implements Clock\`: constructor({ now, monotonicStart }: { now?: Date; monotonicStart?: number } = {}); default now = new Date("2026-01-01T00:00:00.000Z"); store ms internally; now() returns a NEW Date each call (no shared mutable Date leak); monotonic() returns the accumulated seconds; async sleep(s) pushes s to a private array (does NOT advance — tests advance explicitly); set({ now }: { now: Date }); advance({ seconds }: { seconds: number }) adds seconds to BOTH the wall instant (ms += seconds*1000) and monotonic; recordedSleeps(): ReadonlyArray<number>.
- This file is the ONLY place Date/performance.now/setTimeout are sanctioned (the gate allowlists it). Add a top TSDoc note saying so, mirroring clock.py's module docstring.
- NOTE: Python FakeClock raises on tz-naive datetime. JS Date has no tz-naive concept (always an absolute instant), so that guard is N/A — document this 1:1-divergence in a comment.

CREATE ${REPO}/test/unit/infra/clock.test.ts (vitest; mirror harness of ${REPO}/test/parity/canonical.test.ts for import style):
- WallClock.now() returns a Date close to real now (within a few seconds); monotonic() is non-decreasing across two reads.
- FakeClock default now() is 2026-01-01T00:00:00.000Z; now() does not move without advance; advance({seconds:60}) moves now() +60s AND monotonic() +60; set({now}) jumps the wall clock; sleep() records durations without advancing (recordedSleeps() returns them in order); two now() calls return equal-but-distinct Date objects (no aliasing).
TDD: write the test FIRST, run \`cd ${REPO} && npx vitest run test/unit/infra/clock.test.ts\` and CONFIRM it fails (red, no impl), THEN implement clock.ts to green. Run \`cd ${REPO} && npx tsc -p tsconfig.json\` and \`npx eslint libs/platform/src/clock.ts test/unit/infra/clock.test.ts\` — both clean.

Return: the component name, files written (absolute paths), the exact vitest/tsc/eslint commands you ran and their pass/fail, and any 1:1 divergences you documented.`

const GATE_BRIEF = `Port the no-wall-clock CI lint (${REPO}/vendor/codemaster-py/scripts/no_wall_clock.py — READ IT) to a TypeScript ts-morph gate that bans raw clock/random usage outside the two sanctioned seam files. Without this gate the clock/random seam is unenforced — it is required.
${STYLE}

TEMPLATE: read ${REPO}/scripts/gates/check_tenant_scoped_raw_sql.ts (gate structure + [SEVERITY] output format), ${REPO}/scripts/gates/check_exempted_rotation_age.ts (ts-morph Project/SyntaxKind walking + EXEMPTED dict + main(): number returning 1 on violation), ${REPO}/scripts/gates/_registry.ts and ${REPO}/scripts/gates/run_all.ts (how gates are registered + invoked), and ${REPO}/scripts/gates/check_exempted_lists_pointed.ts (what shape it expects of EXEMPTED dicts — your gate's EXEMPTED must conform so the meta-gates accept it).

CREATE ${REPO}/scripts/gates/check_clock_random.ts:
- ts-morph walk of PRODUCTION source ONLY: files matching \`libs/*/src/**/*.ts\` excluding \`*.test.ts\`. Do NOT scan scripts/, test/, tools/, migrations/, vendor/ (those legitimately use Date.now/crypto — e.g. check_exempted_rotation_age.ts uses Date.now for git-blame age; that must NOT be flagged).
- BANNED constructs (AST, not regex — so comments/strings don't false-match):
  * \`Date.now()\` (PropertyAccess Date.now called)  — banned everywhere except clock.ts
  * \`new Date()\` with ZERO arguments (new Date(arg) is fine — parsing a known instant) — banned except clock.ts
  * \`performance.now()\` — banned except clock.ts
  * \`process.hrtime(...)\` / \`process.hrtime.bigint()\` — banned except clock.ts
  * \`Math.random()\` — banned EVERYWHERE (SystemRandom uses crypto, not Math.random; SeededRandom is deterministic — nothing legitimately needs Math.random)
  * node:crypto randomness: \`randomBytes\`, \`randomInt\`, \`randomFillSync\`, \`randomUUID\`, \`getRandomValues\` — banned except randomness.ts
- ALLOWLIST (per-file): \`libs/platform/src/clock.ts\` may use Date.now/new Date()/performance.now/process.hrtime/setTimeout; \`libs/platform/src/randomness.ts\` may use node:crypto random fns. Math.random allowed in NEITHER.
- \`export const EXEMPTED: Record<string, { follow_up_story: string }> = {}\` (empty; shape matches the other gates so check_exempted_lists_pointed/rotation accept it).
- Emit \`[ERROR] file=<relpath>:<line> rule=clock_random message="<construct>: use injected Clock/Random from libs/platform" suggestion="import { WallClock } from libs/platform/src/clock.js / SystemRandom from randomness.js"\`. \`export function main(): number\` returns 1 if any violation else 0; print an \`[INFO] no-wall-clock(ts): 0 violations\` line when clean (mirror the Python gate's success line). Add a CLI shim (\`if (import.meta.url === ...) process.exit(main())\` — match how the sibling gates self-invoke).
- Register it in _registry.ts and run_all.ts the SAME way the existing 3 gates are registered.

CREATE ${REPO}/scripts/gates/check_clock_random.test.ts (vitest, ts-morph in-memory Project like check_exempted_rotation_age.test.ts if it exists — otherwise drive via temp fixtures):
- FLAGS: a libs/foo/src/bar.ts containing \`Date.now()\`, another with \`new Date()\` (0-arg), \`Math.random()\`, \`performance.now()\`, \`randomBytes(16)\`.
- ALLOWS: \`new Date(1700000000000)\` (arg given); the same banned calls when the file IS libs/platform/src/clock.ts (Date/perf) or randomness.ts (randomBytes); any usage under test/ or scripts/.
- main() returns 0 on a clean tree, 1 when a violation is present.

VERIFY: \`cd ${REPO} && npx tsx scripts/gates/check_clock_random.ts\` — MUST currently print 0 violations against the real tree (libs/contracts has no banned usage; libs/platform doesn't exist yet or contains only the allowlisted files). If it flags anything pre-existing, STOP and report it (do NOT add EXEMPTED entries to silence real pre-existing usage — surface it). Then \`npx vitest run scripts/gates/check_clock_random.test.ts\`, \`npx tsc -p tsconfig.json\`, \`npx eslint scripts/gates/check_clock_random.ts scripts/gates/check_clock_random.test.ts\` — all clean. Finally \`npx tsx scripts/gates/run_all.ts\` to confirm the gate is wired and the full gate suite still passes.

Return: files written, the registry/run_all edits you made, every command run + pass/fail, and confirm the gate reports 0 violations against the current real tree.`

const RANDOMNESS_BRIEF = `Port the randomness seam 1:1 to TypeScript with a faithful MT19937 so SeededRandom matches CPython's random.Random BIT-FOR-BIT, plus uuid7, plus the cross-impl parity harness that PROVES it against the live frozen Python. This is the crux of Task 0.7.
${STYLE}

SOURCE (read first): ${REPO}/vendor/codemaster-py/codemaster/infra/randomness.py — Random Protocol (random, uniform, randint, choice, shuffle, token_bytes), SystemRandom (crypto via stdlib SystemRandom + secrets.token_bytes), SeededRandom (random.Random(seed)), and uuid7(clock) (RFC 9562 §5.7; secrets.randbits for the 74 random bits; ts-prefix = int(clock.now().timestamp()*1000)).
Live consumer that makes bit-exact parity load-bearing: ${REPO}/vendor/codemaster-py/codemaster/adapters/embeddings_port.py uses SeededRandom(seed=N).uniform(-1.0, 1.0) to build deterministic vectors — so uniform()/random()/seeding MUST be exact.

=== FILE 1: ${REPO}/libs/platform/src/_mt19937.ts — internal MT19937 core matching CPython's _random + random.py EXACTLY ===
Implement as a class holding \`mt: Uint32Array(624)\` + \`mti: number\`. Keep ALL state uint32 via \`>>> 0\`; use \`Math.imul(a,b) >>> 0\` for the 32-bit multiplies (1812433253, 1664525, 1566083941). EXACT algorithm:

initGenrand(s): mt[0]=s>>>0; for i in 1..623: mt[i]=(Math.imul(1812433253,(mt[i-1]^(mt[i-1]>>>30)))+i)>>>0; mti=624.

initByArray(key: ReadonlyArray<number>):  // key entries are uint32
  initGenrand(19650218); let i=1,j=0; let k=Math.max(624,key.length);
  for(;k;k--){ mt[i]=((mt[i]^Math.imul((mt[i-1]^(mt[i-1]>>>30)),1664525))+key[j]+j)>>>0; i++;j++; if(i>=624){mt[0]=mt[623];i=1;} if(j>=key.length)j=0; }
  for(k=623;k;k--){ mt[i]=((mt[i]^Math.imul((mt[i-1]^(mt[i-1]>>>30)),1566083941))-i)>>>0; i++; if(i>=624){mt[0]=mt[623];i=1;} }
  mt[0]=0x80000000;

seed(n: number | bigint):  // mirror CPython random_seed for non-negative int: key = abs(n) split into LITTLE-ENDIAN uint32 words
  let v = (typeof n==="bigint"? (n<0n?-n:n) : BigInt(Math.abs(Math.trunc(n))));
  const key: number[] = []; if(v===0n) key.push(0); else while(v>0n){ key.push(Number(v & 0xffffffffn)); v >>= 32n; }
  initByArray(key);

genrandUint32(): if(mti>=624){ regenerate: const N=624,M=397,UP=0x80000000,LOW=0x7fffffff,A=0x9908b0df; let y;
    for(let kk=0;kk<N-M;kk++){ y=((mt[kk]&UP)|(mt[kk+1]&LOW))>>>0; mt[kk]=(mt[kk+M]^(y>>>1)^((y&1)?A:0))>>>0; }
    for(let kk=N-M;kk<N-1;kk++){ y=((mt[kk]&UP)|(mt[kk+1]&LOW))>>>0; mt[kk]=(mt[kk+(M-N)]^(y>>>1)^((y&1)?A:0))>>>0; }
    y=((mt[N-1]&UP)|(mt[0]&LOW))>>>0; mt[N-1]=(mt[M-1]^(y>>>1)^((y&1)?A:0))>>>0; mti=0; }
  let y=mt[mti++]; y^=y>>>11; y=(y^((y<<7)&0x9d2c5680))>>>0; y=(y^((y<<15)&0xefc60000))>>>0; y^=y>>>18; return y>>>0;

randomDouble() (== Python random()/genrand_res53): const a=this.genrandUint32()>>>5; const b=this.genrandUint32()>>>6; return (a*67108864.0+b)*(1.0/9007199254740992.0);  // exact IEEE-754, matches Python bit-for-bit

getrandbits(k: number): number | bigint:
  if(k<=32) return this.genrandUint32()>>>(32-k);   // k=32 -> >>>0 (full word)
  let result=0n,shift=0n,kk=k; while(kk>0){ const take=Math.min(kk,32); const r=this.genrandUint32()>>>(32-take); result |= BigInt(r>>>0)<<shift; shift+=32n; kk-=32; } return result;

randbelow(n: number): number:  // _randbelow_with_getrandbits; n>0
  if(n<=0) return 0; const k=32-Math.clz32(n-1>0? n : 1); // bit_length(n): use n.toString(2).length OR for n in int32: 32-Math.clz32(n). Compute k = bit_length(n) EXACTLY (k such that 2^(k-1) <= n <= 2^k-1; for n=1 -> k=1; n=256 -> k=9). Use: let k=0,t=n; while(t>0){t>>=1;k++;}
  let r=this.getrandbits(k) as number; while(r>=n) r=this.getrandbits(k) as number; return r;
  // IMPORTANT: compute bit_length as the while-shift above (do NOT rely on clz32 hand-waving) — for n=256, bit_length=9 so getrandbits(9)∈[0,511] with rejection ≥256. This MUST match Python or token_bytes/randint diverge.

Then the public-ish methods (used by SeededRandom): randint(a,b)= a + randbelow(b-a+1); uniform(a,b)= a+(b-a)*randomDouble(); choice(seq)= seq[randbelow(seq.length)]; shuffle(x: unknown[])= for(let i=x.length-1;i>=1;i--){const j=randbelow(i+1); [x[i],x[j]]=[x[j],x[i]];}; tokenBytes(n)= Uint8Array where each byte = randbelow(256).

=== FILE 2: ${REPO}/libs/platform/src/randomness.ts ===
- import { type Clock, WallClock } from "./clock.js"; import { Mt19937 } from "./_mt19937.js"; import * as crypto from "node:crypto".
- \`export type Random = { random(): number; uniform(a:number,b:number):number; randint(a:number,b:number):number; choice<T>(seq: ReadonlyArray<T>): T; shuffle<T>(seq: Array<T>): void; tokenBytes(n:number): Uint8Array }\`. (Mirror Python's method names but camelCase: token_bytes -> tokenBytes; keep this 1:1 mapping documented.)
- \`export class SystemRandom implements Random\`: cryptographically-secure (mirrors Python SystemRandom/secrets). random()=> read 53 bits via crypto.randomBytes -> same genrand_res53 formula using crypto words (a=top27,b=top26) OR use crypto.randomInt for randint; tokenBytes(n)=> new Uint8Array(crypto.randomBytes(n)); uniform/choice/shuffle in terms of those. It is NOT seedable and NOT value-parity-checked (crypto entropy) — only structural/range behavior matters. This is the ONLY file allowed to call node:crypto random (the gate allowlists it).
- \`export class SeededRandom implements Random\`: constructor({ seed }: { seed: number }) builds a Mt19937 and seeds it; delegates every method to the Mt19937 core. Deterministic.
- \`export function uuid7({ clock }: { clock?: Clock } = {}): string\`:  RFC 9562 §5.7. const c = clock ?? new WallClock(); const ms = Math.trunc(c.now().getTime());  // 48-bit unix-ms
    tsHex = ms.toString(16).padStart(12,"0").slice(-12);  randA = crypto.randomInt(0, 1<<12); verAndRandA = (0x7<<12)|randA (16 bits -> 4 hex); for the 64-bit var+rand_b use two crypto words: hi = (0b10<<30)|crypto.randomInt(0,1<<30) is wrong width — instead build 62 random bits via crypto and prepend variant 0b10: use a BigInt: randB = BigInt('0x'+crypto.randomBytes(8).toString('hex')) & ((1n<<62n)-1n); varAndRandB = (0b10n<<62n)|randB (64 bits -> 16 hex). hexStr = tsHex + verAndRandA.toString(16).padStart(4,'0') + varAndRandB.toString(16).padStart(16,'0'); return formatted as canonical UUID (8-4-4-4-12 with hyphens). Return a lowercase hyphenated UUID string (Python returns a uuid.UUID whose str() is hyphenated lowercase — match that). Document: the 74 random bits use crypto (NOT seeded), so run_ids always differ across impls BY DESIGN (run_id is ephemeral execution identity, parity-excluded by value); only the 48-bit ts prefix + version nibble + variant bits are deterministic/parity-checkable.

=== FILE 3: ${REPO}/tools/parity/run_random_ref.py — dedicated stateful randomness driver (do NOT reuse run_python_ref.py; it canonicalizes & rejects bare floats) ===
Long-lived JSONL stdin->stdout, cwd=submodule so \`import codemaster\` resolves the frozen source. Drives the REAL frozen classes:
- {"id","kind":"seeded","seed":N,"calls":[ {"m":"random"} | {"m":"randint","a":A,"b":B} | {"m":"uniform","a":A,"b":B} | {"m":"choice","seq":[...]} | {"m":"shuffle","seq":[...]} | {"m":"token_bytes","n":N} ]} -> run ALL calls IN ORDER on ONE \`SeededRandom(seed=N)\` from codemaster.infra.randomness; emit {"id","ok":true,"out":[encoded...]} where: random/uniform -> {"f": struct.pack(">d", value).hex()} (IEEE-754 hex, exact); randint -> {"i": int}; choice -> {"c": element}; shuffle -> {"s": resulting_list}; token_bytes -> {"b": value.hex()}.
- {"id","kind":"uuid7","ms":M} -> fc = FakeClock(now=datetime(1970,1,1,tzinfo=UTC)+timedelta(milliseconds=M)); u = uuid7(clock=fc); emit {"id","ok":true,"out":{"uuid": str(u)}}.
- On exception emit {"id","ok":false,"err":"..."} and keep running.

=== FILE 4: ${REPO}/test/parity/random_oracle.ts — TS side of the driver (mirror ${REPO}/test/parity/oracle.ts spawn pattern) ===
spawn vendor/codemaster-py/.venv/bin/python tools/parity/run_random_ref.py (cwd=submodule); request/response by id over readline JSONL; export \`seededRef({seed, calls})\` and \`uuid7Ref({ms})\` returning the decoded Python results; export \`shutdownRandomRef()\`. Helper to compare a JS double to a ">d" hex: \`doubleToHex(x:number)\` via \`const b=Buffer.alloc(8); b.writeDoubleBE(x); return b.toString("hex")\`.

=== FILE 5: ${REPO}/test/unit/infra/randomness.test.ts ===
- SeededRandom(seed:42) is deterministic: two instances produce identical first-10 random() sequences; different seeds differ.
- randint within [a,b]; choice returns a member; shuffle is a permutation (same multiset); tokenBytes(n) length n.
- uuid7: returns 8-4-4-4-12 lowercase; version nibble (15th hex char, index 14) is "7"; variant high bits are 0b10 (the 17th hex nibble & 0xc === 0x8); two calls at the same fixed clock share the first 12 hex (ts prefix) but differ overall (random bits); ts prefix matches Math.trunc(clock.now().getTime()).toString(16).padStart(12,'0').
- SystemRandom: random() ∈ [0,1); randint within range; tokenBytes length.

=== FILE 6: ${REPO}/test/parity/randomness.parity.test.ts — THE PROOF (afterAll(shutdownRandomRef)) ===
For each seed in [0,1,42,2024,4294967295] drive ONE mixed call-list through BOTH SeededRandom(seed) (TS) and seededRef (frozen Python) and assert EXACT equality:
- 20× random()  -> compare doubleToHex(ts) === py.f for each (bit-exact).
- 20× randint(0,1_000_000) and randint(-50, 50) -> ts === py.i.
- 20× uniform(-1.0, 1.0) -> doubleToHex bit-exact (this is the embeddings_port-load-bearing path).
- choice(["a".."j"]) ×10 -> ts === py.c. shuffle([0..15]) -> ts array === py.s. token_bytes(32) -> hex(ts) === py.b.
  CRITICAL: build the SAME ordered call-list on both sides so the MT stream advances identically; interleave methods to prove cross-method stream consistency, not just isolated methods.
- Include a seed/range that forces _randbelow REJECTION (e.g. randint(0, 2) repeatedly, or token_bytes which uses randbelow(256)) so the rejection-sampling path is proven, not just the happy path.
- uuid7 ts-prefix parity: for ms in [0, 1_000_000_000_000, 1_735_689_600_000 (whole-second instants → zero float ambiguity)], TS uuid7({clock: new FakeClock({now: new Date(ms)})}).slice(0,13).replace('-','') first-12-hex === uuid7Ref({ms}).uuid first-12-hex; assert version+variant equal; assert the random tails DIFFER (uniqueness).

TDD: write randomness.parity.test.ts FIRST, run it, CONFIRM RED (no impl). Then implement _mt19937.ts + randomness.ts + the driver and iterate \`cd ${REPO} && npx vitest run test/parity/randomness.parity.test.ts\` until FULLY GREEN against the live Python. If any float diverges, the bug is in seeding or genrand — re-check init_by_array word-splitting and Math.imul masking. Then \`npx tsc -p tsconfig.json\` + \`npx eslint libs/platform/src/_mt19937.ts libs/platform/src/randomness.ts test/unit/infra/randomness.test.ts test/parity/randomness.parity.test.ts\` clean.

Return: files written, the FINAL vitest output lines for both test files (must show passing counts), tsc/eslint results, and explicitly state whether SeededRandom achieved BIT-EXACT parity across all 5 seeds (yes/no; if no, what diverged).`

const [clockRes, gateRes, randRes] = await parallel([
  () => agent(CLOCK_BRIEF, { label: 'clock.ts + test', phase: 'Build', schema: BUILD_SCHEMA }),
  () => agent(GATE_BRIEF, { label: 'check_clock_random gate', phase: 'Build', schema: BUILD_SCHEMA }),
  () => agent(RANDOMNESS_BRIEF, { label: 'mt19937 + randomness + parity', phase: 'Build', schema: BUILD_SCHEMA }),
])

// =================================================================================================
phase('Verify')

const VERIFY_BRIEF = `You are an ADVERSARIAL cross-impl parity verifier for the just-built TypeScript randomness primitives. Your job is to REFUTE the claim "SeededRandom matches CPython random.Random bit-for-bit and uuid7's time-encoding matches". Default to skeptical.
${STYLE}

The build agent reported: ${'${RAND_SUMMARY}'}

Do this:
1. Independently drive the LIVE frozen Python directly (do NOT trust the build's test). Run e.g.:
   cd ${REPO}/vendor/codemaster-py && .venv/bin/python -c "from codemaster.infra.randomness import SeededRandom; import struct; r=SeededRandom(seed=42); print([struct.pack('>d',r.random()).hex() for _ in range(5)]); r2=SeededRandom(seed=42); print([r2.randint(0,1000000) for _ in range(5)]); r3=SeededRandom(seed=42); print([struct.pack('>d',r3.uniform(-1.0,1.0)).hex() for _ in range(3)]); r4=SeededRandom(seed=42); print(r4.token_bytes(16).hex())"
   and similarly for seed=0 and seed=4294967295.
2. Independently compute the TS side: write a throwaway script (e.g. ${REPO}/tools/parity/_verify_scratch.ts, DELETE it when done) that imports SeededRandom from libs/platform/src/randomness.js, runs the SAME ordered calls, and prints doubleToHex(random()) / randint / doubleToHex(uniform) / hex(tokenBytes). Run it with \`npx tsx\`. Compare the two outputs YOURSELF, value by value. They must be byte-identical.
3. Confirm the parity test is REAL, not vacuous: open test/parity/randomness.parity.test.ts and check it actually compares doubleToHex(ts) to py.f with toBe/expect (not skipped, not \`.todo\`, not comparing a value to itself). Run \`cd ${REPO} && npx vitest run test/parity/randomness.parity.test.ts test/unit/infra/randomness.test.ts\` and read the pass counts.
4. Adversarial probes: (a) a seed forcing many _randbelow rejections — randint(0,3) ×30 on both sides; (b) interleaved methods (random, randint, uniform, choice, shuffle in one stream) on both sides — proves the MT word-stream stays in lockstep across method boundaries; (c) uuid7 at a non-whole-second ms (e.g. 1_735_689_600_123) — note whether ts-prefix still matches (document any float-truncation divergence; whole-second instants must match exactly).
5. Confirm uuid7 random tails DIFFER between two calls (uniqueness) and version=7 / variant=0b10.

Be specific: if ANYTHING diverges, give the exact seed, method, call-index, py hex vs ts hex. Clean up any scratch file you created (do not leave _verify_scratch.ts or git-add anything).`.replace('${RAND_SUMMARY}', JSON.stringify(randRes).slice(0, 1200))

const verify = await agent(VERIFY_BRIEF, { label: 'adversarial parity verify', phase: 'Verify', schema: VERIFY_SCHEMA })

return {
  build: { clock: clockRes, gate: gateRes, randomness: randRes },
  verify,
}
