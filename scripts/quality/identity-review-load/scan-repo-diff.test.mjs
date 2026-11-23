// 混入走査（scan-repo-diff.mjs）の表記の集め方の試験（DR-ILM の追記）。
// 判定欄（key が verdict）の閉じた語彙だけを外し、それ以外は外さない（fail-closed）ことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_VERDICTS } from "./lib.mjs";
import { collectRosterSurfaces, scanText } from "./scan-repo-diff.mjs";

const collect = (value) => {
  const surfaces = new Set();
  collectRosterSurfaces(value, surfaces);
  return surfaces;
};

test("判定欄（verdict）にある閉じた語彙の値は、表記として集めない", () => {
  const surfaces = collect({
    entities: [
      {
        name: "合成の名前",
        review: { verdict: REVIEW_VERDICTS[0] },
      },
    ],
  });
  for (const verdict of REVIEW_VERDICTS)
    assert.ok(!surfaces.has(verdict), `判定の語を表記に数えた: ${verdict}`);
  assert.ok(surfaces.has("合成の名前"), "名前は集める");
});

test("別の欄にある同じ語は、外さずに集める（判定欄だけが例外）", () => {
  for (const word of REVIEW_VERDICTS.filter((w) => w.length >= 2)) {
    const surfaces = collect({ entities: [{ name: word }] });
    assert.ok(surfaces.has(word), `名前の欄の同じ語を外した: ${word}`);
  }
  const alias = collect({ entities: [{ aliases: [{ surface: "名前を直す" }] }] });
  assert.ok(alias.has("名前を直す"), "別名の欄の同じ語は集める");
});

test("判定欄でも、閉じた語彙に無い値は外さずに集める（fail-closed）", () => {
  const surfaces = collect({
    entities: [{ review: { verdict: "語彙に無い合成の判定" } }],
  });
  assert.ok(surfaces.has("語彙に無い合成の判定"));
});

test("判定欄の配列の中でも同じ扱い（語彙の値は外し、語彙外は集める）", () => {
  const surfaces = collect({
    rows: [{ verdict: [REVIEW_VERDICTS[1], "語彙に無い合成の判定"] }],
  });
  assert.ok(!surfaces.has(REVIEW_VERDICTS[1]));
  assert.ok(surfaces.has("語彙に無い合成の判定"));
});

test("非 ASCII を含まない文字列と 1 字の文字列は、従来どおり集めない", () => {
  const surfaces = collect({ a: "ascii only", b: "あ", c: ["xy"] });
  assert.equal(surfaces.size, 0);
});

test("走査との組合せ：語彙の語を含む道具のコードの行は当たらず、名前の欄にある語は当たる", () => {
  const verdictWord = REVIEW_VERDICTS.find((w) => w.length >= 4);
  assert.ok(verdictWord, "4 字以上の判定の語が要る");
  const text = `// 判定の語 ${verdictWord} を持つ行`;
  const empty = new Set();
  const material = (surfaces) => ({
    shingles: new Set(),
    surfaces,
    hashes: new Set(),
  });
  const withoutVerdict = collect({ entities: [{ review: { verdict: verdictWord } }] });
  assert.equal(scanText(text, material(withoutVerdict)).surfaceHits, 0);
  const asName = collect({ entities: [{ name: verdictWord }] });
  assert.ok(scanText(text, material(asName)).surfaceHits >= 1);
  assert.equal(empty.size, 0);
});
