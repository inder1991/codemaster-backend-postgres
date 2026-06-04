// Policy-compute parity oracle for the `compute_policy_rules` activity chain: talks to ONE long-lived
// Python ref process over stdin/stdout JSONL. Drives the frozen activity (tools/parity/
// run_policy_compute_ref.py) so the TS port can be proven byte-equal against the source-of-truth.
//
// A dedicated driver (not policy_oracle.ts, which only exposes A-2 `extract_rules`) because the chain
// materializes a FIXTURE workspace on disk, runs the REAL frozen activity coroutine over it, and returns
// the resulting `ComputedPolicyRulesV1` PLUS the absolute temp-dir path so the TS test can run its own
// port over the SAME on-disk workspace. The TS test owns cleanup of the dirs it receives.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** The `ComputedPolicyRulesV1` envelope as emitted by the Python driver (model_dump(mode="json")). */
export type ComputedPolicyRulesDict = Record<string, unknown>;

/** One fixture file to materialize into the temp workspace. */
export type FixtureFile = {
  readonly path: string;
  readonly content: string;
};

/** One symlink fixture (escape test): `path` inside the workspace → `target` (abs or workspace-relative). */
export type FixtureSymlink = {
  readonly path: string;
  readonly target: string;
};

/** A `compute_policy_rules` request: a fixture workspace spec + the chain inputs. */
export type ComputeRequest = {
  readonly files: ReadonlyArray<FixtureFile>;
  readonly symlinks?: ReadonlyArray<FixtureSymlink>;
  readonly changed_paths: ReadonlyArray<string>;
  readonly custom_patterns?: ReadonlyArray<string>;
  readonly knowledge_enabled?: boolean;
};

/** The driver's reply: the byte-comparable envelope + the abs temp-dir path the fixture was written to. */
export type ComputeResult = {
  readonly result: ComputedPolicyRulesDict;
  readonly workspace: string;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: ComputedPolicyRulesDict;
  readonly workspace?: string;
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
    [join(repoRoot, "tools", "parity", "run_policy_compute_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[policy-compute-ref] ${d}`));
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

/**
 * Materialize the fixture workspace via the frozen Python driver, run the REAL activity chain over it,
 * and return the resulting envelope + the abs temp-dir path (so the TS port can run over the SAME disk).
 */
export async function pyComputePolicyRules(req: ComputeRequest): Promise<ComputeResult> {
  const r = await request({ op: "compute_policy_rules", ...req });
  if (!r.ok) throw new Error(`python policy-compute ref failed: ${r.err}`);
  return { result: r.result ?? {}, workspace: r.workspace ?? "" };
}

export function shutdownPolicyComputeRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
