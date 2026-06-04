// GitHub-crypto parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `sign_app_jwt` (tools/parity/run_github_crypto_ref.py) so the TS port can be
// proven BYTE-EQUAL against the source-of-truth. RS256 (RSA-PKCS#1-v1.5 over SHA-256) is
// deterministic, so the JWT string is directly byte-comparable — unlike the AES-GCM crypto oracle
// (random nonce) which proves parity by cross-decryption instead.
//
// The driver builds a frozen FakeClock from a unix-ms instant we pass, so we can exercise the same
// (app_id, clock, key) on both impls. Mirrors redact_oracle.ts / crypto_oracle.ts for the spawn +
// readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Successful sign result: the JWT string the frozen `sign_app_jwt` produced. */
export type SignOk = { readonly ok: true; readonly jwt: string };
/** Rejected sign result: the frozen function raised GitHubPrivateKeyMalformed. This is a VALUE, not
 *  a thrown error, so the test can assert Python ALSO rejects (e.g. an invalid PEM). */
export type SignErr = { readonly ok: false; readonly errType: string; readonly err: string };

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly jwt?: string;
  readonly err_type?: string;
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
    [join(repoRoot, "tools", "parity", "run_github_crypto_ref.py")],
    { cwd: submodule }, // so `import codemaster` resolves against the frozen source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[github-crypto-ref] ${d}`));
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

/** Drive the frozen `sign_app_jwt` with the given app id, PEM, and unix-ms wall instant. */
export async function pySignAppJwt(args: {
  appId: string;
  privateKeyPem: string;
  nowMs: number;
}): Promise<SignOk | SignErr> {
  const r = await request({
    op: "sign_app_jwt",
    app_id: args.appId,
    private_key_pem: args.privateKeyPem,
    now_ms: args.nowMs,
  });
  if (r.ok) return { ok: true, jwt: r.jwt ?? "" };
  return { ok: false, errType: r.err_type ?? "", err: r.err ?? "" };
}

export function shutdownGithubCryptoRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
