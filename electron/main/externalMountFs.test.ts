/**
 * externalMountFs の単体テスト（vitest node 環境、実 fs + 一時ディレクトリ）。
 * Tauri 側 external_mount::{io,path,scan,hash} + reject_unsafe_workspace_path の
 * Rust テストを移植し、ワイヤ / セキュリティ契約の parity を gate する。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  ftruncateSync,
  closeSync,
  lstatSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_SCAN_DEPTH,
  MAX_TEXT_FILE_BYTES,
  atomicWriteText,
  contentHash,
  fileMtimeIso,
  isPathInside,
  normalizeRelPath,
  pathsOverlap,
  readTextFile,
  rejectUnsafeMountPath,
  resolveUnderRoot,
  scanRoot,
} from "./externalMountFs.js";

const created: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `gmx-emfs-${name}-`));
  const canonicalDir = realpathSync.native(dir);
  created.push(canonicalDir);
  return canonicalDir;
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("contentHash", () => {
  it("CRLF と LF で同じハッシュ（Rust crlf_and_lf_produce_same_hash）", () => {
    expect(contentHash("hello\r\nworld")).toBe(contentHash("hello\nworld"));
  });

  it("既知の SHA-256 と一致（Web Crypto 実装 contentHash.ts と共通）", () => {
    // echo -n "hi" | sha256sum
    expect(contentHash("hi")).toBe(
      "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    );
  });
});

describe("normalizeRelPath / isPathInside / pathsOverlap", () => {
  it("バックスラッシュを forward slash へ", () => {
    expect(normalizeRelPath("chapter\\01.md")).toBe("chapter/01.md");
  });

  it("境界安全: /tmp/foo は /tmp/foobar を含まない（Rust one_contains_other_boundary）", () => {
    const foo = path.join(path.sep, "tmp", "foo");
    const foobar = path.join(path.sep, "tmp", "foobar");
    expect(isPathInside(foo, foo)).toBe(true);
    expect(isPathInside(foobar, foo)).toBe(false);
    expect(isPathInside(foo, foobar)).toBe(false);
    expect(pathsOverlap(foo, foobar)).toBe(false);
  });

  it("ネスト: parent は child を含む（Rust one_contains_other_nested）", () => {
    const parent = path.join(path.sep, "tmp", "parent");
    const child = path.join(parent, "chapter", "01.md");
    expect(isPathInside(child, parent)).toBe(true);
    expect(pathsOverlap(parent, child)).toBe(true);
  });
});

describe("resolveUnderRoot", () => {
  it("`..` traversal を拒否（Rust rejects_parent_dir_traversal）", async () => {
    const root = tempDir("resolve");
    await expect(resolveUnderRoot(root, "../escape.md")).rejects.toThrow(
      /traversal/,
    );
  });

  it("絶対パスの relPath を拒否", async () => {
    const root = tempDir("resolve-abs");
    await expect(
      resolveUnderRoot(root, path.join(path.sep, "etc", "passwd")),
    ).rejects.toThrow(/absolute paths are not allowed/);
  });

  it("存在する配下ファイルを解決", async () => {
    const root = tempDir("resolve-ok");
    mkdirSync(path.join(root, "chapter"));
    writeFileSync(path.join(root, "chapter", "01.md"), "# hi");
    const resolved = await resolveUnderRoot(root, "chapter/01.md");
    expect(resolved.endsWith(path.join("chapter", "01.md"))).toBe(true);
  });

  it("存在しないパスは解決失敗（write は既存ファイルのみ成立の契約）", async () => {
    const root = tempDir("resolve-missing");
    await expect(resolveUnderRoot(root, "nope.md")).rejects.toThrow(
      /failed to resolve/,
    );
  });
});

describe("atomicWriteText / readTextFile / fileMtimeIso", () => {
  it("書込→読込ラウンドトリップ + CRLF 正規化（Rust atomic_write_roundtrip）", async () => {
    const dir = tempDir("atomic");
    const file = path.join(dir, "test.md");
    writeFileSync(file, ""); // 事前作成（resolve は不要、直接 abs 書込）
    await atomicWriteText(file, "hello\r\nworld");
    expect(await readTextFile(file)).toBe("hello\nworld");
  });

  it("tmp を残さない", async () => {
    const dir = tempDir("atomic-tmp");
    const file = path.join(dir, "t.md");
    await atomicWriteText(file, "x");
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith(".t.md-"))).toBe(
      false,
    );
    expect(await readTextFile(file)).toBe("x");
  });

  it("POSIXではatomic rename後も既存ファイルのpermission bitsを保持する", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir("atomic-mode");
    const file = path.join(dir, "shared.md");
    writeFileSync(file, "before");
    chmodSync(file, 0o664);

    await atomicWriteText(file, "after");

    expect(statSync(file).mode & 0o777).toBe(0o664);
  });

  it("POSIXでは読込対象のsymlinkを追従しない", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir("read-symlink");
    const target = path.join(dir, "outside.txt");
    const link = path.join(dir, "chapter.md");
    writeFileSync(target, "must not be read through a link");
    try {
      symlinkSync(target, link);
    } catch {
      return; // symlink 不可環境は skip
    }

    await expect(readTextFile(link)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("一時ファイルのsymlinkを追従せず、既存パスを削除もしない", async () => {
    const dir = tempDir("atomic-symlink");
    const file = path.join(dir, "chapter.md");
    const outside = path.join(dir, "outside.txt");
    const tmp = path.join(dir, `.chapter.md-${process.pid}-fixed-id.tmp`);
    writeFileSync(file, "original");
    writeFileSync(outside, "must survive");
    try {
      symlinkSync(outside, tmp);
    } catch {
      return; // symlink 不可環境は skip
    }

    await expect(
      atomicWriteText(file, "attacker-controlled", {
        randomId: () => "fixed-id",
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(readFileSync(outside, "utf8")).toBe("must survive");
    expect(lstatSync(tmp).isSymbolicLink()).toBe(true);
  });

  it("保存先がsymlinkへ交換されてもリンク先を上書きしない", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir("atomic-destination-symlink");
    const file = path.join(dir, "chapter.md");
    const outside = path.join(dir, "outside.txt");
    writeFileSync(outside, "must survive");
    try {
      symlinkSync(outside, file);
    } catch {
      return; // symlink 不可環境は skip
    }

    await atomicWriteText(file, "replacement");
    expect(readFileSync(outside, "utf8")).toBe("must survive");
    expect(readFileSync(file, "utf8")).toBe("replacement");
  });

  it("同時保存は競合せず、ランダムtmpを片付ける", async () => {
    const dir = tempDir("atomic-concurrent");
    const file = path.join(dir, "chapter.md");
    await Promise.all([
      atomicWriteText(file, "first"),
      atomicWriteText(file, "second"),
    ]);
    expect(["first", "second"]).toContain(readFileSync(file, "utf8"));
    expect(
      readdirSync(dir).filter((name) => name.startsWith(".chapter.md-")),
    ).toEqual([]);
  });

  it("32 MiB 超過ファイルを拒否（RUST-DOS-01）", async () => {
    const dir = tempDir("cap");
    const file = path.join(dir, "big.md");
    // sparse file で size だけ上限超えにする（33 MiB を実書込しない）。
    const fd = openSync(file, "w");
    ftruncateSync(fd, MAX_TEXT_FILE_BYTES + 1);
    closeSync(fd);
    await expect(readTextFile(file)).rejects.toThrow(/file too large to read/);
  });

  it("mtime を ISO 文字列で返す", async () => {
    const dir = tempDir("mtime");
    const file = path.join(dir, "m.md");
    writeFileSync(file, "x");
    const iso = await fileMtimeIso(file);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(iso).getTime()).toBeGreaterThan(0);
  });
});

describe("scanRoot", () => {
  it(".md ファイルとディレクトリを収集（Rust scan_finds_md_files_and_dirs）", async () => {
    const dir = tempDir("scan-basic");
    mkdirSync(path.join(dir, "chapter"));
    writeFileSync(path.join(dir, "chapter", "01-intro.md"), "# Intro\n");
    writeFileSync(path.join(dir, "notes.md"), "note");
    const result = await scanRoot(dir);
    expect(result.files.length).toBe(2);
    expect(result.dirs.some((d) => d.relPath === "chapter")).toBe(true);
    const intro = result.files.find((f) => f.relPath === "chapter/01-intro.md");
    expect(intro?.content).toBe("# Intro\n");
    expect(intro?.contentHash).toBe(contentHash("# Intro\n"));
  });

  it("非 .md を除外", async () => {
    const dir = tempDir("scan-ext");
    writeFileSync(path.join(dir, "keep.md"), "a");
    writeFileSync(path.join(dir, "skip.txt"), "b");
    const result = await scanRoot(dir);
    expect(result.files.map((f) => f.relPath)).toEqual(["keep.md"]);
  });

  it("rel_path 昇順ソート", async () => {
    const dir = tempDir("scan-sort");
    writeFileSync(path.join(dir, "b.md"), "b");
    writeFileSync(path.join(dir, "a.md"), "a");
    const result = await scanRoot(dir);
    expect(result.files.map((f) => f.relPath)).toEqual(["a.md", "b.md"]);
  });

  it("symlink を追従しない", async () => {
    const dir = tempDir("scan-symlink");
    const outside = tempDir("scan-symlink-outside");
    writeFileSync(path.join(outside, "secret.md"), "secret");
    try {
      symlinkSync(outside, path.join(dir, "link"));
    } catch {
      return; // symlink 不可環境は skip
    }
    const result = await scanRoot(dir);
    expect(result.files.length).toBe(0);
    expect(result.dirs.length).toBe(0);
  });

  it("深さ上限で reject（Rust scan_errors_when_depth_exceeded）", async () => {
    const dir = tempDir("scan-depth");
    let nested = dir;
    for (let i = 0; i <= MAX_SCAN_DEPTH; i += 1) {
      nested = path.join(nested, `level-${i}`);
      mkdirSync(nested);
    }
    writeFileSync(path.join(nested, "deep.md"), "deep");
    await expect(scanRoot(dir)).rejects.toThrow(/scan depth exceeded/);
  });
});

describe("rejectUnsafeMountPath (PIO-1)", () => {
  it("相対パスを拒否", async () => {
    await expect(rejectUnsafeMountPath("relative/dir")).rejects.toThrow(
      /must be absolute/,
    );
  });

  it("`..` を含むパスを拒否", async () => {
    // path.join は `..` を正規化して畳むため、リテラルな `..` 成分を Array.join で組む。
    const p = [os.tmpdir(), "..", "evil"].join(path.sep);
    await expect(rejectUnsafeMountPath(p)).rejects.toThrow(/must not contain/);
  });

  it("システムディレクトリ配下を拒否（unix）", async () => {
    if (process.platform === "win32") return;
    await expect(rejectUnsafeMountPath("/etc/grimodex-evil")).rejects.toThrow(
      /system directory/,
    );
  });

  it("通常の一時ディレクトリは許可", async () => {
    const dir = tempDir("safe");
    await expect(rejectUnsafeMountPath(dir)).resolves.toBeUndefined();
  });
});
