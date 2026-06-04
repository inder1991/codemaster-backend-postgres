// load-repo-config parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `load_repo_config` (tools/parity/run_config_ref.py) so the TS port can be proven
// byte-equal against the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because `load_repo_config` takes a Path workspace whose
// `.codemaster.yaml` the driver materializes (or omits) on disk, and whose fail-open branch depends on
// that file state — not a flat kwargs dict. The Python driver writes its OWN temp workspace internally;
// the TS test writes a parallel temp dir for the TS side. Both return relative-path-free config, so the
// workspace dirs differing doesn't affect parity.
//
// Mirrors classify_oracle.ts for the spawn + readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** The `CodemasterConfigV1.model_dump(mode="json")` dict the Python driver emits. */
export type ConfigDict = Record<string, unknown>;

/**
 * The single `load_repo_config` request. `yaml` is the `.codemaster.yaml` body to materialize. Pass
 * `undefined` (the default) to write NO file (the missing-file fail-open branch); pass `""` to write an
 * EMPTY file (the empty-file branch). The presence — not the truthiness — of the field is the signal.
 */
export type ConfigRequest = {
  readonly yaml?: string;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: ConfigDict;
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
    [join(repoRoot, "tools", "parity", "run_config_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[config-ref] ${String(d)}`));
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

/** Run the frozen `load_repo_config` over the given request; return its `CodemasterConfigV1` dict. */
export async function pyLoadRepoConfig(req: ConfigRequest): Promise<ConfigDict> {
  // Only forward the `yaml` key when it is PRESENT, so the Python driver's key-presence check
  // (write-file vs missing-file) sees the same signal the TS side acts on.
  const payload: Record<string, unknown> =
    req.yaml === undefined ? { op: "load_repo_config" } : { op: "load_repo_config", yaml: req.yaml };
  const r = await request(payload);
  if (!r.ok || r.result === undefined) {
    throw new Error(`python config ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownConfigRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
