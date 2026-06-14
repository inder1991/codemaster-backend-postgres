// Gate: DB migrations run INSIDE the app container (fused), not as a separate pre-install Job/init.
// The app container's command runs `npm run migrate:up` before exec'ing the app — so the ServiceAccount
// (a normal resource, created with the Deployment) is always present, with NO pre-install hook ordering
// trap (a hook Job referencing the not-yet-created SA was the original first-deploy failure). migrate:up
// is idempotent + advisory-locked, so concurrent replicas serialize and a container restart re-runs a
// cheap no-op. Asserts: (a) the app container fuses migrate -> exec across modes, (b) no standalone migrate
// Job is rendered, (c) migrate.enabled=false boots the app without migrating.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const chartDir = join(repoRoot, "deploy", "helm", "codemaster-backend");

/** The fused boot line the app container must run when migrations are enabled. */
const FUSED = "npm run migrate:up && exec node apps/backend/src/main.js";

function render(extraArgs: ReadonlyArray<string>): string {
  return execFileSync("helm", ["template", "codemaster-backend", chartDir, "-n", "codemaster-cutover", ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

// helm is a deploy-battery dependency (the battery runs `helm lint`); skip cleanly where it is absent.
let helmOk = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
  helmOk = true;
} catch {
  // helm not on PATH.
}
const gate = helmOk ? it : it.skip;

const MODE_B = ["--set", "secretSource=vault", "--set", "vault.mode=external", "--set", "vault.addr=http://vault:8200"];

describe("migrations are fused into the app container, not a separate Job", () => {
  gate("Mode B: app container runs migrate:up before exec'ing the app", () => {
    expect(render(MODE_B)).toContain(FUSED);
  });

  gate("Mode B: no standalone migrate Job is rendered", () => {
    expect(render(MODE_B)).not.toMatch(/^kind: Job$/m);
  });

  gate("default (openshift/agent) mode also fuses migrate -> exec", () => {
    expect(render([])).toContain(FUSED);
  });

  gate("migrate.enabled=false boots the app without migrating", () => {
    const out = render([...MODE_B, "--set", "migrate.enabled=false"]);
    // Assert on the actual command, not the bare word "migrate:up" (which also appears in a YAML comment).
    expect(out).not.toContain("npm run migrate:up");
    expect(out).toContain("exec node apps/backend/src/main.js");
  });
});
