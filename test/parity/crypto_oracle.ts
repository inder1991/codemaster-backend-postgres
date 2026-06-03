// Cross-impl crypto parity oracle: talks to ONE long-lived Python ref process over stdin/stdout
// JSONL. Drives the frozen `codemaster.security` AES-256-GCM field-encryption crypto so the TS
// parity test can prove the security guarantee — ciphertext written by EITHER impl decrypts in the
// OTHER under the same key + AAD. Because the AES-GCM nonce is random, ciphertexts are NOT
// byte-comparable; parity is proven by CROSS-DECRYPTION (encrypt one side, decrypt the other).
//
// All binary values cross the wire as base64; `aad` is base64 or null. Mirrors random_oracle.ts for
// the spawn + readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Successful decrypt result; carries the recovered plaintext bytes. */
export type DecryptOk = { readonly ok: true; readonly plaintext: Uint8Array };
/** Rejected decrypt result; carries the Python LocalKeyEncryptionError message. This is a value,
 *  NOT a thrown error, so the test can assert Python ALSO rejects (e.g. wrong-aad, prefix mismatch). */
export type DecryptErr = { readonly ok: false; readonly err: string };

type RefResponse = {
  id: string;
  ok: boolean;
  ct?: string; // encrypt result: the envelope string.
  pt?: string; // decrypt result: base64 plaintext.
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
    [join(repoRoot, "tools", "parity", "run_crypto_ref.py")],
    { cwd: submodule }, // so `import codemaster` resolves against the frozen source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[crypto-ref] ${d}`));
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

/** Encode a key map (version -> raw key bytes) as the base64 wire shape the driver expects. */
function encodeKeys(keys: Readonly<Record<string, Uint8Array>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [version, key] of Object.entries(keys)) {
    out[version] = Buffer.from(key).toString("base64");
  }
  return out;
}

/** Base64 an optional binary field, mapping `undefined` -> `null` (the AAD-absent wire form). */
function encodeAad(aad: Uint8Array | undefined): string | null {
  return aad === undefined ? null : Buffer.from(aad).toString("base64");
}

/**
 * Encrypt through the frozen Python crypto and return the envelope string. The Python side builds a
 * fresh KeyRegistry from `keys` with `version` current, then calls `encrypt(plaintext, aad=...)`.
 * Throws if Python reports `ok:false` — encrypt is not expected to fail under valid inputs.
 */
export async function pyEncrypt(args: {
  keys: Readonly<Record<string, Uint8Array>>;
  version: string;
  plaintext: Uint8Array;
  aad: Uint8Array | undefined;
}): Promise<string> {
  const r = await request({
    op: "encrypt",
    keys: encodeKeys(args.keys),
    version: args.version,
    plaintext: Buffer.from(args.plaintext).toString("base64"),
    aad: encodeAad(args.aad),
  });
  if (!r.ok || r.ct === undefined) {
    throw new Error(`python crypto ref encrypt failed: ${r.err ?? "no ct in response"}`);
  }
  return r.ct;
}

/**
 * Decrypt an envelope through the frozen Python crypto. Returns a discriminated result rather than
 * throwing on rejection: the test asserts both that Python recovers the plaintext on the happy path
 * AND that Python ALSO rejects (ok:false) the wrong-aad / prefix-mismatch / wrong-version cases —
 * which is the cross-impl security property under proof.
 */
export async function pyDecrypt(args: {
  keys: Readonly<Record<string, Uint8Array>>;
  ciphertext: string;
  aad: Uint8Array | undefined;
}): Promise<DecryptOk | DecryptErr> {
  const r = await request({
    op: "decrypt",
    keys: encodeKeys(args.keys),
    ciphertext: args.ciphertext,
    aad: encodeAad(args.aad),
  });
  if (r.ok && r.pt !== undefined) {
    return { ok: true, plaintext: new Uint8Array(Buffer.from(r.pt, "base64")) };
  }
  return { ok: false, err: r.err ?? "python crypto ref returned ok:false with no err" };
}

export function shutdownCryptoRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
