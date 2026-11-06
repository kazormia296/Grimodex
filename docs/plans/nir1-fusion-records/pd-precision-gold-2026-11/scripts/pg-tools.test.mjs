// render-annotation-sheet.mjs・annotate-ai.mjs の試験。合成の Scene だけを使い（本文は実在しない文字列）、
// 通信しない（fetch は偽物）。実行：node --test pg-tools.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAnnotationFiles,
  buildMessages,
  loadState,
  parseLabel,
  pairsOf,
  readPrivacyRecord,
  requestBody,
  runAnnotation,
  sendScope,
} from "./annotate-ai.mjs";
import { aggregate } from "./agg-pg.mjs";
import { ingestSheet, planSheet, renderSheet } from "./render-annotation-sheet.mjs";
import { assertOutsideRepo, loadPrompt } from "./pg-common.mjs";

const cand = (w, q, p, origin, rank) => ({ position: p, rank, origin, pairId: `${w}|${q}|${p}` });
const selection = {
  seed: "fx",
  queries: [
    { work: "wk-zz", queryPosition: 5, rawCount: 8, stratum: "full-le30", probeStatus: "available",
      candidates: [cand("wk-zz", 5, 1, "ir", 1), cand("wk-zz", 5, 2, "raw", 6), cand("wk-zz", 5, 3, "raw", 7)] },
    { work: "wk-zz", queryPosition: 6, rawCount: 2, stratum: "short-le30", probeStatus: "available",
      candidates: [cand("wk-zz", 6, 1, "ir", 1), cand("wk-zz", 6, 4, "ir", 2)] },
  ],
};
const mkScene = (i) => ({ index: i, size: 10, paragraphs: [`本文${i}A`, `本文${i}B`] });
const scenes = { "wk-zz": { sha256: "s", byPosition: new Map([1, 2, 3, 4, 5, 6].map((i) => [i, mkScene(i)])) } };
const prompt = loadPrompt();

test("prompt：criteria と system が取れ、標識の行を含まず、sha256 が出る", () => {
  assert.match(prompt.criteria, /見たいか/u);
  assert.match(prompt.criteria, /\(a\)[\s\S]*\(f\)/u);
  assert.ok(!prompt.system.includes("<!--"));
  assert.match(prompt.system, /\{"label":"strict"\}/u);
  assert.match(prompt.fileSha256, /^[0-9a-f]{64}$/u);
  assert.match(prompt.systemSha256, /^[0-9a-f]{64}$/u);
});

test("sheet：順序は seed で決定的、作品・位置・由来・順位を表示しない、取り込みで往復する", () => {
  const plan = planSheet(selection);
  assert.deepEqual(plan, planSheet(selection));
  assert.equal(plan.reduce((a, q) => a + q.candidates.length, 0), 5);
  const sheet = renderSheet({ selection, scenes, annotator: "user", plan, prompt });
  for (const hidden of ["wk-zz", "raw", "rank", "origin"]) assert.ok(!sheet.includes(hidden), hidden);
  assert.match(sheet, /> 本文5A/u);
  // 記入して取り込む（全件）
  const answers = ["s", "p", "n", "strict", "0"];
  let k = 0;
  const filled = sheet.replace(/^判定:$/gmu, () => `判定: ${answers[k++]}`);
  const key = { selectionSha256: "x", queries: plan };
  const ann = ingestSheet(filled, key, { annotator: "user" });
  assert.equal(ann.labels.length, 5);
  assert.deepEqual(ann.labels.map((l) => l.label).sort(), ["none", "none", "partial", "strict", "strict"]);
  // 未記入は拒否（--allow-partial なら通る）、不正な値は拒否
  assert.throws(() => ingestSheet(sheet, key, { annotator: "user" }), /未記入/u);
  assert.equal(ingestSheet(sheet, key, { annotator: "user", allowPartial: true }).labels.length, 0);
  assert.throws(() => ingestSheet(sheet.replace(/^判定:$/mu, "判定: ?"), key, { annotator: "user" }), /不正/u);
  // 取り込んだ注釈は aggregate がそのまま読める
  const out = aggregate({ selection, selectionSha256: "x", annotations: { user: ann } });
  assert.equal(out.coverage.user.labeled, 5);
});

test("repo の内側の path は拒否する", () => {
  assert.throws(() => assertOutsideRepo(path.join(import.meta.dirname, "x.md")), /repo の外/u);
  assertOutsideRepo(path.join(os.tmpdir(), "x.md"));
});

