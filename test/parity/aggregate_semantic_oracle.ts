// Semantic-merge parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `aggregate_semantic` (tools/parity/run_aggregate_semantic_ref.py) with an
// EXPLICIT-VECTOR embedder so the TS port's real cosine-merge branch is proven byte-equal against the
// source-of-truth.
//
// A DEDICATED driver (not aggregate_oracle.ts, which drives the WHOLE _do_aggregate chain with a
// FORCED-SKIP embedder): the semantic stage must be exercised with a WORKING embedder, and parity over
// the merge requires IDENTICAL vectors on both sides. The Python `RecordingEmbeddingsClient` is NOT
// cross-language reproducible (abs(hash) + Mersenne-Twister), so the test supplies an explicit
// `body -> vector` table that both this driver and the TS table-embedder look up.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One finding wire dict as accepted by `ReviewFindingV1(**dict)` on the Python side. */
export type FindingInput = Record<string, unknown>;

/** A `body text -> vector` lookup table; both runtimes embed by looking up the exact vector per body. */
export type VectorTable = Record<string, ReadonlyArray<number>>;

/** The shape the Python driver returns for an `aggregate_semantic` op. */
export type SemanticResult = {
  readonly findings: ReadonlyArray<Record<string, unknown>>;
  readonly semantic_skipped: boolean;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: SemanticResult;
  readonly err?: string;
};

let proc: ChildProcessWithoutNullStreams | undefined;
const pending = new Map<string, (r: RefResponse) => void>();
let seq = 0;

function ref(): ChildProcessWithoutNullStreams {
  if (proc) return proc;
  const here = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
  const repoRoot = join(here, "..", "..");
  const submodule = join(repoRoot, "vendor", "codemaster-py");
  const p = spawn(
    join(submodule, ".venv", "bin", "python"),
    [join(repoRoot, "tools", "parity", "run_aggregate_semantic_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[aggregate-semantic-ref] ${String(d)}`));
  proc = p;
  return p;
}

function request(payload: Record<string, unknown>): Promise<RefResponse> {
  const id = String(seq++);
  return new Promise<RefResponse>((resolve) => {
    pending.set(id, resolve);
    ref().stdin.write(JSON.stringify({ id, ...payload }) + "\n");
  });
}

/** Options mirroring the Python driver's `fail` / `wrong_count` / `threshold` knobs. */
export type PyAggregateSemanticOptions = {
  readonly vectors?: VectorTable;
  readonly fail?: boolean;
  readonly wrongCount?: boolean;
  readonly threshold?: number;
};

/** Run the frozen `aggregate_semantic` over the given findings + vector table; return its result. */
export async function pyAggregateSemantic(
  findings: ReadonlyArray<FindingInput>,
  opts: PyAggregateSemanticOptions = {},
): Promise<SemanticResult> {
  const r = await request({
    op: "aggregate_semantic",
    findings: [...findings],
    vectors: opts.vectors ?? {},
    fail: opts.fail ?? false,
    wrong_count: opts.wrongCount ?? false,
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
  });
  if (!r.ok || r.result === undefined) {
    throw new Error(`python aggregate-semantic ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownAggregateSemanticRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
