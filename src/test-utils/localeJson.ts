import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * vitest 専用：locale JSON を fs で読む。
 *
 * `@/locales/*.json` を Vite の JSON plugin 経由で import すると、約 300 KB の
 * 変換済みコードを試験 1 ファイルごとに worker へ送って評価する。fs で読んで
 * JSON.parse すれば同じ内容を数 ms で得られる（`vitest.config.ts` の alias が
 * `@/locales/ja.json`／`en.json` をここへ向ける）。内容は同じファイルなので
 * 試験が見る locale は変わらない。
 */
export function readLocaleJson(name: "ja" | "en"): unknown {
  return JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../locales", `${name}.json`),
      "utf8",
    ),
  );
}
