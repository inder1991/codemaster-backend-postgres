// Review-response-parser parity oracle: talks to ONE long-lived Python ref process over stdin/stdout
// JSONL. Drives the frozen `_parse_with_skip_malformed` (tools/parity/run_review_parser_ref.py) so the
// TS `parseWithSkipMalformed` port can be proven byte-equal against the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because `_parse_with_skip_malformed` takes a list of
// raw tool_use block dicts + an `allowed_evidence_ids` frozenset/None (not a flat kwargs dict), and the
// parsed `ReviewFindingV1` instances carry a `confidence` FLOAT that the generic canonicalizing runner
// rejects. Returns the raw `{findings, intents}` model_dump dicts so the test can canonicalize + diff
// (confidence stripped from findings; intent confidence is a Decimal-string and survives verbatim).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One tool_use block dict as accepted by `_parse_with_skip_malformed([block], ...)` on the Python side. */
export type BlockInput = Record<string, unknown>;

/** The `{findings, intents}` model_dump dicts the Python driver emits. */
export type ParsedDicts = {
  readonly findings: ReadonlyArray<Record<string, unknown>>;
  readonly intents: ReadonlyArray<Record<string, unknown>>;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: ParsedDicts;
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
    [join(repoRoot, "tools", "parity", "run_review_parser_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[review-parser-ref] ${String(d)}`));
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
 * Run the frozen `_parse_with_skip_malformed` over the given blocks + allowed_evidence_ids; return its
 * `{findings, intents}` dicts. `allowedEvidenceIds`: `null` → validation disabled; `[]` → no refs
 * allowed; `["ev_...", ...]` → subset check.
 */
export async function pyParse(
  blocks: ReadonlyArray<BlockInput>,
  allowedEvidenceIds: ReadonlyArray<string> | null,
): Promise<ParsedDicts> {
  const r = await request({
    op: "parse",
    blocks: [...blocks],
    allowed_evidence_ids: allowedEvidenceIds === null ? null : [...allowedEvidenceIds],
  });
  if (!r.ok || r.result === undefined) {
    throw new Error(`python review-parser ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownReviewParserRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
