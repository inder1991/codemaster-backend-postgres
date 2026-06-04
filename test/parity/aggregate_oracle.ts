// Aggregate-findings parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `_do_aggregate` (tools/parity/run_aggregate_ref.py) with a forced-skip embedder so
// the TS port can be proven byte-equal against the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because `_do_aggregate` takes a constructed tuple of
// `ReviewFindingV1` Pydantic instances + a failing embedder (not a flat kwargs dict), and aggregated
// findings carry a `confidence` FLOAT that the generic canonicalizing runner rejects. Returns the raw
// `AggregatedFindingsV1` model_dump dict so the test can canonicalize + diff (confidence stripped).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One finding wire dict as accepted by `ReviewFindingV1(**dict)` on the Python side. */
export type FindingInput = Record<string, unknown>;

/** The `AggregatedFindingsV1.model_dump(mode="json")` dict the Python driver emits. */
export type AggregatedDict = Record<string, unknown>;

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: AggregatedDict;
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
    [join(repoRoot, "tools", "parity", "run_aggregate_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[aggregate-ref] ${String(d)}`));
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

/** Run the frozen `_do_aggregate` over the given findings + policy_revision; return its envelope dict. */
export async function pyDoAggregate(
  findings: ReadonlyArray<FindingInput>,
  policyRevision: number,
): Promise<AggregatedDict> {
  const r = await request({
    op: "do_aggregate",
    findings: [...findings],
    policy_revision: policyRevision,
  });
  if (!r.ok || r.result === undefined) {
    throw new Error(`python aggregate ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownAggregateRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
