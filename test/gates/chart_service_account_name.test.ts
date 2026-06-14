// Gate (Mode B Vault-binding contract): the Vault Kubernetes-auth role binds the pod's ServiceAccount
// BY NAME (`bound_service_account_names`, docs/runbooks/first-deploy.md §3) — a cross-team contract a
// Vault admin sets up BEFORE, and independently of, whoever later runs `helm install` and picks a release
// name. So the chart MUST render a STABLE, release-INDEPENDENT ServiceAccount name (default
// `codemaster-backend`), or Mode B breaks: pre-fix the name was release-derived (fullname), so
// `helm install codemaster …` produced `codemaster-codemaster-backend`, which the Vault role rejected
// → pod login 403 → boot crashloop. This gate pins the name so that drift can never silently return.
// The Deployment, migrate Job and helm-test pod all resolve the SAME helper, so one assertion guards all.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const chartDir = join(repoRoot, "deploy", "helm", "codemaster-backend");

/** Render one chart template under a given release name. */
function render(release: string, showOnly: string): string {
  return execFileSync("helm", ["template", release, chartDir, "--show-only", showOnly], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

// helm is a deploy-battery dependency (the battery runs `helm lint`); skip cleanly where it is absent
// rather than fail an unrelated contributor's unit run.
let helmOk = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
  helmOk = true;
} catch {
  // helm not on PATH.
}
const gate = helmOk ? it : it.skip;

describe("chart ServiceAccount name is release-independent (Mode B Vault binding)", () => {
  gate("renders the bound SA name even when the release name would prepend (the drift trigger)", () => {
    // A release name that does NOT contain the chart name is exactly what made fullname prepend it.
    const sa = render("codemaster", "templates/serviceaccount.yaml");
    expect(sa).toMatch(/^ {2}name: codemaster-backend$/m);
  });

  gate("renders the same bound SA name when the release name already matches", () => {
    const sa = render("codemaster-backend", "templates/serviceaccount.yaml");
    expect(sa).toMatch(/^ {2}name: codemaster-backend$/m);
  });

  gate("binds the pod (Deployment) to that same SA name", () => {
    const deploy = render("codemaster", "templates/deployment.yaml");
    expect(deploy).toMatch(/serviceAccountName: codemaster-backend$/m);
  });
});
