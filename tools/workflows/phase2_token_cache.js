export const meta = {
  name: 'phase2-token-cache',
  description: 'Phase 2.8: installation-token cache (in-memory, 30s refresh margin, per-installation async lock, JWT-Bearer exchange)',
  phases: [
    { title: 'Port', detail: 'InstallationTokenV1 contract + InstallationTokenCache + getInstallationToken + keyed async mutex' },
    { title: 'Verify', detail: 'adversarial: TTL margin, per-installation lock serializes (one exchange), 401/4xx, cassette exchange' },
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
GATE: apps/backend/src/backend/** scanned by check_clock_random — NO raw Date.now/Math.random; the cache's "now" comes from the injected #platform Clock; the async lock uses promises (NO setTimeout).
NO NEW DEPS; NO DATABASE (this cache is IN-MEMORY — the Python InstallationTokenCache is a dict, NOT cache.cache_tokens). HTTP is an injected client; tests use the CassetteHttpClient (#backend/infra/cassettes.js, built in 2.12) for the token-exchange POST.
GUARDRAILS: touch ONLY your files. NO eslint --fix on the repo; NO git add/commit; NO network. You are the ONLY workflow running; \`npx tsc -p tsconfig.json\` should be clean. Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python).
RUN BEFORE RETURNING (all must pass): \`cd ${REPO} && npx vitest run <your test>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every passed.
`

phase('Port')

const PORT = `Port the GitHub installation-token cache 1:1 to TypeScript (Task 2.8): in-memory per-installation cache with a 30s refresh margin, a per-installation async lock (thundering-herd protection), and the JWT-Bearer token exchange.
${STYLE}
READ FULLY: ${REPO}/vendor/codemaster-py/codemaster/integrations/github/installation_token.py. Constants: INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS=30, INSTALLATION_TOKEN_HTTP_PATH="/app/installations/{installation_id}/access_tokens". Entities: InstallationTokenV1 (BaseModel: token: str with a non-whitespace-only validator, expires_at: datetime — it lives INLINE in this module, NOT in contracts/, so port it as a contract); InstallationTokenCache (in-memory _store dict + _locks dict of asyncio.Lock + get_fresh [returns cached unless cached.expires_at - 30s <= clock.now()] + put + invalidate); get_installation_token(*, installation_id, jwt_token, http, cache, base_url) [cache.get_fresh hit→return; else acquire per-installation lock → RE-CHECK get_fresh inside the lock (double-check) → http.post(base_url+path, headers {Accept, Authorization: Bearer <jwt>, X-GitHub-Api-Version: 2022-11-28}) → 401→GitHubAppUnauthorized → >=400→GitHubAppUnauthorized → parse body {token, expires_at (ISO, Z→+00:00)} → InstallationTokenV1 → cache.put → return].

PORT to:
- ${REPO}/libs/contracts/src/installation_token.v1.ts — InstallationTokenV1 (Zod): token z.string().refine(non-whitespace-only, min 1?), expires_at as the datetime (mirror how other contracts handle datetime — string ISO + the canonicalizer's .ffffff+00:00). Add a Pydantic↔Zod parity test (mirror a sibling contract test).
- ${REPO}/apps/backend/src/backend/integrations/github/installation_token.ts — InstallationTokenCache class (Map<number, InstallationTokenV1>, getFresh using the injected #platform Clock + the 30s margin, put, invalidate) + getInstallationToken({ installationId, jwtToken, http, cache, baseUrl }). GitHubAppUnauthorized error (reuse the one from #backend/integrations/github/api_client.js if exported there, else define).
- The PER-INSTALLATION ASYNC LOCK (the load-bearing concurrency piece — JS has no asyncio.Lock): implement a small keyed mutex (e.g. a Map<number, Promise> tail-chain, or a KeyedMutex class) so that CONCURRENT getInstallationToken calls for the SAME installationId run the exchange SERIALLY and the double-check makes all-but-one see the cache (exactly ONE http POST); DIFFERENT installationIds proceed concurrently (independent locks). Use promises only — NO setTimeout. Put it in a small helper (here or #platform if generally useful).

Test ${REPO}/test/unit/integrations/github/installation_token.test.ts (no DB; FakeClock + CassetteHttpClient or a counting http stub):
- get_fresh: a token with expires_at far future → cache hit; within 30s of expiry (advance FakeClock to expires-29s) → MISS (returns null → re-exchange); exactly at expires-30s boundary → miss (<=).
- getInstallationToken: cache miss → does the exchange (CassetteHttpClient replaying test/cassettes/github/installation_token_success.yaml — note: that cassette's POST records body:"" so the http call must pass text_body:"" per the cassette matcher; OR use a counting stub), caches, second call → cache HIT (no second exchange).
- CONCURRENCY: fire N=10 concurrent getInstallationToken for the SAME installation against a counting http stub → EXACTLY 1 exchange (lock + double-check). Two DIFFERENT installations concurrently → 2 exchanges (independent).
- 401 → GitHubAppUnauthorized; other 4xx → GitHubAppUnauthorized. expires_at ISO Z→+00:00 parsed correctly.
Return component="token_cache", files_written, commands, all_green, notes (the async-lock approach, the 30s-margin boundary, contract datetime handling, cassette-vs-stub choice).`

const port = await agent(PORT, { label: 'port:token-cache', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')
const verify = await agent(`ADVERSARIAL verifier for the installation-token cache (Task 2.8). REFUTE that the TTL margin, the per-installation lock, and the exchange match the frozen Python.
${STYLE}
Built: ${JSON.stringify(port).slice(0, 600)}
Independently (read the frozen installation_token.py; drive the TS via a throwaway ${REPO}/tools/parity/_tok_scratch.ts — DELETE after, no git-add):
1. TTL MARGIN: get_fresh returns the cached token until clock.now() reaches expires_at - 30s, then returns null (re-exchange). Probe the boundary: expires-31s → hit, expires-30s → miss (the <= is inclusive), expires-29s → miss. Confirm exactly the 30s constant + the <= comparison.
2. PER-INSTALLATION LOCK (the load-bearing concurrency property): fire 10+ CONCURRENT getInstallationToken for the SAME installationId against a counting http → EXACTLY 1 exchange (not 10 — the lock + in-lock re-check prevents the thundering herd). Two DIFFERENT installations concurrently → 2 (independent locks, no cross-blocking). If concurrent same-installation calls produce >1 exchange, the lock is broken → WEAK.
3. EXCHANGE: cache miss → POST to /app/installations/{id}/access_tokens with Authorization: Bearer <jwt> + the exact headers; 401 → GitHubAppUnauthorized; >=400 → GitHubAppUnauthorized; body {token, expires_at} parsed (Z→+00:00). Confirm a non-whitespace token validator rejects "  ".
4. NO setTimeout/Date: the lock is promise-based and "now" comes from the Clock — confirm \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations (gate ERROR-mode scans the file).
5. Run \`cd ${REPO} && npx vitest run test/unit/integrations/github/installation_token.test.ts\`; \`npx tsc -p tsconfig.json\` clean.
verdict=WEAK if the margin/boundary diverges, the lock allows >1 concurrent same-installation exchange, the exchange/errors diverge, or timing bypasses the Clock; SOUND otherwise. Exact reproduction for failures. Clean up scratch.`, { label: 'verify:token-cache', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
