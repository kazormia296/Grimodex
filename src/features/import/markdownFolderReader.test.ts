import { describe, it, expect } from "vitest";
import {
  collectMarkdownFromDir,
  MAX_FOLDER_DEPTH,
  type FolderEntry,
  type FolderReaderFns,
} from "./markdownFolderReader";

interface FsTree {
  [path: string]: FolderEntry[] | string;
}

function fakeFs(tree: FsTree): FolderReaderFns {
  return {
    async readDir(path) {
      const node = tree[path];
      if (Array.isArray(node)) return node;
      throw new Error(`unexpected readDir: ${path}`);
    },
    async readTextFile(path) {
      const node = tree[path];
      if (typeof node === "string") return node;
      throw new Error(`unexpected readTextFile: ${path}`);
    },
  };
}

const file = (name: string): FolderEntry => ({
  name,
  isDirectory: false,
  isFile: true,
  isSymlink: false,
});
const dir = (name: string): FolderEntry => ({
  name,
  isDirectory: true,
  isFile: false,
  isSymlink: false,
});
const symlink = (name: string, isDirectory = false): FolderEntry => ({
  name,
  isDirectory,
  isFile: !isDirectory,
  isSymlink: true,
});

describe("collectMarkdownFromDir", () => {
  it("returns .md and .markdown files with paths relative to base", async () => {
    const fs = fakeFs({
      "/base": [file("a.md"), dir("sub"), file("ignore.txt")],
      "/base/sub": [file("b.markdown"), file("c.md")],
      "/base/a.md": "A",
      "/base/sub/b.markdown": "B",
      "/base/sub/c.md": "C",
    });

    const result = await collectMarkdownFromDir("/base", "/base", fs);
    expect(result).toEqual([
      { relPath: "a.md", content: "A" },
      { relPath: "sub/b.markdown", content: "B" },
      { relPath: "sub/c.md", content: "C" },
    ]);
  });

  it("skips symlinks (both file and directory) to prevent cycles", async () => {
    // A directory symlink that pointed back into the tree would loop
    // forever without this guard. A file symlink could leak content
    // outside the chosen folder.
    const fs = fakeFs({
      "/base": [
        file("real.md"),
        symlink("loop", true), // would point back to /base
        symlink("escape.md"), // would point to /etc/passwd
      ],
      "/base/real.md": "REAL",
    });

    const result = await collectMarkdownFromDir("/base", "/base", fs);
    expect(result).toEqual([{ relPath: "real.md", content: "REAL" }]);
  });

  it("throws when nesting exceeds MAX_FOLDER_DEPTH", async () => {
    // Build /base/d/d/d/... MAX_FOLDER_DEPTH+2 levels deep.
    const tree: FsTree = {};
    let path = "/base";
    for (let i = 0; i <= MAX_FOLDER_DEPTH + 1; i++) {
      tree[path] = [dir("d")];
      path = `${path}/d`;
    }
    tree[path] = [file("deep.md")];
    tree[`${path}/deep.md`] = "DEEP";

    await expect(
      collectMarkdownFromDir("/base", "/base", fakeFs(tree)),
    ).rejects.toThrow(/depth exceeded/);
  });

  it("returns an empty list for an empty directory", async () => {
    const fs = fakeFs({ "/base": [] });
    expect(await collectMarkdownFromDir("/base", "/base", fs)).toEqual([]);
  });

  it("ignores non-markdown files at any depth", async () => {
    const fs = fakeFs({
      "/base": [file("readme.txt"), dir("nested")],
      "/base/nested": [file("notes.json"), file("x.md")],
      "/base/nested/x.md": "X",
    });
    const result = await collectMarkdownFromDir("/base", "/base", fs);
    expect(result).toEqual([{ relPath: "nested/x.md", content: "X" }]);
  });
});
