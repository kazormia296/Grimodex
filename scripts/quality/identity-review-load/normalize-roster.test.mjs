import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRosterAgainstScenes, validateRoster } from "./lib.mjs";
import { normalizeRoster } from "./normalize-roster.mjs";

// 合成の架空の作品（実在の原稿の文字列は使わない）。
const scenes = [
  { paragraphs: ["朝、架空太郎が門に立った。", "架空先輩と呼ばれていた。"] },
  { paragraphs: ["太郎さんは笑った。", "門番の架空太郎は戻った。"] },
  { paragraphs: ["先生が来た。", "架空次郎が答えた。"] },
];

function roster(entities) {
  return { schemaVersion: "identity-roster/1", work: "g-ja-3", lineage: "A", narrator: null, entities };
}

test("製品の敬称でない接尾辞の形は別名（L3）に、敬称の形の別名は敬称の対応表に移る", () => {
  const r = roster([
    {
      id: "rt-g-ja-3-001",
      type: "character",
      name: "架空太郎",
      lineage: "A",
      aliases: [{ surface: "太郎さん", level: "L2" }],
      honorificSurfaces: ["架空先輩"],
      ambiguousSurfaces: [],
      firstScene: 1,
      evidence: [{ scene: 1, paragraph: 1 }],
    },
  ]);
  const { roster: out, counts } = normalizeRoster(r, scenes);
  const e = out.entities[0];
  assert.deepEqual(e.aliases, [{ surface: "架空先輩", level: "L3" }]);
  assert.deepEqual(e.honorificSurfaces, ["太郎さん"]);
  assert.equal(counts.honorificToAlias, 1);
  assert.equal(counts.aliasToHonorific, 1);
});

test("名前が敬称の形なら、敬称を外した形（本文に出るとき）を名前にする", () => {
  const r = roster([
    {
      id: "rt-g-ja-3-001",
      type: "character",
      name: "太郎さん",
      lineage: "A",
      aliases: [],
      honorificSurfaces: [],
      ambiguousSurfaces: [],
      firstScene: 2,
      evidence: [{ scene: 2, paragraph: 1 }],
    },
  ]);
  const { roster: out } = normalizeRoster(r, scenes);
  assert.equal(out.entities[0].name, "太郎");
  assert.ok(out.entities[0].honorificSurfaces.includes("太郎さん"));
});

test("本文に出ない表記を外し、初出の場面と根拠を本文から決める。整えた名簿は検査を通る", () => {
  const r = roster([
    {
      id: "rt-g-ja-3-001",
      type: "character",
      name: "架空太郎",
      lineage: "B",
      aliases: [{ surface: "架空の存在しない呼び名", level: "L2" }],
      honorificSurfaces: [],
      ambiguousSurfaces: [{ surface: "先生", sceneRanges: [[3, 3]] }],
      firstScene: 2,
      evidence: [{ scene: 3, paragraph: 2 }],
    },
    {
      id: "rt-g-ja-3-002",
      type: "character",
      name: "架空次郎",
      lineage: "B",
      aliases: [{ surface: "架空次郎", level: "L1" }],
      honorificSurfaces: [],
      ambiguousSurfaces: [],
      firstScene: 1,
      evidence: [{ scene: 3, paragraph: 2 }],
    },
  ]);
  const { roster: out, counts } = normalizeRoster(r, scenes);
  assert.equal(counts.surfaceDroppedNotInText, 1);
  assert.equal(out.entities[0].firstScene, 1);
  assert.ok(out.entities[0].evidence.some((ev) => ev.scene === 1));
  assert.deepEqual(out.entities[1].aliases, []);
  assert.equal(out.entities[1].firstScene, 3);
  const v = validateRoster(out, { paragraphCounts: scenes.map((s) => s.paragraphs.length) });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(checkRosterAgainstScenes(out, scenes), []);
});

test("同じ入力から同じ出力を作る（決定的）", () => {
  const r = roster([
    {
      id: "rt-g-ja-3-001",
      type: "character",
      name: "架空太郎",
      lineage: "A",
      aliases: [{ surface: "架空先輩", level: "L2" }, { surface: "架空先輩", level: "L3" }],
      honorificSurfaces: ["太郎さん"],
      ambiguousSurfaces: [],
      firstScene: 1,
      evidence: [{ scene: 1, paragraph: 1 }],
    },
  ]);
  const a = normalizeRoster(r, scenes);
  const b = normalizeRoster(r, scenes);
  assert.deepEqual(a, b);
  assert.deepEqual(a.roster.entities[0].aliases, [{ surface: "架空先輩", level: "L2" }]);
});

test("関係の呼び名：保ち、同じ実体の別名・敬称の形・場面依存の表記から外し、本文に出ないものと名前と同じものは外す", () => {
  const r = roster([
    {
      id: "rt-g-ja-3-001",
      type: "character",
      name: "架空太郎",
      lineage: "A",
      aliases: [
        { surface: "架空先輩", level: "L2" },
        { surface: "架空次郎", level: "L3" },
      ],
      honorificSurfaces: ["太郎さん"],
      ambiguousSurfaces: [{ surface: "先生", sceneRanges: [[3, 3]] }],
      relationalSurfaces: [
        "架空先輩", // 別名と重なる
        "太郎さん", // 敬称の形と重なる
        "先生", // 場面依存と重なる
        "先生", // 重複
        "本文に無い呼び名", // 本文に出ない
        "架空太郎", // 名前と同じ
      ],
      firstScene: 1,
      evidence: [{ scene: 1, paragraph: 1 }],
    },
  ]);
  const { roster: out, counts } = normalizeRoster(r, scenes);
  const e = out.entities[0];
  assert.deepEqual(e.relationalSurfaces, ["架空先輩", "太郎さん", "先生"]);
  assert.deepEqual(e.aliases, [{ surface: "架空次郎", level: "L3" }]);
  assert.deepEqual(e.honorificSurfaces, []);
  assert.deepEqual(e.ambiguousSurfaces, []);
  assert.equal(counts.relationalPrioritized, 3);
  assert.equal(counts.relationalDroppedDuplicate, 1);
  assert.equal(counts.relationalDroppedNotInText, 1);
  assert.equal(counts.relationalDroppedAsName, 1);
  assert.deepEqual(validateRoster(out).errors, []);
  assert.deepEqual(checkRosterAgainstScenes(out, scenes), []);
});

test("関係の呼び名の欄が無い名簿では欄を作らない", () => {
  const r = roster([
    {
      id: "rt-g-ja-3-001",
      type: "character",
      name: "架空太郎",
      lineage: "A",
      aliases: [],
      honorificSurfaces: [],
      ambiguousSurfaces: [],
      firstScene: 1,
      evidence: [{ scene: 1, paragraph: 1 }],
    },
  ]);
  const { roster: out } = normalizeRoster(r, scenes);
  assert.equal("relationalSurfaces" in out.entities[0], false);
});
