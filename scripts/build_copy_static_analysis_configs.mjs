// Build asset step: tsc emits ONLY .js — it does NOT copy the bundled static-analysis config assets
// (ruff.toml, eslint/eslint.config.mjs) into dist. config_assets.ts resolves RUFF_CONFIG_PATH /
// ESLINT_CONFIG_PATH relative to its compiled import.meta.url (dist/apps/backend/src/config/static_analysis/),
// so without this copy the runners invoke `ruff/eslint --config <missing-path>` and fail. config_assets.ts's
// own docstring flags that this copy is owed (the analogue of build_copy_grammars.mjs). Run after
// `tsc -p tsconfig.build.json`.
//
// Pure Node (cross-platform: darwin dev + the OpenShift linux runtime image). Idempotent.

import { cp, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REL = "apps/backend/src/config/static_analysis";
const src = join(repoRoot, REL);
const dst = join(repoRoot, "dist", REL);

await cp(src, dst, { recursive: true });

// Verify the two load-bearing config files landed (ruff.toml + the eslint flat config).
const top = await readdir(dst);
const hasRuff = top.includes("ruff.toml");
const hasEslintDir = top.includes("eslint");
const eslintFiles = hasEslintDir ? await readdir(join(dst, "eslint")) : [];
const hasEslintConfig = eslintFiles.some((f) => f.startsWith("eslint.config."));
if (!hasRuff || !hasEslintConfig) {
  process.stderr.write(
    `[ERROR] build_copy_static_analysis_configs: missing config(s) in ${dst} ` +
      `(ruff.toml=${hasRuff}, eslint.config=${hasEslintConfig})\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `[build] copied static-analysis configs → dist/${REL} (ruff.toml, eslint/${eslintFiles.join(", ")})\n`,
);
