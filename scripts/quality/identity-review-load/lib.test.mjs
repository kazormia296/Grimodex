import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FOLDER_PERCENTS,
  HONORIFIC_SUFFIXES,
  WORKS,
  assertOutputClean,
  buildShingleSet,
  countShingleHits,
  countTextMismatches,
  crossSetCounts,
  expectedSceneText,
  findUnsafeStrings,
  hashSurface,
  nestedFolderSceneCounts,
  planNestedFolders,
  scenesFromWork,
  stripHonorific,
  summarizeCandidateInventory,
  summarizeSeedInventory,
  surfaceOverlapCounts,
} from "./lib.mjs";
import { findAiCommands } from "./run-inventory.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATA_DIR = "/home/grimodex/fusion-eval-data/pd-2026-11/scenes";

test("入れ子 folder の累積の場面数は ceil(N×k%)", () => {
  assert.deepEqual(nestedFolderSceneCounts(110), [28, 55, 83, 110]);
  assert.deepEqual(nestedFolderSceneCounts(117), [30, 59, 88, 117]);
  assert.deepEqual(nestedFolderSceneCounts(34), [9, 17, 26, 34]);
  assert.deepEqual([...FOLDER_PERCENTS], [25, 50, 75, 100]);
  assert.throws(() => nestedFolderSceneCounts(0));
  assert.throws(() => nestedFolderSceneCounts(1.5));
});

test("入れ子 folder の計画は F(k-1) を先頭の子にし、場面を重複・欠落なく置く", () => {
  for (const count of Object.values(WORKS)) {
    const { counts, folders } = planNestedFolders(count);
    assert.equal(folders.length, 4);
    assert.equal(folders[0].childFolderPercent, null);
    assert.deepEqual(
      folders.map((f) => f.childFolderPercent),
      [null, 25, 50, 75],
    );
    assert.deepEqual(
      folders.map((f) => f.parentPercent),
      [50, 75, 100, null],
    );
    const placed = folders.flatMap((f) => f.addedSceneIndexes);
    assert.deepEqual(
      placed,
      Array.from({ length: count }, (_, i) => i),
    );
    assert.deepEqual(
      folders.map((f) => f.cumulativeSceneCount),
      counts,
    );
    for (const folder of folders)
      assert.ok(folder.addedSceneIndexes.length > 0);
  }
});

test("表記の hash は sha256 の先頭 16 桁", async () => {
  assert.equal(await hashSurface("abc"), "ba7816bf8f01cfea");
  assert.match(await hashSurface("日本語"), /^[0-9a-f]{16}$/u);
  assert.notEqual(await hashSurface("a"), await hashSurface("b"));
});

