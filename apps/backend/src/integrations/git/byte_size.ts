/**
 * byteSizeOfDir — 1:1 port of `codemaster/activities/_clone_common.py::_byte_size_of_dir`.
 *
 * Sum of regular-file sizes under `path`, recursively. Symlinks are skipped (they don't carry their
 * own bytes — mirrors the Python `p.is_file() and not p.is_symlink()` guard). Files that `stat()`
 * cannot read (race against deletion, permission denied) are skipped silently — the workspace-size
 * cap is a safety net, not a precise accounting tool (mirrors the Python `except OSError: pass`).
 *
 * The Python `path.rglob("*")` walks the whole subtree; here we do the equivalent recursive walk with
 * `fs.readdir(..., { withFileTypes: true })`. We use `lstat` (NOT `stat`) so a symlink is detected as
 * a symlink rather than followed to its target — matching `p.is_symlink()`. Directory-entry stat
 * errors during the walk are swallowed too (a directory deleted mid-walk is the same race class).
 */

import { type Dirent, promises as fs } from "node:fs";
import * as path from "node:path";

export async function byteSizeOfDir(root: string): Promise<number> {
  let total = 0;

  async function walk(dir: string): Promise<void> {
    let entries: Array<Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory vanished / unreadable mid-walk — the Python rglob iterator would simply yield
      // nothing further for this subtree. Skip silently (safety-net semantics).
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Skip symlinks — they don't carry their own bytes (mirrors `not p.is_symlink()`). Do NOT
        // recurse through a symlinked directory either; the Python is_symlink check excludes it.
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile()) {
        try {
          const st = await fs.lstat(full);
          total += st.size;
        } catch {
          // stat() failed (race against deletion, permission denied) — skip silently.
        }
      }
    }
  }

  await walk(root);
  return total;
}
