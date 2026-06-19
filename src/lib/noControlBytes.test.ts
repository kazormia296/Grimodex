/**
 * ソースファイルへの **生 NUL / 制御バイト混入を禁じる CI ガード**
 * （非ライブ・キー不要・通常スイートで実行）。
 *
 * 過去に .ts ファイルが事実上バイナリ化（NUL バイト混入）して壊れた事故の
 * 再発防止。src 配下の *.ts / *.tsx を一度だけ読み、生 NUL (0x00) や
 * 許可外の制御文字を含むファイルが無いことを保証する。
 * 通常の空白（\t \n \r）は許可する。
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/lib → src まで 1 階層上がる。
const SRC_ROOT = resolve(HERE, "..");

// 走査対象外（依存・ビルド成果物・バイナリアセット）。
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "assets"]);

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

// 許可: \t (0x09) \n (0x0a) \r (0x0d)。それ以外の C0 制御文字と DEL (0x7f) を禁止。
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

describe("source files — 制御バイト混入禁止", () => {
  it("src 配下の *.ts / *.tsx に生 NUL / 制御文字を含まない", () => {
    const files: string[] = [];
    collectSourceFiles(SRC_ROOT, files);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      // latin1 で 1byte=1char にデコードしてからネイティブ正規表現で走査する
      // （utf8 マルチバイト復号も JS 逐次ループも避けられて速い）。
      const text = readFileSync(file).toString("latin1");
      const match = DISALLOWED_CONTROL.exec(text);
      if (match) {
        const code = match[0].charCodeAt(0).toString(16).padStart(2, "0");
        offenders.push(`${file} (0x${code} @ index ${match.index})`);
      }
    }

    expect(
      offenders,
      `禁止された制御バイトを含むソースファイル:\n${offenders.join("\n")}`,
    ).toEqual([]);
  }, 30_000); // src/ 全走査のため既定 5s を引き上げる
});
