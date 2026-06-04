// Magika parity oracle: talks to ONE long-lived FROZEN-Python ref process over stdin/stdout JSONL,
// driving the source-of-truth `codemaster.files.magika_classifier` label derivation. The TS agreement
// test uses this to obtain Python magika's label for each corpus file, then compares against the npm
// magika label the TS classifier emits. This is the Tier-B (impure / ML) seam — NOT the Tier-A
// pure-function oracle (oracle.ts), which explicitly excludes classify.
//
// TOLERATED-DIVERGENCE (ADR-0065): the two ML models may disagree on some labels; acceptance is a
// >=95% agreement rate, not byte-parity. Mirrors crypto_oracle.ts for the spawn + readline +
// id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Successful label result for one file/buffer. */
export type LabelOk = { readonly ok: true; readonly label: string; readonly byte_size: number };
/** Rejected result; carries the Python-side error message (e.g. unreadable path). */
export type LabelErr = { readonly ok: false; readonly err: string };

type RefResponse = {
  id: string;
  ok: boolean;
  label?: string;
  byte_size?: number;
  err?: string;
};

let proc: ChildProcessWithoutNullStreams | undefined;
let spawnFailed = false;
const pending = new Map<string, (r: RefResponse) => void>();
let seq = 0;

function ref(): ChildProcessWithoutNullStreams {
  if (proc) return proc;
  const here = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
  const repoRoot = join(here, "..", "..");
  const submodule = join(repoRoot, "vendor", "codemaster-py");
  const p = spawn(
    join(submodule, ".venv", "bin", "python"),
    [join(repoRoot, "tools", "parity", "run_magika_ref.py")],
    { cwd: submodule }, // so `import codemaster` + `from magika import Magika` resolve the frozen source
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[magika-ref] ${d}`));
  // If the python process dies (e.g. magika model can't load under the frozen venv), fail every
  // in-flight + future request so the readiness probe resolves rather than hanging.
  p.on("exit", (code) => {
    spawnFailed = true;
    proc = undefined;
    for (const [, resolve] of pending) resolve({ id: "", ok: false, err: `ref exited code=${code}` });
    pending.clear();
  });
  p.on("error", (e) => {
    spawnFailed = true;
    proc = undefined;
    for (const [, resolve] of pending) resolve({ id: "", ok: false, err: `ref spawn error: ${e}` });
    pending.clear();
  });
  proc = p;
  return p;
}

function request(payload: Record<string, unknown>): Promise<RefResponse> {
  if (spawnFailed) return Promise.resolve({ id: "", ok: false, err: "magika ref unavailable" });
  const id = String(seq++);
  return new Promise<RefResponse>((resolve) => {
    pending.set(id, resolve);
    try {
      ref().stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    } catch (e) {
      pending.delete(id);
      resolve({ id, ok: false, err: `write failed: ${String(e)}` });
    }
  });
}

/** Frozen-Python magika label for a file on disk (read by the Python side). */
export async function pyLabelPath(path: string): Promise<LabelOk | LabelErr> {
  const r = await request({ op: "label_path", path });
  if (r.ok && typeof r.label === "string") {
    return { ok: true, label: r.label, byte_size: r.byte_size ?? 0 };
  }
  return { ok: false, err: r.err ?? "no label in response" };
}

/** Frozen-Python magika label for an inline byte buffer (base64 over the wire). */
export async function pyLabelBytes(bytes: Uint8Array): Promise<LabelOk | LabelErr> {
  const b64 = Buffer.from(bytes).toString("base64");
  const r = await request({ op: "label_bytes", b64 });
  if (r.ok && typeof r.label === "string") {
    return { ok: true, label: r.label, byte_size: r.byte_size ?? 0 };
  }
  return { ok: false, err: r.err ?? "no label in response" };
}

export function shutdownMagikaRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
