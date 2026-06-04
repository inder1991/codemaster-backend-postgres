// File-router parity oracle for `decide_route`: talks to ONE long-lived Python ref process over
// stdin/stdout JSONL. Drives the frozen router (tools/parity/run_router_ref.py) so the TS port can
// be proven byte-equal against the source-of-truth.
//
// A dedicated driver (not the generic oracle.ts) because `decide_route` (a) takes a CONSTRUCTED
// FileClassificationV1 Pydantic instance — the generic `fn(**kwargs)` runner cannot build the model
// — and (b) returns a `frozenset`, which json.dumps cannot serialize. The driver reconstructs the
// model and emits the frozenset as a SORTED list of bucket strings, so the wire form is deterministic
// and set-order does not perturb the byte comparison.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Wire shape for a FileClassificationV1 (mirrors the contract fields the driver re-constructs). */
export type ClassificationInput = {
  readonly path: string;
  readonly byte_size: number;
  readonly magika_label: string;
  readonly language: string | null;
  readonly is_binary: boolean;
  readonly is_generated: boolean;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly buckets?: ReadonlyArray<string>;
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
    [join(repoRoot, "tools", "parity", "run_router_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[router-ref] ${d}`));
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

/** Run the frozen `decide_route` over a classification input and return its sorted bucket list. */
export async function pyDecideRoute(classification: ClassificationInput): Promise<Array<string>> {
  const r = await request({ op: "decide_route", classification });
  if (!r.ok) throw new Error(`python router ref failed: ${r.err}`);
  return [...(r.buckets ?? [])];
}

export function shutdownRouterRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
