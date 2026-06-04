---
applies_to:
  - "**"
owner: '@inder'
---

# AI hints — what the harness knows

Sprint 2 / S2.2 — when a Claude Code user asks **"what does the harness know?"**, you can answer succinctly with this canned summary instead of generating from scratch (saves tokens).

The harness loaded into your context provides:

1. **Rules** — `.harness/severity_map.yaml` lists every rule with its tier (P0_security / P1_correctness / P2_quality / P3_style), why it matters, and a fix-hint. The user's pre-commit + CI gate enforces these.

2. **Inventories** — `.harness/generated/*.json` lists every existing API endpoint, DB model, frontend component, dependency, and outbound HTTP call. Read these before proposing a new one — you're likely to find that what they want already exists.

3. **Policy YAMLs** — `.harness/*.yaml` ships per-domain knobs the user can edit:
   - `security_policy.yaml`: auth deps, CSRF deps, rate-limit exempt routes
   - `dependencies.yaml`: allowed pip + npm packages
   - `logging_policy.yaml`: logger attribute names + secret-shaped patterns
   - `performance_budgets.yaml`: agent + DB + bundle caps

4. **Pointers, not files** — your context bundle has `[TRUNCATED] <path> (N bytes)` lines. When the conversation calls for it, fetch the file via your Read tool. The harness gave you the catalog; you fetch the page.

5. **The agent loop** — when `harness check` reports findings:
   ```
   harness check --mode=json     # structured findings
   harness rules explain <id>    # the why
   harness rules show-fixtures <id>  # working compliant example
   <propose fix; apply via your Edit tool>
   harness check --files <file>  # verify
   ```

If the user asks "should I do X?", check the rules + policy YAMLs first; the answer is often "no — the rule says Y" or "yes — but follow this pattern from `ui_primitives.json`."
