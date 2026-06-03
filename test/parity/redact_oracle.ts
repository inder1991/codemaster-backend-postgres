// Redact-subsystem parity oracle: talks to ONE long-lived Python ref process over stdin/stdout
// JSONL. Drives the frozen detectors + redactor (tools/parity/run_redact_ref.py) so the TS port can
// be proven byte-equal against the source-of-truth. Unlike oracle.ts (which canonicalizes pure
// model_dump results), this driver returns the raw finding dicts + the redactor's verbatim output so
// offsets and redacted bytes compare directly.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One finding dict as emitted by the Python driver (SecretFindingV1 / PiiFindingV1 model_dump). */
export type Finding = {
  readonly schema_version: number;
  readonly kind: string;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly confidence: number;
  /** Present on secret findings. */
  readonly snippet_redacted?: string;
  /** Present on PII findings. */
  readonly replacement?: string;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly findings?: ReadonlyArray<Finding>;
  readonly rewritten?: string;
  readonly redacted_text?: string;
  readonly spans_redacted?: number;
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
    [join(repoRoot, "tools", "parity", "run_redact_ref.py")],
    { cwd: submodule }, // so `import codemaster` resolves against the frozen source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[redact-ref] ${d}`));
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

/** Run the frozen PatternSecretDetector over `text` and return its findings. */
export async function pyDetectSecrets(text: string): Promise<Array<Finding>> {
  const r = await request({ op: "detect_secrets", text });
  if (!r.ok) throw new Error(`python redact ref failed: ${r.err}`);
  return [...(r.findings ?? [])];
}

/** Run the frozen RegexPiiRedactor over `text`; return the rewritten text + findings. */
export async function pyDetectPii(
  text: string,
): Promise<{ rewritten: string; findings: Array<Finding> }> {
  const r = await request({ op: "detect_pii", text });
  if (!r.ok) throw new Error(`python redact ref failed: ${r.err}`);
  return { rewritten: r.rewritten ?? "", findings: [...(r.findings ?? [])] };
}

/** Run the frozen redact_text over `text` with the given findings (only offsets matter). */
export async function pyRedact(args: {
  text: string;
  findings: ReadonlyArray<{ start_offset: number; end_offset: number }>;
}): Promise<{ redactedText: string; spansRedacted: number }> {
  const r = await request({ op: "redact", text: args.text, findings: args.findings });
  if (!r.ok) throw new Error(`python redact ref failed: ${r.err}`);
  return { redactedText: r.redacted_text ?? "", spansRedacted: r.spans_redacted ?? 0 };
}

export function shutdownRedactRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
