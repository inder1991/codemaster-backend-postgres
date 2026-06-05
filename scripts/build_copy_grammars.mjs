// Build asset step: tsc emits ONLY .js — it does NOT copy the vendored tree-sitter grammar .wasm (or
// their manifest.json) into dist. The chunker's loader resolves `./grammars` relative to its compiled
// import.meta.url (dist/apps/backend/src/chunking/), so without this copy a production worker
// throws at chunk time / startupSelfCheck time. ADR-0067. Run after `tsc -p tsconfig.build.json`.
//
// Pure Node (cross-platform: darwin dev + the OpenShift linux runtime image). Idempotent.

import { cp, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REL = "apps/backend/src/chunking/grammars";
const src = join(repoRoot, REL);
const dst = join(repoRoot, "dist", REL);

await cp(src, dst, { recursive: true });

const copied = (await readdir(dst)).filter((f) => f.endsWith(".wasm") || f.endsWith(".json"));
if (copied.filter((f) => f.endsWith(".wasm")).length === 0) {
  process.stderr.write(`[ERROR] build_copy_grammars: no .wasm copied into ${dst}\n`);
  process.exit(1);
}
process.stdout.write(`[build] copied tree-sitter grammars → dist/${REL} (${copied.join(", ")})\n`);
