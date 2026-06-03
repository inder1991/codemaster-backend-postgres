# HTTP/gRPC cassettes — Sprint 0 / Story S0.5a

Recorded fixtures for every external service we integrate with. Tests replay these instead of mocking — mocks lie about reality, recordings don't.

## Subdirectories

- `github/` — GitHub API responses (cloud + GHES variants).
- `bedrock/` — Anthropic via AWS Bedrock responses.
- `embeddings/` — Qwen embedding service responses.
- `confluence/` — Confluence REST API responses (v1 — populated when Sprint 9 lands).

## Recording protocol

1. Use `tests/scripts/record_<sink>.py` to record fresh cassettes against a controlled test account / sandbox endpoint.
2. Store in `tests/cassettes/<sink>/<scenario>.yaml`.
3. **Sanitize secrets and PII before commit.** A built-in scrubber rewrites tokens, API keys, IP addresses to fixed placeholders. Manual diff review on every record-and-commit.
4. Each cassette has a sibling `.meta.yaml` documenting: scenario, recorded_at, model_or_endpoint, recorded_by, validity_window.

## Refresh cadence

**Monthly.** Calendar entry owned by the SDET. Cassettes older than 60 days produce a CI advisory warning. Older than 90 days fails CI.

Why: external services change response shapes. Fresh cassettes catch breaking changes early. Stale cassettes hide them.

## Cassette format

YAML, one request/response pair per cassette (or a sequence of them). Schema:

```yaml
schema_version: 1
recorded_at: "2026-05-01T12:00:00Z"
recorded_by: "<author>"
service: github | bedrock | embeddings | confluence
scenario: "PR opened — happy path"
interactions:
  - request:
      method: POST
      url: https://api.github.com/repos/.../pulls/123/reviews
      headers: { ... }  # auth tokens scrubbed
      body: { ... }
    response:
      status: 200
      headers: { ... }  # rate-limit headers preserved
      body: { ... }
```

## CI integration

Tests using `CassetteHttpClient` or `CassetteGrpcClient` automatically:
- Replay matching interactions on assertion.
- Fail the test if the recorded request doesn't match the actual request shape (catches drift between code and recording).
- Fail the test if the cassette is older than the freshness threshold.
