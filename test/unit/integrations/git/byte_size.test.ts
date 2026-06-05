/**
 * Unit tests for byteSizeOfDir — 1:1 port of the frozen-Python parity reference
 * (`vendor/codemaster-py/codemaster/activities/_clone_common.py::_byte_size_of_dir`, exercised by the
 * workspace-size-cap path the clone activity enforces).
 *
 * The Python semantics under test:
 *   - sums REGULAR file sizes recursively (`p.is_file() and not p.is_symlink()`);
 *   - SKIPS symlinks (they don't carry their own bytes), and does NOT recurse a symlinked directory;
 *   - swallows `OSError` on a per-file `stat()` (race against deletion) — the cap is a safety net, not
 *     a precise accounting tool.
 *
 * We construct a real temp tree (files + nested dir + a symlink) rather than stub the filesystem: the
 * load-bearing parity surface is the byte arithmetic over a real directory walk, and `node:fs` is the
 * external boundary the Python `pathlib.rglob` walks too.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { byteSizeOfDir } from "#backend/integrations/git/byte_size.js";

const created: Array<string> = [];

async function makeTree(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cm-bytesize-test-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("byteSizeOfDir", () => {
  it("returns 0 for an empty directory", async () => {
    const root = await makeTree();
    expect(await byteSizeOfDir(root)).toBe(0);
  });

  it("sums regular file sizes across nested directories", async () => {
    const root = await makeTree();
    // Top-level file: 5 bytes.
    await fs.writeFile(path.join(root, "a.txt"), "hello"); // 5
    // Nested directory with two files: 3 + 4 = 7 bytes.
    const sub = path.join(root, "sub");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "b.bin"), "abc"); // 3
    await fs.writeFile(path.join(sub, "c.bin"), "wxyz"); // 4
    // Deeper nesting: 2 bytes.
    const deeper = path.join(sub, "deeper");
    await fs.mkdir(deeper);
    await fs.writeFile(path.join(deeper, "d.bin"), "zz"); // 2

    expect(await byteSizeOfDir(root)).toBe(5 + 3 + 4 + 2);
  });

  it("skips a symlinked FILE (it does not carry its own bytes)", async () => {
    const root = await makeTree();
    await fs.writeFile(path.join(root, "real.txt"), "abcdef"); // 6 real bytes
    // A symlink pointing at the real file. The Python `not p.is_symlink()` guard excludes it, so the
    // size is counted exactly once (via the real file, not the link).
    await fs.symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));

    expect(await byteSizeOfDir(root)).toBe(6);
  });

  it("does not recurse through a symlinked DIRECTORY", async () => {
    const root = await makeTree();
    // A real out-of-tree directory holding bytes we must NOT count.
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "big.bin"), "0123456789"); // 10 bytes, behind the symlink

    // A counted tree with one real file.
    const tree = path.join(root, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, "counted.txt"), "xyz"); // 3 bytes
    // Symlink inside `tree` pointing at `outside`: the Python is_symlink check excludes it, so its
    // 10 bytes are NOT walked.
    await fs.symlink(outside, path.join(tree, "shortcut"));

    expect(await byteSizeOfDir(tree)).toBe(3);
  });

  it("returns 0 for a non-existent root (readdir error swallowed)", async () => {
    const root = await makeTree();
    const missing = path.join(root, "does-not-exist");
    // The top-level readdir throws ENOENT; the walk swallows it (safety-net semantics) and returns 0.
    expect(await byteSizeOfDir(missing)).toBe(0);
  });
});
