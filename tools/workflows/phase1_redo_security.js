export const meta = {
  name: 'phase1-redo-security',
  description: 'Redo trust-tier wrapping + output-safety/coercion 1:1 (sequential, single workflow), parity vs frozen Python',
  phases: [
    { title: 'TrustTier', detail: 'injection_defense: wrap_untrusted + strip_privileged_tags + byte-exact CPython html.unescape' },
    { title: 'OutputSafety', detail: 'contract_coercion.coerce_for_contract + OutputSafetyValidator' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subsystem', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    subsystem: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, new_contracts: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subsystem', 'verdict', 'checks', 'issues'],
  properties: {
    subsystem: { type: 'string' }, verdict: { type: 'string', enum: ['FAITHFUL', 'DRIFT', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    test_is_real: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\`; NO \`any\`; named exports; explicit return types on exported fns; \`import { type X }\` (use \`import type\` when ALL names in a declaration are types — a real eslint error otherwise); no unused vars; snake_case filenames; camelCase locals, PascalCase types, CAPITALIZED consts.
IMPORTS: Node subpath aliases \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`. Cross-dir aliases; same-dir/sub-dir relative.
GATE: apps/backend/src/backend/** scanned by check_clock_random — NO raw Date.now/Math.random/node:crypto-random.
HARNESS: GENERIC oracle (test/parity/oracle.ts::assertParity/pyRef) for module-level pure fns returning JSON-safe data; DEDICATED driver (mirror tools/parity/run_redact_ref.py + a <sub>_oracle.ts) for class methods / contract-class args / bare floats.
TEMPLATE: redact subsystem (commit 89691ed). GUARDRAILS: touch ONLY your subsystem's files; NO eslint --fix on the repo; NO git add/commit; NO database. You are the ONLY workflow running — no concurrent streams; \`npx tsc -p tsconfig.json\` should be fully clean (any error is yours, fix it). Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python = CPython 3.14).
RUN THESE BEFORE RETURNING (all must pass): \`cd ${REPO} && npx vitest run <your test file(s)>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every one passed (the previous attempt stalled before verifying and shipped lint errors + a dead unused helper — do NOT repeat that).
`

// =================================================================================================
phase('TrustTier')

const TRUST_PORT = `Port the codemaster trust-tier input-wrapping subsystem 1:1 (SECURITY-CRITICAL: byte-parity mandatory; ANY divergence from Python is a finding).
${STYLE}
Python source: ${REPO}/vendor/codemaster-py/codemaster/security/injection_defense.py — READ IT FULLY. Entries (MODULE-LEVEL PURE → GENERIC oracle): \`wrap_untrusted(content)\`, \`wrap_untrusted_manifest(content)\`, \`strip_privileged_tags(content)\`, plus STRIPPED_TAGS + the wrapper constants. Confirm via help().

CRITICAL — strip_privileged_tags does \`html.unescape(content)\` FIRST, then \`_STRIP_RE.sub("", decoded)\` where _STRIP_RE = re.compile(r"</?\\s*(?:TAG|…)\\b[^<>]*/?\\s*>", re.IGNORECASE) over STRIPPED_TAGS. You MUST port CPython's html.unescape BYTE-EXACT:
- CREATE ${REPO}/apps/backend/src/backend/security/html_entities_data.ts — the HTML5 named character reference table. GENERATE it from the frozen interpreter, do NOT hand-type: \`cd vendor/codemaster-py && .venv/bin/python -c "import html.entities,json; print(json.dumps(html.entities.html5, ensure_ascii=False))"\` → emit as a \`ReadonlyMap<string,string>\` (or const record) named HTML5_ENTITIES with EXACTLY those keys (note: some keys have a trailing ';', some don't — preserve both forms verbatim). This file legitimately contains bidi/control characters → add a file-level \`/* eslint-disable security/detect-bidi-characters */\` with a WHY comment.
- CREATE ${REPO}/apps/backend/src/backend/security/html_unescape.ts — \`export function htmlUnescape(s: string): string\` reproducing CPython html.unescape EXACTLY: replace \`&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\\t\\n\\f <&#;]{1,32};?)\` per CPython's _charref regex + _replace_charref: numeric refs → _invalid_charrefs / _invalid_codepoints handling (0x00→U+FFFD, the 0x80-0x9F C1→cp1252 remap table, >0x10FFFF or surrogates → U+FFFD, the specific invalid set); named refs → longest-match against HTML5_ENTITIES trying with-semicolon then without (the CPython "if name in html5 … else try progressively shorter" loop). Match CPython's algorithm step-for-step — read CPython Lib/html/__init__.py if unsure; verify against the live interpreter over tricky inputs (&lt;, &lt without semi, &#60;, &#x3c;, &amp;, &notit;, &notin;, malformed &, &#0;, &#x110000;).
- CREATE ${REPO}/apps/backend/src/backend/security/trust_tier_wrapping.ts — wrapUntrusted/wrapUntrustedManifest/stripPrivilegedTags importing \`./html_unescape.js\`. Wrapper shape EXACTLY \`<diff trust="untrusted">\`…\`</diff trust="untrusted">\` (closing tag repeats the attribute). Port _build_tag_stripper's regex 1:1 (case-insensitive, the [^<>] attribute class, optional self-close).

Test: ${REPO}/test/parity/trust_tier_wrapping.parity.test.ts (GENERIC oracle assertParity vs ${'codemaster.security.injection_defense'}): cases — plain text; embedded </diff trust="untrusted">, <manifest trust="untrusted">, <knowledge trust="trusted">, bare <diff>; ENTITY-ENCODED &lt;diff&gt; / &#60;diff&#62; (must be decoded then stripped — the html.unescape path); nested/adjacent; unicode; empty. Assert wrapUntrusted + stripPrivilegedTags byte-identical to Python. ALSO push 3-4 vendor/codemaster-py/tests/corpora/prompt_injection/*.yaml inputs through wrapUntrusted and confirm identical to Python. AND a direct htmlUnescape parity sub-test over ~15 tricky entity inputs vs python html.unescape.
TDD red→green. Return subsystem="trust_tier", files_written, new_contracts ([]), every command+pass/fail, all_green, notes (html.unescape edge cases handled).`

const trustPort = await agent(TRUST_PORT, { label: 'port:trust_tier', phase: 'TrustTier', schema: BUILD_SCHEMA })
const trustVerify = await agent(`ADVERSARIAL verifier for the just-ported trust-tier wrapping (SECURITY boundary — byte-parity mandatory). REFUTE it matches frozen Python.
${STYLE}
Port: ${JSON.stringify(trustPort).slice(0, 800)}
Independently (drive LIVE frozen Python + TS via a throwaway ${REPO}/tools/parity/_trust_scratch.ts — DELETE after, no git-add):
1. wrapUntrusted/stripPrivilegedTags byte-identical to Python over: each STRIPPED_TAG (probe every tag), entity-encoded &lt;diff&gt; + &#60;diff&#62; (decode-then-strip), nested, a real prompt_injection corpus closing-tag entry, unicode, empty.
2. htmlUnescape === python html.unescape over 20 tricky inputs incl. &notit;/&notin; (longest-match), &#0;→U+FFFD, &#x80;→€ (cp1252 C1 remap), &#xD800;→U+FFFD (surrogate), &#x110000;→U+FFFD (out of range), bare &lt without semicolon, &amp;lt;. ANY mismatch = DRIFT.
3. Test is REAL (imports TS, awaits oracle spawning frozen venv python, asserts equality — not vacuous). Run \`cd ${REPO} && npx vitest run test/parity/trust_tier_wrapping.parity.test.ts\`.
4. \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations.
verdict=DRIFT on any mismatch/vacuous test; FAITHFUL only if all hold. Exact reproduction for failures. Clean up scratch.`, { label: 'verify:trust_tier', phase: 'TrustTier', schema: VERIFY_SCHEMA })

// =================================================================================================
phase('OutputSafety')

const OS_PORT = `Port the codemaster output-safety subsystem 1:1. The PREVIOUS attempt stalled and left an INCOMPLETE coercion (a dead unused unwrapEffects helper whose docstring said it should normalize .superRefine/.strict()-wrapped contracts before WeakMap lookup) — do NOT repeat; wire the contract-unwrapping fully.
${STYLE}
PLAN DRIFT (confirmed): \`coerce_for_contract\` lives in codemaster/llm/contract_coercion.py — NOT output_safety.py. Port BOTH:
(a) coerce_for_contract (codemaster/llm/contract_coercion.py) → ${REPO}/apps/backend/src/backend/llm/contract_coercion.ts.
(b) OutputSafetyValidator (codemaster/security/output_safety.py) → ${REPO}/apps/backend/src/backend/security/output_safety.ts.
FIRST confirm both signatures via help() AND read the frozen tests under vendor/codemaster-py/tests/ for coerce_for_contract + OutputSafetyValidator to determine the REAL acceptance (the plan's "coerce strips injection with 0.95 recall" CONFLATES coercion with injection-stripping — figure out which module does what; coerce_for_contract is the LLM-output→contract coercion the Task-0.4 gate requires before model_validate; OutputSafetyValidator is the validation/secret-span pass). If OutputSafetyValidator uses html.unescape, IMPORT the existing ${REPO}/apps/backend/src/backend/security/html_unescape.ts (built in the TrustTier phase — reuse, do not duplicate).
coerce_for_contract(payload, contract, …) takes a CONTRACT CLASS arg → build a DEDICATED driver ${REPO}/tools/parity/run_output_safety_ref.py + test/parity/output_safety_oracle.ts that maps a contract-NAME string → the real Pydantic contract class. The TS coerceForContract takes the matching Zod contract; FULLY implement the schema introspection — to inspect/coerce fields you MUST unwrap Zod \`.strict()\` / \`.superRefine()\` / \`.refine()\` (ZodEffects) wrappers to reach the underlying ZodObject (the registered contracts are \`z.object({...}).strict().superRefine(...)\`); a half-wired unwrap that leaves the helper unused is a BUG. Registered LLM-output contracts (CLAUDE.md): WalkthroughV1, ReviewFindingV1, ReviewChunkResponseV1, ArbitrationIntentV1 — already ported to #contracts/*.
Test: ${REPO}/test/parity/output_safety.parity.test.ts — drive a corpus of MALFORMED LLM payloads (reuse vendor tests' malformed fixtures e.g. tests/fixtures/malformed_llm_outputs if present; else author 6-8 covering over-length string fields, wrong types, missing/extra keys, 1.0-vs-1 floats, nested) through coerce on BOTH impls and assert byte-parity of the coerced output. Add whatever validation/recall acceptance the frozen tests actually enforce.
TDD red→green. Return subsystem="output_safety", files_written, new_contracts, every command+pass/fail, all_green (ONLY if vitest+tsc+eslint+gate all green — verify before reporting), notes (the REAL acceptance you found, the contract-unwrap approach, fixtures).`

const osPort = await agent(OS_PORT, { label: 'port:output_safety', phase: 'OutputSafety', schema: BUILD_SCHEMA })
const osVerify = await agent(`ADVERSARIAL verifier for the just-ported output-safety (coerce_for_contract + OutputSafetyValidator). REFUTE it matches frozen Python.
${STYLE}
Port: ${JSON.stringify(osPort).slice(0, 800)}
Independently (drive LIVE frozen Python + TS via throwaway ${REPO}/tools/parity/_os_scratch.ts — DELETE after, no git-add):
1. Confirm coerce_for_contract + OutputSafetyValidator signatures match frozen source; confirm the port's claimed ACCEPTANCE matches what the frozen tests actually enforce.
2. coerce over 6+ malformed payloads (over-length string, wrong type, missing required, extra key, 1.0-vs-1 float, deeply nested) on BOTH impls → coerced output identical. Probe a contract that is .strict().superRefine(...)-wrapped (e.g. ReviewFindingV1) and confirm the TS coercion actually reaches + coerces inner fields (the prior attempt's unwrap was dead — verify it's now LIVE by coercing a finding payload that needs inner-field coercion).
3. Test is REAL (imports TS, awaits the driver spawning frozen venv python, asserts equality). Run \`cd ${REPO} && npx vitest run test/parity/output_safety.parity.test.ts\`.
4. \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations; confirm NO dead/unused exported helpers remain (grep).
verdict=DRIFT if TS≠Python OR the contract-unwrap is still dead OR a test is vacuous; FAITHFUL only if all hold. Clean up scratch.`, { label: 'verify:output_safety', phase: 'OutputSafety', schema: VERIFY_SCHEMA })

return {
  trust_tier: { port: trustPort, verify: trustVerify },
  output_safety: { port: osPort, verify: osVerify },
}
