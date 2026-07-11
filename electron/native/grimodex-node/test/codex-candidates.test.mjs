// extract_codex_candidates (Phase 3 Batch 4) の実 .node roundtrip。
//
// shared grimodex-semantic core が workspace DB を読み、UniDic 解析を DB lock 外で
// 実行して camelCase CodexCandidate[] を返す NAPI 境界を検証する。

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

const root = mkdtempSync(join(tmpdir(), "grimodex-node-candidates-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));
const workspace = join(root, "workspace");

async function exec(sql, params = [], method = "run") {
  return JSON.parse(await backend.dbExecute(sql, params, method)).rows;
}

function proseDoc(text) {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

test("workspace 未オープンは Tauri と同じエラーマーカーで reject する", async () => {
  await assert.rejects(
    backend.extractCodexCandidates("default-project", 2),
    /No workspace is open/,
  );
});

test("既知名を除外し、未知固有名詞を count/初出/context 付きで返す", async () => {
  await backend.openWorkspace(workspace);
  await exec(
    "INSERT INTO codex_entries (id, project_id, name, aliases) VALUES ('known-tokyo', 'default-project', '東京', '[]')",
  );
  await exec(
    "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, content) VALUES ('scene-1', 'default-project', 'scene', '第一場', 'a0', ?)",
    [proseDoc("東京から京都へ行った。京都では雨が降った。")],
  );

  const candidates = JSON.parse(
    await backend.extractCodexCandidates("default-project", 2),
  );
  const kyoto = candidates.find((candidate) => candidate.surface === "京都");
  assert.ok(kyoto, "未知の固有名詞 京都 が候補に含まれる");
  assert.equal(typeof kyoto.lemma, "string");
  assert.ok(kyoto.lemma.length > 0, "UniDic 語彙素が入る");
  assert.equal(kyoto.count, 2);
  assert.equal(kyoto.firstSceneId, "scene-1");
  assert.match(kyoto.context, /京都/);
  assert.equal(
    candidates.some((candidate) => candidate.surface === "東京"),
    false,
    "既知 Codex 名は除外される",
  );
});

test("非日本語 project は解析せず空配列を返す", async () => {
  await exec(
    "UPDATE projects SET language = 'en' WHERE id = 'default-project'",
  );
  const candidates = JSON.parse(
    await backend.extractCodexCandidates("default-project", undefined),
  );
  assert.deepEqual(candidates, []);
});