test("AI 注釈：messages・要求・label の解析", () => {
  const m = buildMessages("SYS", "今", "候補");
  assert.equal(m[0].content, "SYS");
  assert.match(m[1].content, /^<current_scene>\n今\n<\/current_scene>\n\n<candidate_scene>\n候補\n<\/candidate_scene>$/u);
  const body = requestBody("openai/gpt-6-luna", m);
  assert.equal(body.model, "openai/gpt-6-luna");
  assert.deepEqual(body.provider, { data_collection: "deny" });
  assert.equal(parseLabel('{"label":"strict"}'), "strict");
  assert.equal(parseLabel('前置き {"label": "none"} 後'), "none");
  assert.equal(parseLabel('{"label":"maybe"}'), null);
  assert.equal(parseLabel("strict"), null);
  assert.equal(parseLabel(undefined), null);
});

test("AI 注釈：送信範囲の要約は本文を含まず、件数・文字数が合う", () => {
  const scope = sendScope({ selection, scenes, prompt, model: "m", repeats: 2 });
  assert.equal(scope.pairs, 5);
  assert.equal(scope.calls, 10);
  assert.equal(scope.sceneBodiesSent, 20);
  const bodyLen = (i) => mkScene(i).paragraphs.join("\n\n").length;
  const expected = 2 * (3 * bodyLen(5) + 2 * bodyLen(6) + bodyLen(1) + bodyLen(2) + bodyLen(3) + bodyLen(1) + bodyLen(4));
  assert.equal(scope.sceneBodyChars, expected);
  assert.ok(!JSON.stringify(scope).includes("本文"));
  assert.equal(scope.endpoint, "https://openrouter.ai/api/v1/chat/completions");
});

test("AI 注釈：偽の fetch で 2 回分を取り、state・注釈 file に応答の本文も key も残らない", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-test-"));
  try {
    const stateFile = path.join(dir, "state.jsonl");
    const SECRET = "sk-or-v1-" + "x".repeat(40);
    let calls = 0;
    let sawAuth = null;
    const fetchImpl = async (url, init) => {
      calls += 1;
      sawAuth = init.headers.Authorization;
      const labels = ["strict", "partial", "none"];
      return {
        ok: true,
        json: async () => ({
          model: "openai/gpt-6-luna-x",
          provider: "P",
          choices: [{ message: { content: `{"label":"${labels[calls % 3]}"} これは応答の本文` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
        }),
      };
    };
    await runAnnotation({ selection, scenes, prompt, model: "openai/gpt-6-luna", repeats: 2, concurrency: 2, key: SECRET, stateFile, fetchImpl });
    assert.equal(calls, 10);
    assert.equal(sawAuth, `Bearer ${SECRET}`);
    const state = fs.readFileSync(stateFile, "utf8");
    assert.ok(!state.includes(SECRET) && !state.includes("応答の本文"));
    // 再実行は完了済みを送り直さない（再開）。
    await runAnnotation({ selection, scenes, prompt, model: "m", repeats: 2, concurrency: 2, key: SECRET, stateFile, fetchImpl });
    assert.equal(calls, 10);
    assert.equal(loadState(stateFile).done.size, 10);
    const files = buildAnnotationFiles({
      selection, selectionSha256: "x", stateFile, repeats: 2, prompt, model: "openai/gpt-6-luna",
      privacy: { sha256: "p", checkedAt: "2026-11-06T00:00:00Z" },
    });
    assert.deepEqual(files.map((f) => [f.name, f.missing, f.body.labels.length]), [["ai", 0, 5], ["ai2", 0, 5]]);
    assert.equal(files[0].body.meta.promptFileSha256, prompt.fileSha256);
    assert.ok(!JSON.stringify(files).includes(SECRET));
    assert.equal(pairsOf(selection).length, 5);
    const out = aggregate({
      selection, selectionSha256: "x",
      annotations: { user: files[0].body, ai: files[0].body, ai2: files[1].body },
    });
    assert.equal(out.kappa.userVsAi.strict.kappa, 1);
    assert.ok(out.kappa.aiVsAi2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("§8 の確認の記録：欠けた項目と key らしい値は拒否", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-test-"));
  try {
    const write = (o) => {
      const f = path.join(dir, `p${Math.random()}.json`);
      fs.writeFileSync(f, JSON.stringify(o));
      return f;
    };
    const ok = { checkedAt: "2026-11-06T00:00:00Z", accountSetting: "a", providerTerms: "b", checkedBy: "c" };
    assert.equal(readPrivacyRecord(write(ok)).record.checkedBy, "c");
    assert.throws(() => readPrivacyRecord(write({ ...ok, providerTerms: "" })), /providerTerms/u);
    assert.throws(() => readPrivacyRecord(write({ ...ok, accountSetting: "sk-or-v1-aaaa" })), /key/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
