// codex 名寄せマッチャ (Phase 3 バッチ1c) の roundtrip テスト。
//
// 本体は grimodex-core::codex_matching (Aho-Corasick + CJK 境界判定) を
// Tauri と共用する。ここでは napi 署名の疎通と、rebuild 側と match 側が
// **同一の AppState.codex_matcher インスタンス**を見ること（Tauri の
// CodexMatcherState 相当）、および UTF-16 offset・camelCase ワイヤ・
// マッチャ未構築時の空配列 fail-soft を、ビルド済み grimodex-node.node に
// 対して end-to-end で検証する。
//
// マッチャは workspace 非依存（openWorkspace 不要で呼べる）。

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

const root = mkdtempSync(join(tmpdir(), "grimodex-node-codex-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));

/** rustMatcher.ts が送る camelCase MatchEntry と同形。 */
function entry(id, name, extra = {}) {
  return {
    id,
    name,
    entryType: "character",
    aliases: [],
    excludedAliases: [],
    ...extra,
  };
}

test("マッチャ未構築時の codexMatchText は空配列（fail-soft、Tauri と同一）", async () => {
  const matches = JSON.parse(await backend.codexMatchText("太郎は走った", []));
  assert.deepEqual(matches, []);
});

test("rebuild → match で CJK エントリがヒットする（UTF-16 offset・camelCase）", async () => {
  await backend.codexRebuildMatcher([entry("c1", "太郎"), entry("c2", "花子")]);
  const matches = JSON.parse(await backend.codexMatchText("太郎と花子", []));
  assert.equal(matches.length, 2);
  const taro = matches.find((m) => m.entryId === "c1");
  assert.ok(taro, "太郎 がヒット");
  assert.equal(taro.entryName, "太郎");
  assert.equal(taro.entryType, "character");
  // UTF-16 offset: "太郎" は先頭 0..2
  assert.equal(taro.from, 0);
  assert.equal(taro.to, 2);
});

test("excludeEntryIds でヒットを除外できる", async () => {
  const matches = JSON.parse(
    await backend.codexMatchText("太郎と花子", ["c1"]),
  );
  assert.ok(
    matches.every((m) => m.entryId !== "c1"),
    "c1 は除外される",
  );
  assert.ok(
    matches.some((m) => m.entryId === "c2"),
    "c2 は残る",
  );
});

test("rebuild で前のマッチャが置き換わる（同一インスタンス更新）", async () => {
  await backend.codexRebuildMatcher([entry("z1", "新登場人物")]);
  const stale = JSON.parse(await backend.codexMatchText("太郎は走った", []));
  assert.deepEqual(stale, [], "旧エントリ(太郎)はもうヒットしない");
  const fresh = JSON.parse(
    await backend.codexMatchText("新登場人物が現れた", []),
  );
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].entryId, "z1");
});

test("aliases / excludedAliases が反映される", async () => {
  await backend.codexRebuildMatcher([
    entry("a1", "アリス", { aliases: ["Alice"], excludedAliases: [] }),
  ]);
  const byAlias = JSON.parse(await backend.codexMatchText("Alice went", []));
  assert.equal(byAlias.length, 1);
  assert.equal(byAlias[0].entryId, "a1");
});

test("空エントリ配列で rebuild してもクラッシュせず空マッチになる", async () => {
  await backend.codexRebuildMatcher([]);
  const matches = JSON.parse(await backend.codexMatchText("太郎と花子", []));
  assert.deepEqual(matches, []);
});
