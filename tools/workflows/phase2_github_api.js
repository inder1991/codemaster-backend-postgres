export const meta = {
  name: 'phase2-github-api',
  description: 'Phase 2: GitHub cassette HTTP transport (2.12) + API client retry/backoff/X-RateLimit/401-refresh-once (2.9)',
  phases: [
    { title: 'Cassette', detail: 'CassetteHttpClient replay transport (ports infra/cassettes.py)' },
    { title: 'ApiClient', detail: 'GitHubApiClient retry/backoff + X-RateLimit + 401-refresh-once (cassette-tested)' },
    { title: 'Verify', detail: 'adversarial: retry-on-5xx, rate-limit wait, 401-refresh-once, backoff values match Python' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\`; NO \`any\` (use \`unknown\`); named exports; explicit return types; \`import { type X }\`; no unused vars; snake_case filenames.
IMPORTS: Node subpath aliases \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`; cross-dir aliases, same-dir relative.
GATE: apps/backend/src/backend/** scanned by check_clock_random — NO raw Date.now/Math.random; the API client's backoff/timing uses the injected #platform Clock (clock.sleep), never setTimeout/Date directly.
NO NEW DEPS for HTTP: use Node's built-in global \`fetch\` (undici) for the real transport; js-yaml (already a dep) for cassette parsing. No axios/node-fetch.
GUARDRAILS: touch ONLY your files. NO eslint --fix on the repo; NO git add/commit; NO database; NO live network (cassette replay only). You are the ONLY workflow running; \`npx tsc -p tsconfig.json\` should be clean. Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python).
RUN BEFORE RETURNING (all must pass): \`cd ${REPO} && npx vitest run <your test>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every passed.
`

phase('Cassette')

const CASSETTE = `Port the cassette HTTP replay transport 1:1 to TypeScript (Task 2.12) — the deterministic replay seam the GitHub API client is tested against (analogue of the Bedrock replay seam).
${STYLE}
READ FULLY: ${REPO}/vendor/codemaster-py/codemaster/infra/cassettes.py (the Cassette pydantic model + CassetteHttpClient: from_path loads a YAML cassette; request(method, url, ...) matches the request against the NEXT interaction by cursor and returns the recorded response; behavior on mismatch / cassette-exhausted). Also read a sample cassette to learn the YAML shape: ${REPO}/test/cassettes/github/get_pr.yaml and installation_token_success.yaml (these are the recorded interactions the API-client tests replay — they were recorded by the frozen Python; your TS reader MUST parse the SAME YAML format).
PORT to ${REPO}/apps/backend/src/backend/infra/cassettes.ts (or test/ infra if it's test-only — judge from how Python uses it; the API client takes an injected http client, and the cassette is the test double): a \`CassetteHttpClient\` with \`static fromPath(path): CassetteHttpClient\` (js-yaml load) + \`request({ method, url, ... }): Promise<{ status; headers; body }>\` matching the next interaction (cursor advance), raising on mismatch / exhaustion exactly like Python. Define a Cassette type (Zod or a plain type) mirroring the YAML shape (interactions[].request/response).
Test ${REPO}/test/unit/infra/cassettes.test.ts: replays test/cassettes/github/*.yaml — sequential interaction matching, cursor advance, mismatch → raises, exhausted → raises. Assert the recorded status/headers/body come back. (This client is the harness the API-client agent will use — return its EXACT API so that agent can call it.)
Return component="cassette", files_written, commands, all_green, notes (the cassette YAML shape, the exact CassetteHttpClient API: fromPath + request signature + mismatch/exhaustion behavior — the API-client agent depends on this).`

const cassette = await agent(CASSETTE, { label: 'cassette', phase: 'Cassette', schema: BUILD_SCHEMA })

phase('ApiClient')

const APICLIENT = `Port the GitHub API client 1:1 to TypeScript (Task 2.9): retry/backoff on 5xx, X-RateLimit handling, 401-refresh-once. Tested deterministically via the cassette transport just built.
${STYLE}
The cassette transport is ready: ${JSON.stringify(cassette).slice(0, 600)}
READ FULLY: ${REPO}/vendor/codemaster-py/codemaster/integrations/github/api_client.py — GitHubApiClient.__init__({ token_provider, session_factory?, base_url, timeout_seconds, client?, clock? }) and the _request loop. Port the EXACT semantics: the MAX_5XX_RETRIES loop with INITIAL_BACKOFF_SECONDS exponential backoff (confirm the constants + the backoff progression + whether it's doubling/jittered — read precisely), 5xx → retry after clock.sleep(backoff); 401 → refresh the token via token_provider ONCE then retry (attempt_401 latch); X-RateLimit-Remaining==0 / X-RateLimit-Reset → wait until reset (read the exact header-parse + wait logic); the public methods built on _request (get_pr, get_pr_files, get_installation_repositories, create installation token, post comment, etc. — port the ones the cassettes cover). Confirm constants + signatures by reading the source (the help()/inspect via .venv/bin/python is available).
PORT to ${REPO}/apps/backend/src/backend/integrations/github/api_client.ts: a \`GitHubApiClient\` whose HTTP is an INJECTED client (default = global fetch wrapper; tests inject the CassetteHttpClient). All timing (backoff, rate-limit wait) via the injected #platform Clock (clock.sleep) — NEVER setTimeout/Date (the gate enforces this). token_provider is injected (async (installationId) => token). Preserve the retry/refresh/rate-limit decisions 1:1 (these are the byte-significant logic; the HTTP execution differs httpx→fetch but the DECISIONS must match).
Test ${REPO}/test/unit/integrations/github/api_client.test.ts using the CassetteHttpClient + a FakeClock (assert recorded backoff sleeps via clock.recordedSleeps()) + an in-memory token_provider: (a) 5xx-then-200 → retries, correct backoff sleeps, returns the 200; (b) 5xx exhausted (MAX retries) → raises; (c) 401-then-200 → refreshes token ONCE (token_provider called twice), retries, succeeds; second 401 → does NOT refresh again (raises); (d) X-RateLimit exhausted → waits until reset (FakeClock sleep recorded) then proceeds; (e) a happy GET replays a real cassette (test/cassettes/github/get_pr.yaml). Author small purpose-built cassettes for the 5xx/401/ratelimit scenarios if the existing corpus lacks them.
Return component="apiclient", files_written, commands, all_green, notes (constants/backoff progression confirmed, which methods ported, 401-once + rate-limit-wait semantics, cassettes used/authored).`

const apiclient = await agent(APICLIENT, { label: 'apiclient', phase: 'ApiClient', schema: BUILD_SCHEMA })

phase('Verify')
const verify = await agent(`ADVERSARIAL verifier for the GitHub API client + cassette transport. REFUTE that the retry/backoff/rate-limit/401-refresh semantics match the frozen Python.
${STYLE}
Built: cassette=${JSON.stringify(cassette).slice(0, 300)} | apiclient=${JSON.stringify(apiclient).slice(0, 400)}
Independently (read the frozen api_client.py for the EXACT constants + logic; drive the TS via a throwaway ${REPO}/tools/parity/_api_scratch.ts — DELETE after, no git-add):
1. BACKOFF progression: confirm MAX_5XX_RETRIES + INITIAL_BACKOFF_SECONDS + the exact backoff sequence (e.g. 1,2,4 or with jitter) MATCH the frozen source value-for-value; the TS test asserts clock.recordedSleeps() equals that exact sequence.
2. 401-REFRESH-ONCE: a single 401 refreshes the token exactly once (token_provider called twice) and retries; a SECOND consecutive 401 does NOT refresh again — it raises (the attempt_401 latch). Confirm both.
3. RATE-LIMIT: X-RateLimit-Remaining==0 → waits until X-RateLimit-Reset (the exact wait computation: reset - now, via clock) then proceeds; confirm the wait value matches Python's parse.
4. 5xx EXHAUSTION raises after MAX retries (not infinite); a 4xx (non-401) does NOT retry.
5. Cassette transport: sequential matching + cursor advance; mismatch and exhaustion raise (don't silently return a wrong/empty response).
6. Run \`cd ${REPO} && npx vitest run test/unit/integrations/github/api_client.test.ts test/unit/infra/cassettes.test.ts\`; \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations (NO setTimeout/Date in the client — all timing via Clock); \`npx tsc -p tsconfig.json\` clean.
verdict=WEAK if backoff/retry/401/rate-limit logic diverges from Python, timing bypasses the Clock seam, or a test is vacuous; SOUND otherwise. Exact reproduction for failures. Clean up scratch.`, { label: 'verify:github-api', phase: 'Verify', schema: VERIFY_SCHEMA })

return { cassette, apiclient, verify }
