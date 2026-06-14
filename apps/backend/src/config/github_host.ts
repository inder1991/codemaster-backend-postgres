// GitHub host config (F6b) — supports BOTH github.com (cloud, the default) and GitHub Enterprise Server
// (self-hosted). Two settings because the API and the git/web host differ in shape:
//   * GITHUB_API_BASE — the REST API base. github.com: https://api.github.com (api subdomain, no path).
//     GHE Server: https://HOST/api/v3 (operator supplies the FULL base, including /api/v3).
//   * GITHUB_WEB_HOST — the web/git host (clone URLs + finding permalinks). github.com vs HOST.
// Deploy-level config (set in env at boot like the DB DSN), NOT a per-tenant UI setting — so env→default,
// no DB tier. Default = github.com, so an unconfigured deploy (and next year's cloud move) is zero-config.

/** The REST API base URL — `GITHUB_API_BASE` (trailing slashes trimmed), default `https://api.github.com`. */
export function resolveGithubApiBase(env: Record<string, string | undefined> = process.env): string {
  const v = env["GITHUB_API_BASE"];
  return v !== undefined && v !== "" ? v.replace(/\/+$/, "") : "https://api.github.com";
}

/** The web/git host (no scheme) — `GITHUB_WEB_HOST`, default `github.com`. Used for clone URLs + permalinks. */
export function resolveGithubWebHost(env: Record<string, string | undefined> = process.env): string {
  const v = env["GITHUB_WEB_HOST"];
  return v !== undefined && v !== "" ? v.replace(/^https?:\/\//, "").replace(/\/+$/, "") : "github.com";
}