test("敬称の並びは製品の existingEntityMatcher.ts と同じ", () => {
  const source = readFileSync(
    path.join(ROOT, "src/features/codex/extraction/existingEntityMatcher.ts"),
    "utf8",
  );
  const block = /const HONORIFIC_SUFFIXES = \[([\s\S]*?)\] as const;/u.exec(
    source,
  );
  assert.ok(block, "HONORIFIC_SUFFIXES block not found");
  const product = [...block[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual([...HONORIFIC_SUFFIXES], product);
});

test("stripHonorific は最初に合った敬称 1 つだけを外し、敬称だけの語は残す", () => {
  assert.equal(stripHonorific("田中さん"), "田中");
  assert.equal(stripHonorific("田中先生"), "田中");
  assert.equal(stripHonorific("さん"), "さん");
  assert.equal(stripHonorific("田中さんさん"), "田中さん");
});

test("表記の重なり：敬称・部分文字列の件数", () => {
  const counts = surfaceOverlapCounts([
    "田中",
    "田中さん",
    "田中先生",
    "山田さん",
    "田",
    "Ab",
    "ab",
  ]);
  // distinct：田中, 田中さん, 田中先生, 山田さん, 田, ab（Ab と ab は 1 つ）
  assert.equal(counts.distinct, 6);
  assert.equal(counts.honorificStrippable, 3);
  assert.equal(counts.honorificOverlap, 2); // 田中さん・田中先生（山田さん→山田 は集合に無い）
  // 部分文字列：田中（田中さん等の中）・田は 1 文字なので除外
  assert.equal(counts.substringOfOther, 1);
});

test("seed の目録：出現数・場面あたりの分布・固有名詞の数", () => {
  const out = summarizeSeedInventory([
    {
      surface: "甲",
      occurrenceCount: 3,
      sceneIds: ["a", "a", "b"],
      appearsAsProperName: true,
    },
    {
      surface: "乙さん",
      occurrenceCount: 1,
      sceneIds: ["a"],
      appearsAsProperName: false,
    },
  ]);
  assert.equal(out.seedCount, 2);
  assert.equal(out.occurrenceCount, 4);
  assert.equal(out.properNameSeedCount, 1);
  assert.equal(out.aliasFormSeedCount, 1);
  assert.equal(out.scenesWithSeeds, 2);
  assert.equal(out.distinctSeedsPerScene.max, 2);
  assert.equal(out.distinctSeedsPerScene.min, 1);
  assert.deepEqual(
    Object.keys(out).filter((k) => typeof out[k] === "string"),
    [],
  );
});

test("候補の目録と共通部分", () => {
  const out = summarizeCandidateInventory([
    { surface: "甲", count: 4 },
    { surface: "甲さん", count: 2 },
  ]);
  assert.equal(out.candidateCount, 2);
  assert.equal(out.occurrenceCount, 6);
  assert.equal(out.honorificOverlap, 1);
  assert.deepEqual(crossSetCounts(["甲", "乙"], ["甲", "丙", "丁"]), {
    seedOnly: 1,
    candidateOnly: 2,
    both: 1,
  });
});

test("本文の一致検査は件数だけを返す（本文を載せない）", () => {
  const expected = [expectedSceneText(["一", "二"]), expectedSceneText(["三"])];
  assert.deepEqual(countTextMismatches(expected, [...expected]), {
    expected: 2,
    actual: 2,
    mismatched: 0,
  });
  const result = countTextMismatches(expected, [expected[0], "別"]);
  assert.equal(result.mismatched, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    "actual",
    "expected",
    "mismatched",
  ]);
  assert.equal(countTextMismatches(expected, [expected[0]]).mismatched, 2);
  assert.equal(expectedSceneText(["a", "b"]), "a\nb\n");
});

test("出力の混入検査：文字列の欄は ASCII の識別子の形だけ許す", () => {
  const ok = {
    work: "m-ja-1",
    startedAt: "2026-11-14T00:00:00.000Z",
    hash: "0123456789abcdef",
    path: "/home/x/identity-review-load-2026-11/inventory/m-ja-1.json",
    counts: { a: 1, b: [1, 2, 3] },
  };
  assert.deepEqual(findUnsafeStrings(ok), []);
  assert.deepEqual(findUnsafeStrings({ name: "田中" }), ["$.name"]);
  assert.deepEqual(findUnsafeStrings({ list: ["ok", "日本"] }), ["$.list[1]"]);
  assert.deepEqual(findUnsafeStrings({ 田中: 1 }), ["$.<key>"]);
  assert.ok(findUnsafeStrings({ q: 'He said: "hi"' }).length > 0);
});

test("shingle 走査：原稿の連続 8 文字が出力にあれば検出する（合成の原稿）", () => {
  const scenes = ["abcdefghijklmnop\n", "あいうえおかきくけこ\n"];
  const shingles = buildShingleSet(scenes);
  assert.equal(countShingleHits("xx-abcdefgh-xx", shingles), 1);
  assert.equal(countShingleHits("abcdefg", shingles), 0);
  assert.equal(countShingleHits("あいうえおかきく", shingles), 1);
  assert.equal(countShingleHits("0123456789abcdef", shingles), 0);
  assert.throws(
    () => assertOutputClean({ k: "abcdefghijk" }, scenes),
    /shingle hit/u,
  );
  assert.throws(() => assertOutputClean({ k: "あ" }, scenes), /unsafe string/u);
  assert.doesNotThrow(() =>
    assertOutputClean({ k: "0123456789abcdef", n: 3 }, scenes),
  );
});

test("AI の command の判定は製品の DENIED_COMMANDS の AI 系を全て拾い、通常の command は拾わない", () => {
  const source = readFileSync(
    path.join(ROOT, "electron/main/profileEgress.ts"),
    "utf8",
  );
  const block =
    /const DENIED_COMMANDS = new Map<string, D2aRoute>\(\[([\s\S]*?)\]\);/u.exec(
      source,
    );
  assert.ok(block, "DENIED_COMMANDS block not found");
  const denied = [...block[1].matchAll(/\["([^"]+)", "([^"]+)"\]/gu)].map(
    (m) => ({ name: m[1], route: m[2] }),
  );
  assert.ok(denied.length > 20);
  const aiNames = denied
    .filter((d) => d.route === "old-external-ai" || d.route === "old-local-ai")
    .map((d) => d.name);
  assert.deepEqual(findAiCommands(aiNames), [...new Set(aiNames)].sort());
  assert.deepEqual(
    findAiCommands([
      "tree_node_create",
      "project_create",
      "open_workspace",
      "extract_codex_candidates",
      "extract_codex_entity_seeds",
      "codex_create",
      "narrative_extraction_create_run",
      "ai_audit_read_snapshot",
      "ai_audit_verify",
    ]),
    [],
  );
  assert.deepEqual(
    findAiCommands(["codex_judgment", "ai_usage_record", "send_chat_message"]),
    ["ai_usage_record", "codex_judgment", "send_chat_message"],
  );
});

test(
  "原稿 4 作品：scenes JSON の場面数・段落が計画と一致し、出力に原稿の連続 8 文字が出ない",
  { skip: !existsSync(DATA_DIR) },
  async () => {
    for (const [key, count] of Object.entries(WORKS)) {
      const work = JSON.parse(
        readFileSync(path.join(DATA_DIR, `${key}.json`), "utf8"),
      );
      const scenes = scenesFromWork(work);
      assert.equal(scenes.length, count, `${key} scene count`);
      const texts = scenes.map((scene) => expectedSceneText(scene.paragraphs));
      // 正常な出力（hash と件数だけ）は通る。
      const clean = {
        work: key,
        hashes: [await hashSurface(texts[0].slice(0, 3))],
        n: texts.length,
      };
      assert.doesNotThrow(() => assertOutputClean(clean, texts));
      // 原稿から実行時に切り出した 8 文字（テストのコードにも出力にも載せない）を含む出力は落ちる。
      const probe = [...texts[0]].slice(0, 8).join("");
      assert.throws(
        () => assertOutputClean({ note: probe }, texts),
        /unsafe string|shingle hit/u,
      );
      // 日本語を含まない原稿の断片でも shingle で落ちる経路：ASCII だけの出力に原稿の連続を入れても検出される。
      const shingles = buildShingleSet(texts);
      assert.ok(shingles.size > 1000);
      assert.equal(countShingleHits(JSON.stringify(clean), shingles), 0);
    }
  },
);
