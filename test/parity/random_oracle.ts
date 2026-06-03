// Stateful randomness parity oracle: talks to ONE long-lived Python ref process over stdin/stdout
// JSONL. Unlike oracle.ts (which canonicalizes pure-function results), this driver runs an ordered
// call-list against a single live SeededRandom so the Mersenne-Twister stream advances in lockstep
// with the TS implementation — that's what makes bit-exact float parity provable.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One method invocation in a seeded call-list. Mirrors the Python driver's `<call>` shape. */
export type SeededCall =
  | { m: "random" }
  | { m: "randint"; a: number; b: number }
  | { m: "uniform"; a: number; b: number }
  | { m: "choice"; seq: ReadonlyArray<unknown> }
  | { m: "shuffle"; seq: ReadonlyArray<unknown> }
  | { m: "token_bytes"; n: number };

/** Encoded result of one call: exactly one of these keys is present per the call's method. */
export type SeededCallResult = {
  readonly f?: string; // IEEE-754 big-endian hex (random / uniform)
  readonly i?: number; // randint
  readonly c?: unknown; // choice
  readonly s?: ReadonlyArray<unknown>; // shuffle result
  readonly b?: string; // token_bytes hex
};

type RefResponse = {
  id: string;
  ok: boolean;
  out?: ReadonlyArray<SeededCallResult> | { uuid: string };
  err?: string;
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
    [join(repoRoot, "tools", "parity", "run_random_ref.py")],
    { cwd: submodule }, // so `import codemaster` resolves against the frozen source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[random-ref] ${d}`));
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
 * Drive an ordered call-list through the frozen Python `SeededRandom(seed=N)` and return the
 * per-call encoded results. The whole list runs on ONE RNG instance so the MT stream advances
 * exactly as it does on the TS side.
 */
export async function seededRef(args: {
  seed: number;
  calls: ReadonlyArray<SeededCall>;
}): Promise<ReadonlyArray<SeededCallResult>> {
  const r = await request({ kind: "seeded", seed: args.seed, calls: args.calls });
  if (!r.ok) throw new Error(`python random ref failed: ${r.err}`);
  return r.out as ReadonlyArray<SeededCallResult>;
}

/** Mint one uuid7 from the frozen Python `uuid7` pinned to the Unix epoch + `ms` milliseconds. */
export async function uuid7Ref(args: { ms: number }): Promise<{ uuid: string }> {
  const r = await request({ kind: "uuid7", ms: args.ms });
  if (!r.ok) throw new Error(`python random ref failed: ${r.err}`);
  return r.out as { uuid: string };
}

/** Encode a JS double as the IEEE-754 big-endian hex the Python driver emits for floats. */
export function doubleToHex(x: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString("hex");
}

export function shutdownRandomRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
