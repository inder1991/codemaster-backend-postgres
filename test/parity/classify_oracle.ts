// Classify-files parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `_do_classify` (tools/parity/run_classify_ref.py) with a STUB classifier looked up
// from a caller-supplied {path -> FileClassificationV1 wire dict} map, so the TS port can be proven
// byte-equal against the source-of-truth WITHOUT the magika ONNX model (the ML is out of scope here;
// separately covered by test:magika).
//
// A DEDICATED driver (not the generic oracle.ts) because `_do_classify` takes a Path workspace + a tuple
// of relative paths + an injected FileClassifierPort, writes fixture files to disk, and returns a
// constructed FileRoutingV1 of nested FileClassificationV1 instances — not a flat kwargs dict. The
// Python driver writes its OWN temp workspace internally; the TS test writes a parallel temp dir for the
// TS side. Both emit relative-path-only routing, so the workspace dirs differing doesn't affect parity.
//
// Mirrors aggregate_oracle.ts for the spawn + readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One classification wire dict as accepted by `FileClassificationV1(**dict)` on the Python side. */
export type ClassificationInput = Record<string, unknown>;

/** The single `do_classify` request payload both sides drive from. */
export type ClassifyRequest = {
  /** Relative paths in INPUT ORDER (the iteration order the orchestration preserves). */
  readonly files: ReadonlyArray<string>;
  /** Paths to materialize on disk with the given utf-8 body. A `files` entry absent here → read failure. */
  readonly fixtures: Readonly<Record<string, string>>;
  /** Stub lookup map: path → the classification the stub returns for a successful classify. */
  readonly classifications: Readonly<Record<string, ClassificationInput>>;
  /** Paths the stub raises for → classifier_failures (classify-failure isolation). */
  readonly classify_fail: ReadonlyArray<string>;
};

/** The `FileRoutingV1.model_dump(mode="json")` dict the Python driver emits. */
export type RoutingDict = Record<string, unknown>;

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: RoutingDict;
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
    [join(repoRoot, "tools", "parity", "run_classify_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[classify-ref] ${String(d)}`));
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

/** Run the frozen `_do_classify` over the given request; return its `FileRoutingV1` envelope dict. */
export async function pyDoClassify(req: ClassifyRequest): Promise<RoutingDict> {
  const r = await request({
    op: "do_classify",
    files: [...req.files],
    fixtures: req.fixtures,
    classifications: req.classifications,
    classify_fail: [...req.classify_fail],
  });
  if (!r.ok || r.result === undefined) {
    throw new Error(`python classify ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownClassifyRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
