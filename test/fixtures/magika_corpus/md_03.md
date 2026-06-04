---
owner: '@inder'
---
# Baseline tickets

Each entry below documents a finding that was baselined (rather than
fixed) during Sprints H.1a/b/c/d live-repo triage. Each MUST have an
issue link or a TODO date so the AI fix-loop knows what's deferred vs
forgotten.

The harness blocks any **growth** in a baseline without an ADR
(`Q19.baseline-grew-without-adr` from H.1d.1) — but the existing
counts here are grandfathered. As code is touched, the AI is expected
to also clear the matching baseline entry.

| Baseline file | Count | Owner | Tracking | Notes |
|---|---|---|---|---|
| `backend_async_correctness_baseline.json` | ~ | @backend-lead | TBD | H.1a triage |
| `backend_db_layer_baseline.json` | ~ | @backend-lead | TBD | H.1a triage |
| `backend_testing_baseline.json` | ~ | @backend-lead | TBD | H.1a triage; many extractors lack Hypothesis tests |
| `dependency_policy_baseline.json` | ~ | @backend-lead | TBD | a few legacy spine imports |
| `accessibility_policy_baseline.json` | ~ | @frontend-lead | TBD | H.1b.6 triage |
| `conventions_policy_baseline.json` | ~ | @frontend-lead | TBD | legacy default-export components |
| `documentation_policy_baseline.json` | 766 | @inder | TBD | 424 docstring + 342 JSDoc; H.1c.3 triage |
| `frontend_data_layer_baseline.json` | ~ | @frontend-lead | TBD | H.1b triage |
| `frontend_routing_baseline.json` | ~ | @frontend-lead | TBD | H.1b triage |
| `frontend_style_system_baseline.json` | ~ | @frontend-lead | TBD | H.1b triage |
| `frontend_testing_baseline.json` | ~ | @frontend-lead | TBD | H.1b triage |
| `frontend_ui_primitives_baseline.json` | ~ | @frontend-lead | TBD | H.1b triage |
| `error_handling_policy_baseline.json` | 140 | @backend-lead | TBD | 85 pass-in-except + 47 reraise-without-from + 6 generic + 2 http-no-detail |
| `logging_policy_baseline.json` | 207 | @backend-lead | TBD | 152 bare-except + 35 f-string + 19 print + 1 bearer-literal |
| `mypy_baseline.json` | seeded | @backend-lead | TBD | mypy was unavailable at H.0b seed; refresh once mypy installs |
| `tsc_baseline.json` | ~ | @frontend-lead | TBD | H.0b seed; refresh after a noUncheckedIndexedAccess pass |
| `security_policy_a_baseline.json` | ~ | @platform-lead | TBD | H.1c.1 triage |
| `security_policy_b_baseline.json` | ~ | @backend-lead | TBD | H.1c.2 triage; legacy unauth/no-rate-limit endpoints |
| `storage_isolation_baseline.json` | ~ | @backend-lead | TBD | H.1a triage |
| `todo_in_prod_baseline.json` | ~ | @backend-lead | TBD | TODO: prod TODOs await follow-up tickets |

`~` means "use `wc -l < <file>` to read the current count" — kept loose
because re-baselining via `make harness-baseline-refresh` shifts the
numbers anyway. The intent is that any rise prompts an ADR.

## Adding new entries

If a new rule's grandfather list is created via
`make harness-baseline-refresh`, add a row above with owner + tracking.
Without a row, the next reviewer cannot tell *who* owns the cleanup.

## Closing entries

When a baseline drops to zero (verified via `wc -l`), delete its row.
The empty baseline file may stay (cheap; signals enforcement).
