// TS side of the output-safety parity driver: talks to one long-lived frozen-Python process
// (tools/parity/run_output_safety_ref.py) over stdin/stdout JSONL. Mirrors redact_oracle.ts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Resp = { id: string; ok: boolean; err?: string; coerced?: Record<string, unknown>; decision?: Record<string, unknown> };

let proc: ChildProcessWithoutNullStreams | undefined;
const pending = new Map<string, (r: Resp) => void>();
let seq = 0;

function ref(): ChildProcessWithoutNullStreams {
  if (proc) return proc;
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");
  const submodule = join(repoRoot, "vendor", "codemaster-py");
  const p = spawn(
    join(submodule, ".venv", "bin", "python"),
    [join(repoRoot, "tools", "parity", "run_output_safety_ref.py")],
    { cwd: submodule },
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as Resp;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[os-ref] ${d}`));
  proc = p;
  return p;
}

function send(payload: Record<string, unknown>): Promise<Resp> {
  const id = String(seq++);
  return new Promise<Resp>((resolve) => {
    pending.set(id, resolve);
    ref().stdin.write(JSON.stringify({ id, ...payload }) + "\n");
  });
}

/** Coerce `payload` against the named frozen Pydantic contract; returns the coerced dict. */
export async function pyCoerce(args: {
  contract: string;
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const r = await send({ op: "coerce", contract: args.contract, payload: args.payload });
  if (!r.ok || !r.coerced) throw new Error(`pyCoerce failed: ${r.err}`);
  return r.coerced;
}

/** Run the frozen OutputSafetyValidator.validate(text); returns the decision dict. */
export async function pyValidate(text: string): Promise<Record<string, unknown>> {
  const r = await send({ op: "validate", text });
  if (!r.ok || !r.decision) throw new Error(`pyValidate failed: ${r.err}`);
  return r.decision;
}

/** Run the frozen OutputSafetyValidator.validate_finding(ReviewFindingV1(**finding)). */
export async function pyValidateFinding(finding: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await send({ op: "validate_finding", finding });
  if (!r.ok || !r.decision) throw new Error(`pyValidateFinding failed: ${r.err}`);
  return r.decision;
}

export function shutdownOutputSafetyRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
