// 名簿の形式・衝突・chunk・突合・層別の選択・作者の確認の表・応答の取り込みの純関数の試験。
// 原稿・名簿は合成（架空の短い文）。実際の原稿は読まない（chunk の実測だけ、存在すれば行う）。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REVIEW_VERDICTS,
  WORKS,
  assertOutputClean,
  comparePersistedScene,
  countRubyNotations,
  expectedSceneText,
  findCollisions,
  isHonorificForm,
  paragraphSegments,
  proseMirrorParagraphTexts,
  rosterAtLevel,
  rubyBaseText,
  rubySurfaceRelation,
  scenesFromWork,
  validateRoster,
  wilsonUpper,
} from "./lib.mjs";
import {
  assertSheetHidesMarks,
  chunkPair,
  chunkScenes,
  diffRosters,
  excerptHtml,
  finalizeUnreviewed,
  ingestReview,
  interiorBoundaries,
  renderChunkText,
  renderReviewHtml,
  selectReviewRows,
  sharedBoundaryCount,
} from "./roster-tools.mjs";
import { resolveWorkSource } from "./sources.mjs";
import { runCommand } from "./roster-cli.mjs";

const WORK = "g-ja-2";

/** 合成の原稿：n 場面、各場面は固定の段落数の短い架空の文。 */
function syntheticScenes(n, paragraphsPerScene = 3, size = 100) {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    paragraphs: Array.from(
      { length: paragraphsPerScene },
      (_, p) => `架空${i + 1}の${p + 1}番目の文。${"あ".repeat(size)}`,
    ),
  }));
}

function entity(n, overrides = {}) {
  return {
    id: `rt-${WORK}-${String(n).padStart(3, "0")}`,
    type: "character",
    name: `名前${n}`,
    aliases: [],
    honorificSurfaces: [],
    ambiguousSurfaces: [],
    evidence: [{ scene: 1, paragraph: 1 }],
    lineage: "A",
    ...overrides,
  };
}
const roster = (entities, extra = {}) => ({
  schemaVersion: "identity-roster/1",
  work: WORK,
  lineage: "A",
  entities,
  ...extra,
});
const codes = (result) => result.errors.map((e) => e.code);

// ---- ルビ・ProseMirror ---------------------------------------------------------

test("ルビ：記法を親文字だけにした本文と、記法の数", () => {
  assert.equal(rubyBaseText("｜暁子《あきこ》が走る。"), "暁子が走る。");
  assert.equal(rubyBaseText("漢字《かんじ》と《《強調》》。"), "漢字と強調。");
  assert.equal(
    countRubyNotations(["｜甲《こう》｜乙《おつ》", "《《強調》》のみ"]),
    2,
  );
  assert.equal(rubyBaseText("ルビなし"), "ルビなし");
});

test("ルビ：ProseMirror の段落・ruby node の数え方と、保存本文の突合", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "ruby", attrs: { base: "暁子", annotation: "あきこ" } },
          { type: "text", text: "が走る。" },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "二段落目。" }] },
    ],
  };
  const parsed = proseMirrorParagraphTexts(JSON.stringify(doc));
  assert.deepEqual(parsed.paragraphs, ["暁子が走る。", "二段落目。"]);
  assert.equal(parsed.rubyCount, 1);
  const ok = comparePersistedScene(
    ["｜暁子《あきこ》が走る。", "二段落目。"],
    JSON.stringify(doc),
  );
  assert.deepEqual(
    [ok.paragraphCountOk, ok.textOk, ok.rubyOk],
    [true, true, true],
  );
  // 段落が潰れた・ruby が落ちた場合は件数で検出される。
  const flat = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "暁子が走る。二段落目。" }],
      },
    ],
  };
  const bad = comparePersistedScene(
    ["｜暁子《あきこ》が走る。", "二段落目。"],
    JSON.stringify(flat),
  );
  assert.deepEqual(
    [bad.paragraphCountOk, bad.textOk, bad.rubyOk],
    [false, false, false],
  );
});

