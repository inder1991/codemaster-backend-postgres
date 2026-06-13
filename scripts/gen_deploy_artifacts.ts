// Generates the operator-facing deploy artifacts FROM the single source of truth (DEPLOY_CONTRACT):
//   - docs/runbooks/deploy-contract.md  — the human-readable secrets / extensions / schemas / config reference
//   - deploy/seed-vault.sh              — a one-shot `vault kv put` seeder (fill placeholders, run once)
// Run `npm run gen:deploy-artifacts` to (re)write them; `--check` regenerates in memory and exits 1 if the
// committed files are stale (the drift gate — keeps the doc + seeder from drifting from the contract).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEPLOY_CONTRACT, type SecretReq } from "../apps/backend/src/deploy_preflight.js";

const REPO_ROOT = join(import.meta.dirname, "..");
export const DOC_PATH = join(REPO_ROOT, "docs/runbooks/deploy-contract.md");
export const SEED_PATH = join(REPO_ROOT, "deploy/seed-vault.sh");

const GEN_NOTE =
  "GENERATED from DEPLOY_CONTRACT (apps/backend/src/deploy_preflight.ts) by scripts/gen_deploy_artifacts.ts — " +
  "do not edit by hand; run `npm run gen:deploy-artifacts`.";

/** Group secrets by their Vault path (one `vault kv put` per path, all its keys together). */
function byVaultPath(secrets: ReadonlyArray<SecretReq>): Map<string, Array<SecretReq>> {
  const m = new Map<string, Array<SecretReq>>();
  for (const s of secrets) {
    const list = m.get(s.vaultPath) ?? [];
    list.push(s);
    m.set(s.vaultPath, list);
  }
  return m;
}

function placeholderFor(s: SecretReq): string {
  const key = s.key ?? "value";
  if (s.format === "pem") {
    return `${key}=@${s.vaultPath.replace(/[^a-z0-9]/gi, "-")}.pem`;
  }
  return `${key}='<${key.toUpperCase()}>'`;
}

export function renderDoc(): string {
  const rowOf = (s: (typeof DEPLOY_CONTRACT.secrets)[number]): string =>
    `| \`${s.name}\` | ${s.source} | \`${s.vaultPath}\` | ${s.key ?? "—"} | ${
      s.required ? "**yes**" : "no"
    } | ${s.gates ?? ""} |`;
  const secretRows = DEPLOY_CONTRACT.secrets.map(rowOf).join("\n");
  const advisoryRows = DEPLOY_CONTRACT.advisory.map(rowOf).join("\n");
  const extRows = DEPLOY_CONTRACT.extensions
    .map((e) => `| \`${e.name}\` | \`${e.createSql}\` |`)
    .join("\n");
  const cfgRows = DEPLOY_CONTRACT.config
    .map(
      (c) =>
        `| \`${c.env}\` | ${c.default ?? "—"} | ${
          c.oneOf ? c.oneOf.join(" \\| ") : "any"
        } | ${c.required ? "**yes**" : "no"} |`,
    )
    .join("\n");

  return `# codemaster-backend — deploy contract

> ${GEN_NOTE}
> The boot preflight + \`npm run deploy:check\` enforce this contract; a deploy that violates it
> exits 1 with the exact fix instead of going Ready-but-dead.

## Bootstrap secrets — BLOCKING (provision in an OpenShift Secret OR Vault)

The ONLY secrets that gate boot. Provision both, from one source (\`CODEMASTER_SECRET_SOURCE\`).

| Secret | Source | Vault path | Key | Required | Gates |
|---|---|---|---|---|---|
${secretRows}

## Feature secrets — NON-BLOCKING (UI / env / Vault)

Never block boot; set later via the UI (stored in Postgres, encrypted by the field key), env, or
Vault. \`/config-status\` reports which are configured vs pending.

| Secret | Source | Vault path | Key | Required | Gates |
|---|---|---|---|---|---|
${advisoryRows}

Seed Vault secrets at once with \`deploy/seed-vault.sh\`, or by hand with its \`vault kv put\` commands.

## Postgres extensions (self-managed Postgres)

| Extension | Install |
|---|---|
${extRows}

## Schemas (created by the migrations)

${DEPLOY_CONTRACT.schemas.map((s) => `\`${s}\``).join(", ")} — a missing schema means \`npm run migrate:up\` has not run.

## Config

| Env | Default | Allowed | Required |
|---|---|---|---|
${cfgRows}
`;
}

export function renderSeeder(): string {
  const blocks: Array<string> = [];
  for (const [path, secrets] of byVaultPath([...DEPLOY_CONTRACT.secrets, ...DEPLOY_CONTRACT.advisory])) {
    const required = secrets.some((s) => s.required);
    const gates = secrets.find((s) => s.gates)?.gates ?? "";
    const header = `# ${path} (${required ? "REQUIRED" : "optional"})${gates ? ` — ${gates}` : ""}`;
    // A keyset is a WHOLE-SECRET ({current_version, keys:{...}}): pipe the full JSON via stdin so the
    // nested keys object survives (the loader reads it raw via kvReadRaw). Seeding it as a flat
    // `keys='<json>'` field has no top-level current_version → the pod crashloops at boot (the P0 bug).
    if (secrets.some((s) => s.format === "keyset")) {
      blocks.push(
        `${header}\n` +
          `# Fill in your base64 32-byte AES key(s) — 'openssl rand -base64 32' generates one.\n` +
          `printf '%s' '{"current_version":"v1","keys":{"v1":"<BASE64_32_BYTE_KEY>"}}' \\\n` +
          `  | vault kv put "\${MOUNT}/${path}" -`,
      );
      continue;
    }
    const kvArgs = secrets.map(placeholderFor).join(" ");
    blocks.push(`${header}\n` + `vault kv put "\${MOUNT}/${path}" ${kvArgs}`);
  }
  return `#!/usr/bin/env bash
# ${GEN_NOTE}
#
# One-shot Vault seeder: fill the <PLACEHOLDER>s (and the @*.pem file refs), then run once.
# Manual alternative: run each \`vault kv put\` below by hand.
set -euo pipefail
: "\${VAULT_ADDR:?set VAULT_ADDR (e.g. https://vault.vault:8200)}"
: "\${VAULT_TOKEN:?set VAULT_TOKEN}"
# KV-v2 mount (the chart's vault paths sit under this). Override if your mount differs. This is the SAME
# env var the app reads (vault_reader_factory) — keep them in lockstep, else the app reads a different mount.
MOUNT="\${CODEMASTER_VAULT_KV_MOUNT:-secret}"

${blocks.join("\n\n")}

echo "✓ seeded — now run 'npm run deploy:check' (or let the pod preflight) to verify."
`;
}

function main(): void {
  const check = process.argv.includes("--check");
  const targets: Array<{ path: string; content: string }> = [
    { path: DOC_PATH, content: renderDoc() },
    { path: SEED_PATH, content: renderSeeder() },
  ];

  if (check) {
    const stale = targets.filter((t) => {
      let current: string;
      try {
        current = readFileSync(t.path, "utf-8");
      } catch {
        current = "";
      }
      return current !== t.content;
    });
    if (stale.length > 0) {
      console.error(
        `deploy artifacts are STALE (regenerate with 'npm run gen:deploy-artifacts'):\n` +
          stale.map((t) => `  - ${t.path}`).join("\n"),
      );
      process.exit(1);
    }
    console.info("✓ deploy artifacts are up to date with DEPLOY_CONTRACT");
    return;
  }

  for (const t of targets) {
    writeFileSync(t.path, t.content);
    console.info(`wrote ${t.path}`);
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
