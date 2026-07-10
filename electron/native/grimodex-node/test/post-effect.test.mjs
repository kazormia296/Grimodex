// post_effect (校閲) pure-db napi 写像のテスト (Electron 移行 Phase 3 バッチ1)。
//
// grimodex-db::post_effect を Tauri と共用する napi 写像を、ビルド済み
// grimodex-node.node に対して検証する。Rust 単体テスト (18件) がロジックを
// 網羅するため、ここは **napi 境界** に集中する:
//   - 読み取り 4 コマンドの応答 struct serialize (空 workspace で正しい形)。
//   - SCENE_LENS_FOR_PROJECT_SQL が napi 経由で実行できること。
//   - update_annotation_status の with_conn 経路 + ワイヤエラー文字列
//     ('annotation not found in project')。
//
// 実行: pnpm napi:build 後に `pnpm --dir electron/native/grimodex-node test`。

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

const root = mkdtempSync(join(tmpdir(), "grimodex-node-pe-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));
const PROJECT = "default-project";

test("workspace 未オープンの listAnnotationsForProject は 'No workspace is open' で reject", async () => {
  await assert.rejects(
    backend.listAnnotationsForProject(PROJECT, null),
    (err) => {
      assert.match(String(err.message), /No workspace is open/);
      return true;
    },
  );
});

test("読み取り 4 コマンドは空 workspace で正しい形を返す（SCENE_LENS SQL 実行含む）", async () => {
  await backend.openWorkspace(join(root, "ws"));

  // limit/offset/effectType 省略（null → None、サーバ既定 20/0）。
  assert.deepEqual(
    JSON.parse(await backend.listPostEffectRuns(PROJECT, null, null, null)),
    [],
  );
  assert.deepEqual(
    JSON.parse(await backend.listAnnotationsForProject(PROJECT, null)),
    { annotations: [] },
  );
  assert.deepEqual(
    JSON.parse(await backend.listAnnotationsForScene(PROJECT, "sc-x", null)),
    { annotations: [], relations: [] },
  );
  // SCENE_LENS_FOR_PROJECT_SQL（相関サブクエリ付き）が napi 経由で実行でき空配列。
  assert.deepEqual(
    JSON.parse(await backend.listSceneLensForProject(PROJECT)),
    [],
  );
});

test("updateAnnotationStatus は存在しない annotation を wire 文字列で reject（with_conn 経路）", async () => {
  await assert.rejects(
    backend.updateAnnotationStatus("nope", "dismissed", PROJECT),
    (err) => {
      assert.match(String(err.message), /annotation not found in project/);
      return true;
    },
  );
});
