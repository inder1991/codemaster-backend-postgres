// Tier-A parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// `pyRef` returns the frozen Python's canonical-JSON output for a call; `assertParity` compares a
// TS implementation against it. Tier-B (impure: classify/cost-cap) uses integration parity, not this.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { canonicalize } from "./canonical.js";

type RefResult = {
  ok: boolean;
  out?: string;
  err?: string;
}

let proc: ChildProcessWithoutNullStreams | undefined;
const pending = new Map<string, (r: RefResult) => void>();
let seq = 0;

function ref(): ChildProcessWithoutNullStreams {
  if (proc) return proc;
  const here = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
  const repoRoot = join(here, "..", "..");
  const submodule = join(repoRoot, "vendor", "codemaster-py");
  const p = spawn(join(submodule, ".venv", "bin", "python"), [join(repoRoot, "tools", "parity", "run_python_ref.py")], {
    cwd: submodule, // so `import codemaster` resolves against the frozen source-of-truth
  });
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResult & { id: string };
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[ref] ${d}`));
  proc = p;
  return p;
}

/** Call the frozen Python `module.callable(**kwargs)` and return its canonical-JSON result. */
export function pyRef(args: {
  pyModule: string;
  pyCallable: string;
  kwargs: Record<string, unknown>;
}): Promise<RefResult> {
  const id = String(seq++);
  return new Promise<RefResult>((resolve) => {
    pending.set(id, resolve);
    ref().stdin.write(
      JSON.stringify({ id, module: args.pyModule, callable: args.pyCallable, kwargs: args.kwargs }) + "\n",
    );
  });
}

/** Tier-A: assert a pure TS fn matches its pure Python original on the same kwargs. */
export async function assertParity(args: {
  kwargs: Record<string, unknown>;
  pyModule: string;
  pyCallable: string;
  tsFn: (kwargs: Record<string, unknown>) => unknown | Promise<unknown>;
}): Promise<{ ok: boolean; ts: string; py: string }> {
  const r = await pyRef(args);
  if (!r.ok) throw new Error(`python ref failed: ${r.err}`);
  const ts = canonicalize(await args.tsFn(args.kwargs));
  return { ok: ts === r.out, ts, py: r.out ?? "" };
}

export function shutdownRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