test("ルビ：抜粋用の分割（親文字つき・自動ルビ・強調）", () => {
  assert.deepEqual(paragraphSegments("前｜暁子《あきこ》後"), [
    { base: "前", reading: null },
    { base: "暁子", reading: "あきこ" },
    { base: "後", reading: null },
  ]);
  assert.deepEqual(paragraphSegments("漢字《かんじ》"), [
    { base: "漢字", reading: "かんじ" },
  ]);
});

test("ルビの付いた表記の関係：親文字に等しい／含む表記を数える", () => {
  const r = rubySurfaceRelation(
    ["暁子", "港"],
    ["暁子", "暁子さん", "港", "別の語"],
  );
  assert.equal(r.exact, 2);
  assert.equal(r.containing, 1);
  assert.deepEqual([...r.exactSurfaces].sort(), ["暁子", "港"].sort());
});

test("作品の入力元：新しい 3 本は測定 dir、m-ja-2 は評価データ、--data-dir は上書き", () => {
  assert.match(
    resolveWorkSource("g-ja-3"),
    /identity-review-load-2026-11\/scenes\/g-ja-3\.json$/u,
  );
  assert.match(
    resolveWorkSource("m-ja-2"),
    /fusion-eval-data\/pd-2026-11\/scenes\/m-ja-2\.json$/u,
  );
  assert.equal(resolveWorkSource("g-ja-2", "/x"), "/x/g-ja-2.json");
  assert.throws(() => resolveWorkSource("m-ja-1"));
  assert.deepEqual(WORKS, {
    "g-ja-2": 60,
    "g-ja-3": 60,
    "g-ja-4": 60,
    "m-ja-2": 117,
  });
});

// ---- 名簿の検査と衝突 -------------------------------------------------------------

test("名簿の検査：正しい名簿は通り、各違反は固有の code で出る（表記は載せない）", () => {
  const good = roster([
    entity(1, {
      aliases: [{ surface: "略称", level: "L2" }],
      honorificSurfaces: ["名前1さん"],
    }),
    entity(2, { type: "location" }),
  ]);
  assert.deepEqual(validateRoster(good).errors, []);
  const cases = [
    ["ENTITY_ID_FORMAT", roster([entity(1, { id: "rt-g-ja-3-001" })])],
    ["ENTITY_ID_DUPLICATE", roster([entity(1), entity(1)])],
    ["ENTITY_TYPE", roster([entity(1, { type: "item" })])],
    ["NAME_INVALID", roster([entity(1, { name: " 前後空白 " })])],
    [
      "ALIAS_LEVEL",
      roster([entity(1, { aliases: [{ surface: "略", level: "L9" }] })]),
    ],
    [
      "ALIAS_DUPLICATE_IN_ENTITY",
      roster([entity(1, { aliases: [{ surface: "名前1", level: "L1" }] })]),
    ],
    [
      "ALIAS_IS_HONORIFIC_FORM",
      roster([entity(1, { aliases: [{ surface: "名前1さん", level: "L2" }] })]),
    ],
    [
      "HONORIFIC_NOT_HONORIFIC_FORM",
      roster([entity(1, { honorificSurfaces: ["名前1"] })]),
    ],
    [
      "HONORIFIC_OVERLAPS_ALIAS",
      roster([
        entity(1, { aliases: [{ surface: "甲氏", level: "L3" }] }),
        entity(2, { honorificSurfaces: ["名前1さん", "甲氏"] }),
      ]),
    ],
    [
      "AMBIGUOUS_IN_ALIAS",
      roster([
        entity(1, {
          aliases: [{ surface: "略", level: "L2" }],
          ambiguousSurfaces: [{ surface: "略", sceneRanges: [[1, 2]] }],
        }),
      ]),
    ],
    [
      "AMBIGUOUS_RANGE_INVALID",
      roster([
        entity(1, {
          ambiguousSurfaces: [{ surface: "彼", sceneRanges: [[3, 2]] }],
        }),
      ]),
    ],
    [
      "AMBIGUOUS_RANGE_INVALID",
      roster([
        entity(1, {
          ambiguousSurfaces: [{ surface: "彼", sceneRanges: [[1, 61]] }],
        }),
      ]),
    ],
    [
      "AMBIGUOUS_RANGE_OVERLAP",
      roster([
        entity(1, {
          ambiguousSurfaces: [{ surface: "彼", sceneRanges: [[1, 5]] }],
        }),
        entity(2, {
          ambiguousSurfaces: [{ surface: "彼", sceneRanges: [[5, 9]] }],
        }),
      ]),
    ],
    ["EVIDENCE_MISSING", roster([entity(1, { evidence: [] })])],
    [
      "EVIDENCE_SCENE_RANGE",
      roster([entity(1, { evidence: [{ scene: 61, paragraph: 1 }] })]),
    ],
    ["ENTITY_LINEAGE", roster([entity(1, { lineage: "C" })])],
    ["REVIEW_STATUS", roster([entity(1, { review: { status: "x" } })])],
  ];
  for (const [code, input] of cases) {
    const result = validateRoster(input);
    assert.ok(
      codes(result).includes(code),
      `${code} expected, got ${codes(result).join(",")}`,
    );
    assert.ok(
      findUnsafeStringsFree(result.errors),
      "errors must not contain surfaces",
    );
  }
  // 段落数の範囲（根拠の段落が存在しない）。
  const range = validateRoster(
    roster([entity(1, { evidence: [{ scene: 1, paragraph: 4 }] })]),
    {
      paragraphCounts: [3],
      sceneCount: 60,
    },
  );
  assert.ok(codes(range).includes("EVIDENCE_PARAGRAPH_RANGE"));
  // 場面が重ならない範囲の宣言は通る（場面で指す人が変わる表記）。
  const split = roster([
    entity(1, {
      ambiguousSurfaces: [{ surface: "彼", sceneRanges: [[1, 4]] }],
    }),
    entity(2, {
      ambiguousSurfaces: [{ surface: "彼", sceneRanges: [[5, 9]] }],
    }),
  ]);
  assert.deepEqual(validateRoster(split).errors, []);
});

