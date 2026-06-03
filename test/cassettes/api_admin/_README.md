# Admin-console API cassettes — Sprint 14 / S14.B + S14.C

Recorded happy-path responses for the admin-console endpoints. Each
cassette stores a single GET exchange shaped for the corresponding
locked Pydantic envelope. Tests replay the response body byte-for-byte;
no live backend required.

| Cassette | Endpoint | Envelope | Sprint |
|---|---|---|---|
| `dashboard.json` | `GET /api/admin/dashboard` | `DashboardSummaryV1` | S14.B |
| `reviews_list_page.json` | `GET /api/admin/reviews` | `ReviewsListPageV1` | S14.B |
| `review_detail.json` | `GET /api/admin/reviews/{id}` | `ReviewDetailV1` | S14.B |
| `flags_list.json` | `GET /api/admin/flags` | tuple of `_FlagDetailHTTP` | **S14.C** |
| `integrations_list.json` | `GET /api/admin/integrations` | tuple of `_IntegrationHTTP` | **S14.C** |
| `audit_events_list.json` | `GET /api/admin/audit-events` | `_AuditSearchResponseV1` (with `X-Vault-Degraded: true` response header) | **S14.C** |

Refresh by running the integration suite against a seeded Postgres
fixture and overwriting these files. The schema_version field on
the response body (where present) must match the contract in
`contracts/admin/v1.py`/`contracts/admin/review_finding/v1.py` —
`scripts/contract_lint.py` blocks PRs that drift one without the
other.
