// GitHub-webhook HMAC parity oracle: talks to ONE long-lived Python ref process over stdin/stdout
// JSONL. Drives the frozen `verify_github_signature` + reports `GITHUB_SIGNATURE_PREFIX`
// (tools/parity/run_webhook_hmac_ref.py) so the TS port can be proven to agree on every matrix case.
//
// Kept distinct from crypto_oracle.ts (the ADR-0033 AES-GCM cross-decryption seam) and from any
// JWT/GitHub-app-crypto oracle — those drive different frozen primitives over different drivers. This
// oracle owns ONLY the webhook HMAC verification edge.
//
// body/secret cross the wire as base64 (binary-safe); header crosses as a string or null.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly valid?: boolean;
  readonly prefix?: string;
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
    [join(repoRoot, "tools", "parity", "run_webhook_hmac_ref.py")],
    { cwd: submodule }, // so `import codemaster` resolves against the frozen source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[webhook-hmac-ref] ${d}`));
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

/** Run the frozen `verify_github_signature` over the given body/header/secret; return its bool. */
export async function pyVerifyGithubSignature(args: {
  body: Uint8Array;
  header: string | null;
  secret: Uint8Array;
}): Promise<boolean> {
  const r = await request({
    op: "verify",
    body: Buffer.from(args.body).toString("base64"),
    secret: Buffer.from(args.secret).toString("base64"),
    header: args.header,
  });
  if (!r.ok) throw new Error(`python webhook-hmac ref failed: ${r.err}`);
  return r.valid ?? false;
}

/** Report the frozen `GITHUB_SIGNATURE_PREFIX` constant. */
export async function pyGithubSignaturePrefix(): Promise<string> {
  const r = await request({ op: "prefix" });
  if (!r.ok) throw new Error(`python webhook-hmac ref failed: ${r.err}`);
  return r.prefix ?? "";
}

export function shutdownWebhookHmacRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
