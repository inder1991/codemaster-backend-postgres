# ADR-0065: Magika file-classifier model divergence (npm 1.0.0 vs Python 1.0.2)

- Status: Accepted
- Date: 2026-06-04
- Deciders: backend platform (Python→TypeScript migration)
- Related: ADR-0047 (single typed activity input), `contracts/file_classification/v1`, frozen
  `codemaster/files/magika_classifier.py`, `codemaster/files/router.py`

## Context

The Python→TypeScript backend port (see MEMORY: "Python→TypeScript backend migration") re-implements
the review pipeline 1:1 against the frozen Python source-of-truth at `vendor/codemaster-py`. Most
ports are PURE functions provable byte-for-byte against the frozen original via the Tier-A parity
oracle (`tools/parity/run_python_ref.py`).

The file classifier is NOT pure. `MagikaFileClassifier.classify(path, body)` runs an ML model
(Google's Magika) over the file's bytes to produce a `magika_label`, which the contract
`FileClassificationV1` carries alongside two path-based heuristics (`is_generated`, `language`) and a
derived `is_binary` flag. The router (`router.py::decide_route`) consumes the classification to route
each file into `{skip}`, `{review}`, or `{review, sandbox}`.

The two implementations bind DIFFERENT model artifacts:

- **Frozen Python**: `magika` 1.0.2 (the `Magika()` Python class, ONNX model bundled in the wheel).
- **TypeScript port**: npm `magika` 1.0.0 (`Magika.create()` → `identifyBytes`, ONNX/TF model bundled
  in the package).

Cross-implementation ONNX inference is NOT guaranteed bit-identical: model versions differ (1.0.2 vs
1.0.0), the runtimes differ (Python ONNX runtime vs the JS tfjs/onnxruntime backend), and float
non-determinism across backends can tip a borderline file from one label to an adjacent one (e.g.
`txt` vs `markdown`, `c` vs `cpp`). A strict byte-parity acceptance — the bar every PURE port clears —
is therefore the wrong gate for this seam.

## Decision

**Accept the magika classifier as a TOLERATED-DIVERGENCE axis. The acceptance contract is a
LABEL-AGREEMENT RATE of ≥95% across a curated representative corpus, NOT byte-parity.**

Concretely:

1. The TS classifier (`apps/backend/src/files/magika_classifier.ts`) wraps npm `magika`,
   memoizes the model at module scope (load once per process — model load is expensive), and derives
   `language` / `is_binary` / `is_generated` from the model label via the SAME tables and path regexes
   as the frozen Python (`_LANGUAGE_LABELS`, `_BINARY_LABELS`, `_GENERATED_PATH_PATTERNS`), ported
   verbatim. Only the `magika_label` itself can diverge — the derivation around it is byte-identical.

2. Acceptance is asserted by `test/parity/magika_agreement.parity.test.ts`: classify ≥50
   representative corpus files (`test/fixtures/magika_corpus/`) with BOTH npm magika (TS) and the
   frozen Python magika (via the dedicated driver `tools/parity/run_magika_ref.py`), compute
   `agreement = matches / total`, and assert `agreement ≥ 0.95`. Per-file divergences are logged.

3. **Divergence is contained to ROUTING.** `magika_label` is an INPUT to `router.py::decide_route` and
   nothing else. It NEVER participates in `chunk_id` or `evidence_id` identity (those are content-
   addressable UUIDv5s minted from chunk/knowledge inputs — see invariant 15, `mint_evidence_id`).
   A divergent label cannot corrupt provenance, cross-time identity, or any persisted key.

4. **Unknown / divergent labels fall through to the SAFE DEFAULT `{review}`.** The router routes a
   file to the static-analysis sandbox (`{review, sandbox}`) ONLY when `language ∈ SANDBOX_LANGUAGES`
   (python / javascript / typescript / go). For both implementations to put a file in the sandbox
   bucket they must INDEPENDENTLY agree on the same SANDBOX_LANGUAGES label. Any disagreement, any
   unrecognized label, and the model's own `unknown` sentinel all resolve to plain `{review}` (LLM
   review only) — never to `{skip}` on a label basis. So the worst case of a single-file label
   disagreement is "this file got an LLM review but not also a sandbox static-analysis pass" (or vice
   versa) — a graceful, advisory-only degradation, consistent with invariant 9 (`event = COMMENT`,
   bot is advisory).

## Rationale

- **Blast radius is bounded by design.** Because routing is the only consumer and the safe default is
  the recall-preserving `{review}` bucket, the cost of any single divergence is a missing/extra
  sandbox pass, not a data-integrity or identity defect. There is no path by which a wrong label
  produces a wrong persisted key or a lost-review.
- **Byte-parity is unachievable across model versions/runtimes** and would force pinning both impls to
  the identical artifact — which the npm and PyPI distributions do not offer (npm tops out at 1.0.0).
  A label-agreement rate is the honest, measurable contract for a cross-impl ML seam.
- **95% is a meaningful floor, not a rubber stamp.** The corpus deliberately spans the
  SANDBOX_LANGUAGES (python/js/ts/go), non-code text (json/yaml/toml/markdown/dockerfile/shell),
  generated files (lock files), and binaries (png/gzip/elf). Agreement on the load-bearing routing
  labels (the SANDBOX_LANGUAGES set) is where divergence would actually matter, and the corpus
  concentrates coverage there.

## Dependency justification (per CLAUDE.md "No new dependencies without justification")

We add the npm `magika` package (v1.0.0). It is the 1:1 functional counterpart of the Python `magika`
dependency already vetted and shipped in the frozen source-of-truth — the port introduces NO new
*capability*, only the TS-runtime binding of an already-accepted capability. The classifier sits on
the review spine (`clone → classify → …`), so per the stack-lock rule this ADR records the addition.
The package bundles its own model + inference backend (no network at runtime, no new external store —
respects architecture invariant 2). This ADR is that justification of record.

## Consequences

- The agreement test is model-availability-gated: if the npm model's bundled inference backend cannot
  initialize in the host runtime, OR the frozen Python magika cannot load under
  `vendor/codemaster-py/.venv`, the suite SKIPS cleanly (one visible skipped placeholder carrying the
  reason) rather than hard-failing `validate-fast`. The agreement assertion is live whenever both
  models load. This mirrors the smoke-runbook deferral discipline: a structurally-present gate that is
  dormant under an environment constraint, not a silently-dropped check.
- If a future model bump drops agreement below 95%, the test fails loudly and the divergence log names
  the offending files. The remediation is either (a) re-pin one side, (b) re-curate the corpus if the
  divergences are on non-routing-relevant labels, or (c) amend this ADR's threshold with evidence —
  not a silent gate weakening.

## Acceptance test reference

- Production wrapper: `apps/backend/src/files/magika_classifier.ts`
- Agreement test: `test/parity/magika_agreement.parity.test.ts` (threshold 0.95)
- Frozen-Python reference driver: `tools/parity/run_magika_ref.py`
- TS↔Python oracle bridge: `test/parity/magika_oracle.ts`
- Corpus: `test/fixtures/magika_corpus/` (≥50 files across the routing-relevant axes)
