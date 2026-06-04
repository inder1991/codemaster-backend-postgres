// Policy-subsystem parity oracle for `extract_rules`: talks to ONE long-lived Python ref process
// over stdin/stdout JSONL. Drives the frozen rule_extractor (tools/parity/run_policy_ref.py) so the
// TS port can be proven byte-equal against the source-of-truth.
//
// A dedicated driver (not the generic oracle.ts) because `extract_rules` takes a CONSTRUCTED
// GuidelineFileV1 Pydantic instance, not a kwargs dict — the generic `fn(**kwargs)` runner cannot
// build the model. Returns the raw ExtractedRuleV1 model_dump dicts so each rule compares directly.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One rule dict as emitted by the Python driver (ExtractedRuleV1 model_dump(mode="json")). */
export type RuleDict = Record<string, unknown>;

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly rules?: ReadonlyArray<RuleDict>;
  readonly err?: string;
};

/** Wire shape for a GuidelineFileV1 (mirrors the contract fields the driver re-constructs). */
export type GuidelineFileInput = {
  readonly relative_path: string;
  readonly scope_dir: string;
  readonly source_pattern: string;
  readonly body: string;
  readonly content_sha256: string;
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
    [join(repoRoot, "tools", "parity", "run_policy_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[policy-ref] ${d}`));
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

/** Run the frozen `extract_rules` over a GuidelineFileV1 input and return its emitted rule dicts. */
export async function pyExtractRules(
  guidelineFile: GuidelineFileInput,
): Promise<Array<RuleDict>> {
  const r = await request({ op: "extract_rules", guideline_file: guidelineFile });
  if (!r.ok) throw new Error(`python policy ref failed: ${r.err}`);
  return [...(r.rules ?? [])];
}

export function shutdownPolicyRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