function findUnsafeStringsFree(errors) {
  return errors.every((e) =>
    Object.values(e).every(
      (v) => v === null || /^[A-Za-z0-9_#.[\]$-]+$/u.test(String(v)),
    ),
  );
}

test("敬称の形：X＋接尾辞だけ。接尾辞だけの単独の表記は敬称付きの形ではない", () => {
  assert.equal(isHonorificForm("甲さん"), true);
  assert.equal(isHonorificForm("甲隊長"), true);
  assert.equal(isHonorificForm("隊長"), false);
  assert.equal(isHonorificForm("甲"), false);
});

test("衝突の検出：別名と別名（ambiguous）、名前と別名（name-over-alias）、宣言の有無", () => {
  const input = roster([
    entity(1, {
      name: "田中",
      aliases: [
        { surface: "先輩", level: "L3" },
        { surface: "共通", level: "L2" },
      ],
    }),
    entity(2, { name: "鈴木", aliases: [{ surface: "先輩", level: "L3" }] }),
    entity(3, { name: "共通", aliases: [] }),
    entity(4, { name: "山田", aliases: [{ surface: "共通", level: "L2" }] }),
  ]);
  const found = findCollisions(input);
  const byKey = Object.fromEntries(found.map((c) => [c.key, c]));
  assert.equal(byKey["先輩"].kind, "ambiguous");
  assert.deepEqual(
    byKey["先輩"].entityIds.sort(),
    [input.entities[0].id, input.entities[1].id].sort(),
  );
  // 「共通」は 3 の名前、1・4 の別名：名前の側（3）へ即 resolved。
  assert.equal(byKey["共通"].kind, "name-over-alias");
  assert.equal(byKey["共通"].resolvesTo, input.entities[2].id);
  assert.equal(byKey["共通"].entityIds.length, 3);
  assert.equal(byKey["先輩"].declared, false);
  // 名前どうしの衝突も ambiguous。
  const dupNames = roster([
    entity(1, { name: "同名" }),
    entity(2, { name: "同名" }),
  ]);
  assert.equal(findCollisions(dupNames)[0].kind, "ambiguous");
  // 衝突なし。
  assert.deepEqual(findCollisions(roster([entity(1), entity(2)])), []);
});

test("名簿の段：L0〜L3 と L2−1字", () => {
  const input = roster([
    entity(1, {
      aliases: [
        { surface: "表記ゆれ", level: "L1" },
        { surface: "名", level: "L2" },
        { surface: "愛称", level: "L2" },
        { surface: "関係呼称", level: "L3" },
      ],
    }),
  ]);
  const at = (level) => rosterAtLevel(input, level)[0].aliases;
  assert.deepEqual(at("L0"), []);
  assert.deepEqual(at("L1"), ["表記ゆれ"]);
  assert.deepEqual(at("L2"), ["表記ゆれ", "名", "愛称"]);
  assert.deepEqual(at("L3"), ["表記ゆれ", "名", "愛称", "関係呼称"]);
  assert.deepEqual(at("L2-1char"), ["表記ゆれ", "愛称"]);
  assert.throws(() => rosterAtLevel(input, "L9"));
});

test("Wilson の上側限界：0/10 は約 27.8％、0/8 は約 32.4％", () => {
  assert.ok(Math.abs(wilsonUpper(0, 10) - 0.2775) < 0.001);
  assert.ok(Math.abs(wilsonUpper(0, 8) - 0.3244) < 0.001);
  assert.throws(() => wilsonUpper(11, 10));
});

// ---- chunk --------------------------------------------------------------------

test("chunk：場面をまたがず、全場面を過不足なく 1 回ずつ含み、上限を守る", () => {
  const scenes = syntheticScenes(40, 3, 100); // 1 場面 約 350 字
  const chunks = chunkScenes(scenes, { maxChars: 3000 });
  const covered = chunks.flatMap((c) =>
    Array.from(
      { length: c.sceneTo - c.sceneFrom + 1 },
      (_, i) => c.sceneFrom + i,
    ),
  );
  assert.deepEqual(
    covered,
    scenes.map((s) => s.index),
  );
  for (const c of chunks) assert.ok(c.chars <= 3000 && !c.oversize);
  // 上限を超える 1 場面は、それだけで 1 chunk（oversize）。
  const big = [
    { index: 1, paragraphs: ["あ".repeat(50)] },
    { index: 2, paragraphs: ["い".repeat(500)] },
    { index: 3, paragraphs: ["う".repeat(50)] },
  ];
  const bigChunks = chunkScenes(big, { maxChars: 100 });
  assert.deepEqual(
    bigChunks.map((c) => [c.sceneFrom, c.sceneTo, c.oversize]),
    [
      [1, 1, false],
      [2, 2, true],
      [3, 3, false],
    ],
  );
});

test("chunk：A と B は内側の切れ目が 1 つも重ならない（半分ずらし）", () => {
  const scenes = syntheticScenes(60, 3, 100);
  const { A, B } = chunkPair(scenes, { maxChars: 4000 });
  assert.equal(sharedBoundaryCount(A, B), 0);
  assert.ok(interiorBoundaries(A).length >= 2);
  assert.ok(B[0].chars < A[0].chars);
});

test("chunk の本文：場面番号と段落番号がつく", () => {
  const scenes = syntheticScenes(3, 2, 5);
  const text = renderChunkText(scenes, { sceneFrom: 2, sceneTo: 3 });
  assert.match(text, /=== 場面 2 ===/u);
  assert.match(text, /\[3:2\] /u);
  assert.doesNotMatch(text, /場面 1 ===/u);
});

// ---- 突合 ----------------------------------------------------------------------

test("突合：一致・型・名前・別名・分割・only を区別し、一致は packet にしない", () => {
  const mk = (list) => roster(list, { lineage: "A" });
  const a = mk([
    entity(1, { name: "甲", aliases: [{ surface: "甲の別名", level: "L2" }] }),
    entity(2, { name: "乙" }),
    entity(3, { name: "丙", type: "location" }),
    entity(4, { name: "丁甲" }),
    entity(5, { name: "戊" }),
    entity(6, { name: "己", aliases: [{ surface: "己の別名", level: "L2" }] }),
  ]);
  const b = mk([
    entity(1, {
      name: "甲",
      aliases: [{ surface: "甲の別名", level: "L2" }],
      lineage: "B",
    }),
    entity(2, { name: "乙", type: "other", lineage: "B" }),
    entity(3, {
      name: "丙",
      type: "location",
      aliases: [{ surface: "丙の別名", level: "L1" }],
      lineage: "B",
    }),
    entity(4, { name: "丁甲", lineage: "B" }),
    entity(7, { name: "庚", lineage: "B" }),
    entity(8, {
      name: "己",
      aliases: [{ surface: "己の別名", level: "L2" }],
      lineage: "B",
    }),
    entity(9, { name: "己の別名", lineage: "B" }),
  ]);
  const { packets, summary } = diffRosters(a, b);
  const kindsOf = (side, id) =>
    packets.find((p) => p[`${side.toLowerCase()}Ids`].includes(id))?.kinds;
  assert.equal(kindsOf("A", a.entities[0].id), undefined); // 1：一致
  assert.deepEqual(kindsOf("A", a.entities[1].id), ["type"]); // 2：型
  assert.deepEqual(kindsOf("A", a.entities[2].id), ["aliases"]); // 3：別名
  assert.equal(kindsOf("A", a.entities[3].id), undefined); // 4：丁甲は一致（名前が同じ）
  assert.deepEqual(kindsOf("A", a.entities[4].id), ["only-A"]); // 5：A のみ
  assert.deepEqual(kindsOf("B", b.entities[4].id), ["only-B"]); // 庚：B のみ
  assert.deepEqual(kindsOf("A", a.entities[5].id), ["split-in-B"]); // 己：B で 2 つに分かれる
  assert.equal(summary.entitiesA, 6);
  assert.equal(summary.packetCount, packets.length);
  assert.equal(summary.agreed, 2);
  for (const p of packets) {
    assert.match(p.packetId, /^pk-g-ja-2-\d{3}$/u);
    assert.ok(p.scenesToRead.length > 0);
  }
  // 名前の違い（同じ実体の別の表記）：B の名前が A の別名にあれば同じ実体として結び、名前の違いを出す。
  const c = diffRosters(
    mk([
      entity(1, {
        name: "正式名",
        aliases: [{ surface: "通称", level: "L2" }],
      }),
    ]),
    mk([
      entity(1, {
        name: "通称",
        aliases: [{ surface: "正式名", level: "L2" }],
        lineage: "B",
      }),
    ]),
  );
  assert.deepEqual(c.packets[0].kinds, ["name"]);
});

// ---- 層別の選択 ----------------------------------------------------------------------

function bigRoster(n = 60) {
  const entities = Array.from({ length: n }, (_, i) =>
    entity(i + 1, {
      type: i % 7 === 0 ? "location" : "character",
      aliases: Array.from({ length: i % 6 }, (_, k) => ({
        surface: `別名${i + 1}-${k}`,
        level: "L2",
      })),
      ambiguousSurfaces:
        i % 11 === 0 ? [{ surface: `彼${i}`, sceneRanges: [[1, 2]] }] : [],
      packets:
        i % 5 === 0 ? [`pk-${WORK}-${String(i + 1).padStart(3, "0")}`] : [],
    }),
  );
  // 衝突を 2 組作る。
  entities[20].aliases.push({ surface: "共有A", level: "L3" });
  entities[21].aliases.push({ surface: "共有A", level: "L3" });
  entities[30].aliases.push({ surface: "共有B", level: "L3" });
  entities[31].aliases.push({ surface: "共有B", level: "L3" });
  return roster(entities);
}

test("層別の選択：同じ種で同じ行（決定性）、種が違えば別の行、乱数 10＋層別 14 以内", () => {
  const r = bigRoster();
  const a = selectReviewRows(r, { seed: "seed-1" });
  const b = selectReviewRows(r, { seed: "seed-1" });
  assert.deepEqual(a.rows, b.rows);
  const other = selectReviewRows(r, { seed: "seed-2" });
  assert.notDeepEqual(
    a.rows.map((x) => x.entityId),
    other.rows.map((x) => x.entityId),
  );
  assert.equal(a.mode, "sample");
  const groups = a.summary.groupCounts;
  assert.equal(groups.random, 10);
  const stratified = Object.entries(groups)
    .filter(([g]) => g !== "random")
    .reduce((acc, [, n]) => acc + n, 0);
  assert.ok(stratified <= 14 && stratified >= 10, `stratified=${stratified}`);
  assert.equal(groups["alias-top"], 3);
  assert.equal(groups.disagreement, 4);
  assert.equal(groups["ambiguous-surface"], 3);
  assert.equal(groups.collision, 2);
  assert.equal(groups.location, 2);
  // 同じ実体を 2 回出さない。行 ID は連番。
  assert.equal(new Set(a.rows.map((x) => x.entityId)).size, a.rows.length);
  assert.deepEqual(
    a.rows.map((x) => x.rowId),
    a.rows.map((_, i) => `row-${String(i + 1).padStart(2, "0")}`),
  );
  // 乱数の行は、層別を足しても変わらない（先に引く）：packets を消しても random の集合は同じ。
  const stripped = JSON.parse(JSON.stringify(r));
  for (const e of stripped.entities) e.packets = [];
  const c = selectReviewRows(stripped, { seed: "seed-1" });
  const randomIds = (x) =>
    x.rows
      .filter((row) => row.group === "random")
      .map((row) => row.entityId)
      .sort();
  assert.deepEqual(randomIds(a), randomIds(c));
});

test("層別の選択：足りない層は少なくなり、30 以下は全数（層・乱数なし）", () => {
  const plain = roster(Array.from({ length: 40 }, (_, i) => entity(i + 1)));
  const sel = selectReviewRows(plain, { seed: "s" });
  assert.equal(sel.summary.groupCounts.random, 10);
  assert.equal(sel.summary.groupCounts.disagreement ?? 0, 0);
  assert.equal(sel.rows.length <= 10 + 3, true);
  const small = roster(Array.from({ length: 30 }, (_, i) => entity(i + 1)));
  const all = selectReviewRows(small, { seed: "s" });
  assert.equal(all.mode, "full");
  assert.equal(all.rows.length, 30);
  assert.ok(all.rows.every((r) => r.group === "full"));
  assert.throws(() => selectReviewRows(small, { seed: "" }));
});

// ---- 作者の確認の表 -------------------------------------------------------------------

test("抜粋：表記の前後を切り出し、ルビは ruby 要素に、見つからなければ found=false", () => {
  const paragraph = `${"あ".repeat(60)}｜暁子《あきこ》が${"い".repeat(60)}`;
  const hit = excerptHtml(paragraph, ["暁子"], 40);
  assert.equal(hit.found, true);
  assert.match(hit.html, /<mark><ruby>暁子<rt>あきこ<\/rt><\/ruby><\/mark>/u);
  assert.ok(hit.html.startsWith("…") && hit.html.endsWith("…"));
  assert.equal(
    [...hit.html.replace(/<[^>]+>/gu, "")].length <= 40 * 2 + 2 + 2 + 4,
    true,
  );
  assert.equal(excerptHtml("無関係な文", ["暁子"]).found, false);
  // HTML を壊す文字は escape する。
  assert.match(excerptHtml("<b>暁子</b>&", ["暁子"]).html, /&#60;b&#62;/u);
});

test("確認の表：A と B の一致の印・層・実体 ID・系統は HTML に出ない。応答の選択欄は固定語彙", () => {
  const r = bigRoster();
  const sel = selectReviewRows(r, { seed: "seed-1" });
  const scenes = syntheticScenes(60, 3, 20);
  const html = renderReviewHtml({
    roster: r,
    scenes,
    rows: sel.rows,
    sheetId: "sheet-test",
  });
  assert.doesNotThrow(() =>
    assertSheetHidesMarks(html, { roster: r, rows: sel.rows }),
  );
  for (const e of r.entities) assert.equal(html.includes(e.id), false);
  for (const token of [
    "disagreed",
    "agreed",
    "random",
    "alias-top",
    "adjudicated",
    "pk-g-ja-2",
  ])
    assert.equal(html.includes(token), false, token);
  for (const verdict of REVIEW_VERDICTS)
    assert.ok(html.includes(`value="${verdict}"`));
  assert.equal(
    (html.match(/<section class="row"/gu) ?? []).length,
    sel.rows.length,
  );
  assert.match(html, /^<!doctype html>/u);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|https?:\/\//u); // 自己完結
  // 隠すべき印が混じった HTML は検査で落ちる。
  assert.throws(
    () =>
      assertSheetHidesMarks(`${html} ${r.entities[0].id}`, {
        roster: r,
        rows: sel.rows,
      }),
    /SHEET_LEAKS_HIDDEN_MARKS/u,
  );
});

// ---- 応答の取り込み -----------------------------------------------------------------

function sampleKey(rosterInput, rows) {
  return {
    schemaVersion: "identity-review-key/1",
    work: WORK,
    sheetId: "s",
    mode: "sample",
    rows,
  };
}
const keyRow = (n, group, agreement = "agreed") => ({
  rowId: `row-0${n}`,
  entityId: `rt-${WORK}-00${n}`,
  group,
  agreement,
});

test("応答の取り込み：直しを反映し、確認しなかった行は未確認、結果の要約は件数だけ", () => {
  const input = roster([
    entity(1, {
      aliases: [
        { surface: "外す別名", level: "L2" },
        { surface: "残す別名", level: "L1" },
      ],
    }),
    entity(2, {
      name: "誤った名前",
      aliases: [{ surface: "新しい名前", level: "L1" }],
    }),
    entity(3),
    entity(4),
    entity(5),
    entity(6),
  ]);
  const key = sampleKey(input, [
    keyRow(1, "random"),
    keyRow(2, "random"),
    keyRow(3, "random"),
    keyRow(4, "disagreement", "disagreed"),
    keyRow(5, "location"),
  ]);
  const responses = {
    schemaVersion: "identity-review-responses/1",
    work: WORK,
    responses: [
      {
        rowId: "row-01",
        verdict: "別名を外す",
        aliasesToRemove: ["外す別名"],
        note: "",
      },
      { rowId: "row-02", verdict: "名前を直す", newName: "新しい名前" },
      {
        rowId: "row-03",
        verdict: "別名を足す",
        aliasesToAdd: ["足す別名", "名前3さん", "名前3"],
        addLevel: "L3",
      },
      { rowId: "row-04", verdict: "分けるべき", note: "二人いる" },
      { rowId: "row-05", verdict: "そのまま" },
    ],
  };
  const {
    roster: out,
    summary,
    validation,
  } = ingestReview({ roster: input, key, responses });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const byId = Object.fromEntries(out.entities.map((e) => [e.id, e]));
  assert.deepEqual(
    byId[`rt-${WORK}-001`].aliases.map((a) => a.surface),
    ["残す別名"],
  );
  assert.equal(byId[`rt-${WORK}-001`].review.status, "edited");
  assert.equal(byId[`rt-${WORK}-002`].name, "新しい名前");
  assert.deepEqual(byId[`rt-${WORK}-002`].aliases, []); // 新しい名前が別名にあれば外す
  assert.deepEqual(byId[`rt-${WORK}-003`].aliases, [
    { surface: "足す別名", level: "L3" },
  ]);
  assert.deepEqual(byId[`rt-${WORK}-003`].honorificSurfaces, ["名前3さん"]); // 敬称付きの形は対応表へ
  assert.equal(byId[`rt-${WORK}-004`].review.status, "flagged");
  assert.equal(byId[`rt-${WORK}-005`].review.status, "confirmed");
  assert.equal(byId[`rt-${WORK}-006`].review.status, "unconfirmed");
  assert.equal(summary.unconfirmed, 1);
  assert.equal(summary.flagged, 1);
  assert.equal(summary.edits.aliasAddSkipped, 1);
  assert.equal(summary.random.rows, 3);
  assert.equal(summary.random.errors, 3);
  assert.equal(summary.byAgreement.disagreed.errors, 1);
  assert.ok(findUnsafeFree(summary));
  // 入力の名簿は変えない。
  assert.equal(input.entities[0].aliases.length, 2);
  // 不正な応答は止まる。
  assert.throws(
    () =>
      ingestReview({
        roster: input,
        key,
        responses: {
          ...responses,
          responses: [{ rowId: "row-99", verdict: "そのまま" }],
        },
      }),
    /RESPONSE_ROW_UNKNOWN/u,
  );
  assert.throws(
    () =>
      ingestReview({
        roster: input,
        key,
        responses: {
          ...responses,
          responses: [{ rowId: "row-01", verdict: "ちがう語" }],
        },
      }),
    /RESPONSE_VERDICT/u,
  );
  assert.throws(
    () =>
      ingestReview({
        roster: input,
        key,
        responses: {
          ...responses,
          responses: [
            { rowId: "row-01", verdict: "そのまま" },
            { rowId: "row-01", verdict: "そのまま" },
          ],
        },
      }),
    /RESPONSE_ROW_DUPLICATE/u,
  );
});

function findUnsafeFree(summary) {
  return /^[\x20-\x7e]*$/u.test(JSON.stringify(summary));
}

test("確認しない作品：全行を未確認にして確定する", () => {
  const { roster: out, validation } = finalizeUnreviewed(
    roster([entity(1), entity(2)]),
  );
  assert.equal(validation.ok, true);
  assert.ok(out.entities.every((e) => e.review.status === "unconfirmed"));
  assert.equal(out.reviewSummary.mode, "unreviewed");
});

// ---- 出力の混入検査 ----------------------------------------------------------------

test("出力の混入検査：名簿の表記を標準出力に出す要約は落ち、ID・件数だけなら通る", () => {
  const scenes = syntheticScenes(5, 2, 30);
  const texts = scenes.map((s) => expectedSceneText(s.paragraphs));
  assert.doesNotThrow(() =>
    assertOutputClean(
      { work: WORK, entityCount: 3, ids: [`rt-${WORK}-001`] },
      texts,
    ),
  );
  assert.throws(() => assertOutputClean({ name: "名前1" }, texts), /unclean/u);
});

// ---- 実際の 4 作品の chunk（存在すれば）--------------------------------------------------

test(
  "4 作品の chunk：場面をまたがず、A と B の切れ目が重ならない（原稿があれば）",
  {
    skip:
      !existsSync(resolveWorkSource("g-ja-2")) ||
      !existsSync(resolveWorkSource("m-ja-2")),
  },
  () => {
    for (const key of Object.keys(WORKS)) {
      const scenes = scenesFromWork(
        JSON.parse(readFileSync(resolveWorkSource(key), "utf8")),
      );
      assert.equal(scenes.length, WORKS[key]);
      const { A, B } = chunkPair(scenes);
      assert.equal(sharedBoundaryCount(A, B), 0);
      for (const chunks of [A, B]) {
        assert.equal(
          chunks.reduce((acc, c) => acc + (c.sceneTo - c.sceneFrom + 1), 0),
          scenes.length,
        );
        assert.ok(chunks.every((c) => c.chars <= 45000 && !c.oversize));
      }
    }
  },
);

test("CLI：chunks の要約に原稿が混ざらず、書いた dir・file は 0700・0600（合成の原稿）", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "idl-roster-"));
  try {
    const dataDir = path.join(base, "data");
    const out = path.join(base, "out");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const scenes = syntheticScenes(60, 3, 100).map((s) => ({
      index: s.index,
      size: 0,
      paragraphs: s.paragraphs,
    }));
    writeFileSync(
      path.join(dataDir, "g-ja-3.json"),
      JSON.stringify({ scenes }),
    );
    const summary = runCommand("chunks", {
      work: "g-ja-3",
      root: out,
      "data-dir": dataDir,
    });
    assert.ok(summary.chunks.A.length >= 1 && summary.chunks.B.length >= 1);
    assert.doesNotThrow(() =>
      assertOutputClean(
        summary,
        scenes.map((s) => expectedSceneText(s.paragraphs)),
      ),
    );
    const file = path.join(out, "roster", "g-ja-3", "chunks-A", "chunk-01.txt");
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.equal(statSync(path.join(out, "roster", "g-ja-3")).mode & 0o077, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
