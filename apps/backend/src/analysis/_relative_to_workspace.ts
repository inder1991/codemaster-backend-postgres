/**
 * `_relative_to_workspace` — shared helper for the three analysis runners. Hoisted here so there is
 * one canonical copy.
 *
 * Returns `filePath` relative to `workspace` when it is inside the workspace; otherwise passes the
 * path through with a leading-slash strip (`file_path.lstrip("/")`). An empty `filePath` maps to "".
 */

import { isAbsolute, relative } from "node:path";

/** Return `filePath` relative to `workspace`, or a leading-slash-stripped passthrough. */
export function relativeToWorkspace(filePath: string, workspace: string): string {
  if (!filePath) return "";
  // `path.relative` returns a `../`-prefixed path when `file_path` is not under `workspace`; detect
  // that case and fall back to the leading-slash-strip passthrough.
  const rel = relative(workspace, filePath);
  const notUnderWorkspace = rel === "" || rel.startsWith("..") || isAbsolute(rel);
  if (notUnderWorkspace) {
    return stripLeadingSlashes(filePath);
  }
  return rel;
}

/** Strip ALL leading "/" characters (not just one). */
function stripLeadingSlashes(s: string): string {
  let i = 0;
  // `s[i]` is a length-bounded numeric index into a local string, not an attacker-controlled object
  // key — the security rule's prototype-pollution threat model does not apply.
  // eslint-disable-next-line security/detect-object-injection
  while (i < s.length && s[i] === "/") i += 1;
  return s.slice(i);
}
