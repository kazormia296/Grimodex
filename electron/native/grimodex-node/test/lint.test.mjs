// lint / reorder / fonts (Phase 3 バッチ1b) の roundtrip テスト。
//
// grimodex-lint (UniDic 埋め込み) / grimodex-fonts を Tauri と共用する
// napi 署名の疎通と、lint_text 固有の **LintError object ワイヤ**
// (reason = {"type":…,"data":…} JSON → ipcContract が object reject に復元)
// をビルド済み grimodex-node.node に対して end-to-end で検証する。
//
// 注意: 初回の lint / segmentBunsetsu は UniDic のコールドロードで
// 数秒〜10s かかりうる (FE 側は SLOW_COMMANDS 対応済み)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-lint-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// lint / fonts は workspace 非依存 (openWorkspace 不要で呼べることも契約の一部)
const backend = new Backend(join(root, "app-data"));

/** lintStore.ts が送る形と同形の最小 LintBlock。 */
function block(id, text) {
  return { id, kind: "paragraph", text, str_offset_start: 0 };
}

test("lintText は workspace 未オープンでも LintResponse JSON を返す", async () => {
  const resp = JSON.parse(
    await backend.lintText(
      [block(1, "これはは、テストの文章です。。")],
      "ja",
      { kind: "scene", scene_id: "s1" },
      {},
      [],
    ),
  );
  assert.equal(typeof resp, "object");
  assert.ok(Array.isArray(resp.diagnostics));
});

test("lintText の不正 language は LintError の {type,data} JSON reason で reject する", async () => {
  await assert.rejects(
    backend.lintText([block(1, "x")], "fr", { kind: "project" }, {}, []),
    (err) => {
      const parsed = JSON.parse(String(err.message));
      assert.equal(parsed.type, "InvalidLanguage");
      assert.equal(parsed.data, "fr");
      return true;
    },
  );
});

test("segmentBunsetsu は UTF-16 offset の文節 DTO 配列を返す", async () => {
  const chunks = JSON.parse(await backend.segmentBunsetsu("走れメロスは激怒した。"));
  assert.ok(Array.isArray(chunks));
  assert.ok(chunks.length >= 1, "少なくとも 1 文節に分割される");
  for (const c of chunks) {
    assert.equal(typeof c.start, "number");
    assert.equal(typeof c.end, "number");
    assert.equal(typeof c.surface, "string");
  }
});

test("segmentBunsetsu はサイズ上限超過を Tauri と同一文言で reject する", async () => {
  const huge = "あ".repeat(4 * 1024 * 1024); // MAX_INPUT_BYTES (どの設定値でも超える)
  await assert.rejects(backend.segmentBunsetsu(huge), (err) => {
    assert.match(String(err.message), /text exceeds maximum length of \d+ bytes/);
    return true;
  });
});

test("listSystemFonts は昇順・重複なしの family 名配列を返す", async () => {
  const fonts = JSON.parse(await backend.listSystemFonts());
  assert.ok(Array.isArray(fonts));
  const lower = fonts.map((f) => f.toLowerCase());
  assert.deepEqual(lower, [...lower].sort(), "大小無視の昇順");
  assert.equal(new Set(lower).size, lower.length, "大小無視で重複なし");
});
