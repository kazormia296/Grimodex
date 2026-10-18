/**
 * suggestedName の正規化の単体テスト（K3/2 SF-1 の 7 の (a)。DA-1）。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUGGESTED_NAME,
  MAX_SUGGESTED_NAME_LENGTH,
  sanitizeSuggestedName,
} from "./suggestedName.js";

describe("sanitizeSuggestedName", () => {
  it("通常の名前は変えない", () => {
    for (const name of [
      "out.txt",
      "book.epub",
      "日本語の小説 第1章.md",
      "grimodex-ai-audit-2026-10-17.json",
      "a b (1).txt",
    ]) {
      expect(sanitizeSuggestedName(name, "linux")).toBe(name);
      expect(sanitizeSuggestedName(name, "win32")).toBe(name);
    }
  });

  it("path の区切り（/ と \\）、NUL、制御文字を _ に置き換える", () => {
    expect(sanitizeSuggestedName("/etc/passwd", "linux")).toBe("_etc_passwd");
    expect(sanitizeSuggestedName("a\\b\\c.txt", "linux")).toBe("a_b_c.txt");
    expect(sanitizeSuggestedName("a\0b.txt", "linux")).toBe("a_b.txt");
    expect(sanitizeSuggestedName("a\nb\tc\u007f.txt", "linux")).toBe(
      "a_b_c_.txt",
    );
    expect(sanitizeSuggestedName("../../userData/profile-egress.json")).toBe(
      ".._.._userData_profile-egress.json",
    );
  });

  it("絶対 path・UNC・drive が初期値として dialog に載らない", () => {
    for (const platform of ["linux", "win32", "darwin"] as const) {
      for (const raw of [
        "/home/u/.local/share/Grimodex/profile-egress.json",
        "C:\\Users\\u\\AppData\\Roaming\\Grimodex\\profile-egress.json",
        "\\\\server\\share\\x.json",
        "~/x.json",
      ]) {
        const name = sanitizeSuggestedName(raw, platform);
        expect(name).not.toMatch(/[\\/\0]/);
        expect(name.startsWith("/")).toBe(false);
      }
    }
  });

  it("Windows は drive の区切り（:）も置き換え、ほかの platform は置き換えない", () => {
    expect(sanitizeSuggestedName("C:\\x.json", "win32")).toBe("C__x.json");
    expect(sanitizeSuggestedName("a:b.txt", "win32")).toBe("a_b.txt");
    expect(sanitizeSuggestedName("a:b.txt", "linux")).toBe("a:b.txt");
  });

  it(". と .. だけの名前、空の名前、空白だけの名前は既定名にする", () => {
    for (const raw of ["", ".", "..", "...", "   "]) {
      expect(sanitizeSuggestedName(raw, "linux")).toBe(DEFAULT_SUGGESTED_NAME);
    }
  });

  it("制御文字だけの名前は _ になる（区切りでも . でもない）", () => {
    expect(sanitizeSuggestedName("\t", "linux")).toBe("_");
  });

  it("長さの上限（code point）で切り、拡張子を残す", () => {
    const long = `${"あ".repeat(300)}.json`;
    const name = sanitizeSuggestedName(long, "linux");
    expect(Array.from(name)).toHaveLength(MAX_SUGGESTED_NAME_LENGTH);
    expect(name.endsWith(".json")).toBe(true);

    const noExt = "x".repeat(500);
    expect(Array.from(sanitizeSuggestedName(noExt, "linux"))).toHaveLength(
      MAX_SUGGESTED_NAME_LENGTH,
    );

    // 拡張子が長すぎる（17 文字超）ときは拡張子扱いしない。
    const longExt = `a.${"e".repeat(200)}`;
    expect(Array.from(sanitizeSuggestedName(longExt, "linux"))).toHaveLength(
      MAX_SUGGESTED_NAME_LENGTH,
    );

    // surrogate pair を割らない。
    const emoji = "😀".repeat(200);
    const cut = sanitizeSuggestedName(emoji, "linux");
    expect(Array.from(cut)).toHaveLength(MAX_SUGGESTED_NAME_LENGTH);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("上限ちょうどの名前は変えない", () => {
    const exact = `${"x".repeat(MAX_SUGGESTED_NAME_LENGTH - 4)}.txt`;
    expect(sanitizeSuggestedName(exact, "linux")).toBe(exact);
  });
});
