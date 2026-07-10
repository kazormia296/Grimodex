/**
 * fsScope の単体テスト（vitest node 環境）。
 * 境界判定の純関数と、実 tmp ディレクトリ + symlink での
 * スコープ照合（エスケープ防止・存在オラクル封じ）を検証する。
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FS_SCOPE_DENIED_MARKER, FsScope, isWithinDir } from "./fsScope.js";

// ─────────────────────────────────────────────────────────────────────────────
// isWithinDir（純関数）
// ─────────────────────────────────────────────────────────────────────────────

describe("isWithinDir", () => {
  it("dir 自身と配下（深い階層含む）は true", () => {
    expect(isWithinDir("/a/b", "/a/b")).toBe(true);
    expect(isWithinDir("/a/b", "/a/b/c.txt")).toBe(true);
    expect(isWithinDir("/a/b", "/a/b/c/d/e.txt")).toBe(true);
  });

  it("兄弟プレフィックス（/a/b vs /a/barbaz）は false — 文字列前方一致の罠", () => {
    expect(isWithinDir("/a/b", "/a/barbaz")).toBe(false);
    expect(isWithinDir("/a/b", "/a/b-sibling/c.txt")).toBe(false);
  });

  it("親方向・.. 抜けは false", () => {
    expect(isWithinDir("/a/b", "/a")).toBe(false);
    expect(isWithinDir("/a/b", "/")).toBe(false);
    expect(isWithinDir("/a/b", path.resolve("/a/b/../c"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FsScope（実 fs + symlink）
// ─────────────────────────────────────────────────────────────────────────────

const base = mkdtempSync(path.join(os.tmpdir(), "grim-fs-scope-"));
const allowedDir = path.join(base, "allowed");
const outsideDir = path.join(base, "outside");
mkdirSync(allowedDir);
mkdirSync(outsideDir);
writeFileSync(path.join(allowedDir, "a.txt"), "in-scope", "utf8");
writeFileSync(path.join(outsideDir, "b.txt"), "out-of-scope", "utf8");
// スコープ内に置かれた、スコープ外実体を指す symlink（エスケープ試行）
symlinkSync(path.join(outsideDir, "b.txt"), path.join(allowedDir, "escape"));
// スコープ内実体を指す symlink（正当）
symlinkSync(path.join(allowedDir, "a.txt"), path.join(allowedDir, "ok-link"));

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("FsScope: dir grant", () => {
  it("許可フォルダ配下の実在ファイルは realpath を返して通る", async () => {
    const scope = new FsScope();
    await scope.allowDir(allowedDir);
    await expect(
      scope.assertReadable(path.join(allowedDir, "a.txt"), { asFile: true }),
    ).resolves.toBe(realpathSync(path.join(allowedDir, "a.txt")));
  });

  it("許可フォルダ自身は readDir（asFile: false）で通る", async () => {
    const scope = new FsScope();
    await scope.allowDir(allowedDir);
    await expect(
      scope.assertReadable(allowedDir, { asFile: false }),
    ).resolves.toBe(realpathSync(allowedDir));
  });

  it("スコープ外の実在ファイルは FS_SCOPE_DENIED で拒否", async () => {
    const scope = new FsScope();
    await scope.allowDir(allowedDir);
    await expect(
      scope.assertReadable(path.join(outsideDir, "b.txt"), { asFile: true }),
    ).rejects.toThrow(FS_SCOPE_DENIED_MARKER);
  });

  it("スコープ外は不存在でも FS_SCOPE_DENIED（ENOENT との出し分けで存在有無を漏らさない）", async () => {
    const scope = new FsScope();
    await scope.allowDir(allowedDir);
    const err = await scope
      .assertReadable(path.join(outsideDir, "no-such.txt"), { asFile: true })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err?.message).toContain(FS_SCOPE_DENIED_MARKER);
    expect(err?.message).not.toContain("ENOENT");
  });

  it("スコープ内の不存在パスは従来どおり ENOENT が伝播する", async () => {
    const scope = new FsScope();
    await scope.allowDir(allowedDir);
    await expect(
      scope.assertReadable(path.join(allowedDir, "missing.txt"), {
        asFile: true,
      }),
    ).rejects.toThrow("ENOENT");
  });

  it("スコープ内 symlink → スコープ外実体のエスケープは拒否", async () => {
    const scope = new FsScope();
    await scope.allowDir(allowedDir);
    await expect(
      scope.assertReadable(path.join(allowedDir, "escape"), { asFile: true }),
    ).rejects.toThrow(FS_SCOPE_DENIED_MARKER);
  });

  it("スコープ内 symlink → スコープ内実体は通る", async () => {
    const scope = new FsScope();
    await scope.allowDir(allowedDir);
    await expect(
      scope.assertReadable(path.join(allowedDir, "ok-link"), { asFile: true }),
    ).resolves.toBe(realpathSync(path.join(allowedDir, "a.txt")));
  });

  it("`..` を含む字面でのスコープ抜けは拒否", async () => {
    const scope = new FsScope();
    await scope.allowDir(allowedDir);
    await expect(
      scope.assertReadable(path.join(allowedDir, "..", "outside", "b.txt"), {
        asFile: true,
      }),
    ).rejects.toThrow(FS_SCOPE_DENIED_MARKER);
  });
});

describe("FsScope: file grant", () => {
  it("選ばれたファイルそのものだけ readTextFile で通る（兄弟は拒否）", async () => {
    const scope = new FsScope();
    await scope.allowFile(path.join(outsideDir, "b.txt"));
    await expect(
      scope.assertReadable(path.join(outsideDir, "b.txt"), { asFile: true }),
    ).resolves.toBe(realpathSync(path.join(outsideDir, "b.txt")));
    await expect(
      scope.assertReadable(path.join(outsideDir, "no-such.txt"), {
        asFile: true,
      }),
    ).rejects.toThrow(FS_SCOPE_DENIED_MARKER);
  });

  it("file grant は readDir（asFile: false）を許可しない", async () => {
    const scope = new FsScope();
    await scope.allowFile(path.join(outsideDir, "b.txt"));
    await expect(
      scope.assertReadable(path.join(outsideDir, "b.txt"), { asFile: false }),
    ).rejects.toThrow(FS_SCOPE_DENIED_MARKER);
  });

  it("symlink をダイアログで選んだ場合、字面・実体の両方の読み取りが通る", async () => {
    const scope = new FsScope();
    await scope.allowFile(path.join(allowedDir, "ok-link"));
    await expect(
      scope.assertReadable(path.join(allowedDir, "ok-link"), { asFile: true }),
    ).resolves.toBe(realpathSync(path.join(allowedDir, "a.txt")));
    await expect(
      scope.assertReadable(path.join(allowedDir, "a.txt"), { asFile: true }),
    ).resolves.toBe(realpathSync(path.join(allowedDir, "a.txt")));
  });
});

describe("FsScope: grant なし", () => {
  it("何も許可されていなければ全パス拒否", async () => {
    const scope = new FsScope();
    await expect(
      scope.assertReadable(path.join(allowedDir, "a.txt"), { asFile: true }),
    ).rejects.toThrow(FS_SCOPE_DENIED_MARKER);
  });
});
