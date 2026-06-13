import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DOC_PATH,
  renderDoc,
  renderSeeder,
  SEED_PATH,
} from "../../scripts/gen_deploy_artifacts.js";

// The operator-facing deploy doc + Vault seeder are GENERATED from DEPLOY_CONTRACT. These pin the
// committed artifacts to the generator output, so adding/changing a contract entry without running
// `npm run gen:deploy-artifacts` fails CI — the doc + seeder can never silently drift from the truth.
describe("deploy artifacts stay in sync with DEPLOY_CONTRACT", () => {
  it("docs/runbooks/deploy-contract.md matches the generator", () => {
    expect(readFileSync(DOC_PATH, "utf-8")).toBe(renderDoc());
  });

  it("deploy/seed-vault.sh matches the generator", () => {
    expect(readFileSync(SEED_PATH, "utf-8")).toBe(renderSeeder());
  });
});
