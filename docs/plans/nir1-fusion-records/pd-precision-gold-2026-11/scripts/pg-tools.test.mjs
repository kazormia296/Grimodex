// render-annotation-sheet.mjs・annotate-ai.mjs の試験。合成の Scene だけを使い（本文は実在しない文字列）、
// 通信しない（fetch は偽物）。実行：node --test pg-tools.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ENDPOINT,
  PRICING_URL,
  assumedPricing,
  buildAnnotationFiles,
  buildMessages,
  errorKind,
  fetchPricing,
  loadState,
  parseLabel,
  pairsOf,
  readPrivacyRecord,
  requestBody,
  runAnnotation,
  sendScope,
  writeAnnotationFile,
} from "./annotate-ai.mjs";
import { aggregate } from "./agg-pg.mjs";
import { anonId, excludedQueries, ingestSheet, planSheet, renderSheet } from "./render-annotation-sheet.mjs";
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
  for (const hidden of ["wk-zz", "raw", "rank", "origin", "IR", "由来", "順位", "作品"]) assert.ok(!sheet.includes(hidden), hidden);
  assert.match(sheet, /> 本文5A/u);
  // 本文は重複して出さない：Scene 1 は 2 回出る（query 5 と 6 の候補）。2 回目は参照だけ
  assert.equal((sheet.match(/> 本文1A/gu) ?? []).length, 1);
  assert.equal((sheet.match(/^→ ID [0-9a-f]{6}（既出：Q\d+(-C\d+)?）$/gmu) ?? []).length, 1);
  assert.match(sheet, /selection の file と sheet-key\.json を開かない/u);
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

const SECRET = "sk-or-v1-" + "x".repeat(40);
const okResponse = (label = "strict", extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    model: "openai/gpt-6-luna-x",
    provider: "P",
    choices: [{ message: { content: `{"label":"${label}"} これは応答の本文` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
    ...extra,
  }),
});
const httpError = (status) => ({ ok: false, status, text: async () => "エラーの本文SECRETBODY", json: async () => ({}) });
const withTmp = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const baseRun = (stateFile, fetchImpl, extra = {}) =>
  runAnnotation({ selection, scenes, prompt, model: "openai/gpt-6-luna", repeats: 2, concurrency: 2, key: SECRET, stateFile, fetchImpl, retryBaseMs: 0, ...extra });
// 候補の本文（本文{i}A）から、その呼出しがどの組かを見分ける（試験用）
const candidateOf = (init) => JSON.parse(init.body).messages[1].content.match(/<candidate_scene>\n本文(\d)A/u)[1];

test("AI 注釈：偽の fetch で 2 回分を取り、要求の形・送信先・state・注釈 file に本文も key も残らない", async () => {
  await withTmp(async (dir) => {
    const stateFile = path.join(dir, "state.jsonl");
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      return okResponse(["strict", "partial", "none"][seen.length % 3]);
    };
    await baseRun(stateFile, fetchImpl);
    assert.equal(seen.length, 10);
    for (const { url, init } of seen) {
      // 送信先と header
      assert.equal(url, ENDPOINT);
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
      assert.deepEqual(Object.keys(init.headers).sort(), ["Authorization", "Content-Type", "HTTP-Referer", "X-Title"]);
      assert.ok(init.signal instanceof AbortSignal, "timeout の signal が付く");
      // body の key と値
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "provider"]);
      assert.equal(body.model, "openai/gpt-6-luna");
      assert.equal(body.max_tokens, 4096);
      assert.deepEqual(body.provider, { data_collection: "deny" });
      assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
      assert.equal(body.messages[0].content, prompt.system);
      assert.match(body.messages[1].content, /^<current_scene>\n本文\d[AB\n]*[\s\S]*<\/current_scene>\n\n<candidate_scene>\n[\s\S]*\n<\/candidate_scene>$/u);
      // 作品 key・位置・pairId・label の手掛かりは本文以外に載らない
      for (const leak of ["wk-zz", "wk-zz|", "queryPosition", "candidatePosition", "pairId", "origin", "rank", "stratum", "raw", SECRET]) {
        assert.ok(!init.body.includes(leak), `送信に ${leak} が入っている`);
      }
      for (const p of pairsOf(selection)) assert.ok(!init.body.includes(p.pairId));
    }
    const state = fs.readFileSync(stateFile, "utf8");
    assert.ok(!state.includes(SECRET) && !state.includes("応答の本文") && !state.includes("本文1"));
    // 再実行は完了済みを送り直さない（再開）。
    await baseRun(stateFile, fetchImpl, { model: "m" });
    assert.equal(seen.length, 10);
    assert.equal(loadState(stateFile).done.size, 10);
    const files = buildAnnotationFiles({
      selection, selectionSha256: "x", stateFile, repeats: 2, prompt, model: "openai/gpt-6-luna",
      privacy: { sha256: "p", checkedAt: "2026-11-06T00:00:00Z" },
    });
    assert.deepEqual(files.map((f) => [f.name, f.missing, f.body.labels.length]), [["ai", 0, 5], ["ai2", 0, 5]]);
    assert.equal(files[0].body.meta.complete, true);
    assert.equal(files[0].body.meta.promptFileSha256, prompt.fileSha256);
    assert.ok(!JSON.stringify(files).includes(SECRET));
    assert.equal(pairsOf(selection).length, 5);
    const out = aggregate({
      selection, selectionSha256: "x",
      annotations: { user: files[0].body, ai: files[0].body, ai2: files[1].body },
    });
    assert.equal(out.kappa.userVsAi.strict.kappa, 1);
    assert.ok(out.kappa.aiVsAi2);
  });
});

test("失敗：4xx は本文なしで state に記録され、他の組は続き、再開は最大の試行回数で止まる", async () => {
  await withTmp(async (dir) => {
    const stateFile = path.join(dir, "state.jsonl");
    let badCalls = 0;
    const fetchImpl = async (url, init) => {
      if (candidateOf(init) === "4") {
        badCalls += 1;
        return httpError(400);
      }
      return okResponse("strict");
    };
    const summary = await baseRun(stateFile, fetchImpl, { repeats: 1 });
    assert.equal(summary.labeled, 4); // process は落ちず、他の 4 組は取れる
    assert.equal(summary.failed, 1);
    assert.equal(badCalls, 1); // 恒常的な 4xx はその run では 1 回で止める
    const text = fs.readFileSync(stateFile, "utf8");
    assert.ok(!text.includes("SECRETBODY") && !text.includes("エラーの本文") && !text.includes(SECRET));
    const failed = loadState(stateFile).entries.filter((e) => e.phase === "failed");
    assert.deepEqual(failed.map((e) => [e.status, e.errorKind, e.attempt]), [[400, "http", 1]]);
    assert.ok(failed[0].pairId);
    // 欠けがあっても注釈 file は作れ、missing が記録され、aggregate が読める
    const mk = () => buildAnnotationFiles({
      selection, selectionSha256: "x", stateFile, repeats: 1, prompt, model: "m", privacy: { sha256: "p", checkedAt: "2026-11-06T00:00:00Z" },
    });
    const [f1] = mk();
    assert.equal(f1.missing, 1);
    assert.equal(f1.body.meta.complete, false);
    assert.equal(f1.body.meta.missing, 1);
    assert.deepEqual(f1.body.meta.attempts, { sent: 5, failed: 1, interrupted: 0 });
    const outDir = path.join(dir, "out");
    fs.mkdirSync(outDir);
    const written = writeAnnotationFile(outDir, f1);
    assert.equal(JSON.parse(fs.readFileSync(written, "utf8")).labels.length, 4);
    const agg = aggregate({ selection, selectionSha256: "x", annotations: { user: f1.body, ai: JSON.parse(fs.readFileSync(written, "utf8")) } });
    assert.equal(agg.coverage.ai.labeled, 4);
    // 再開：2 回目・3 回目だけ送り直し、4 回目は送らない（同じ組を無制限に送らない）
    await baseRun(stateFile, fetchImpl, { repeats: 1 });
    await baseRun(stateFile, fetchImpl, { repeats: 1 });
    assert.equal(badCalls, 3);
    const again = await baseRun(stateFile, fetchImpl, { repeats: 1 });
    assert.equal(badCalls, 3);
    assert.equal(again.exhausted, 1);
    assert.equal(again.scheduled, 0);
    // 後から取れるようになった場合でなくても、未完了の file は上書きでき、完了済みの file は上書きしない
    writeAnnotationFile(outDir, mk()[0]);
    const complete = { ...f1, body: { ...f1.body, meta: { ...f1.body.meta, complete: true, missing: 0 } } };
    writeAnnotationFile(outDir, complete);
    assert.throws(() => writeAnnotationFile(outDir, f1), /完了済み/u);
  });
});

test("失敗：fetch の例外は種類だけを記録し（message は残さない）、同じ組を最大 3 試行で止める", async () => {
  await withTmp(async (dir) => {
    const stateFile = path.join(dir, "state.jsonl");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      const error = new TypeError(`fetch failed: ${ENDPOINT} Bearer ${SECRET}`);
      error.cause = { code: "ECONNRESET", message: SECRET };
      throw error;
    };
    const summary = await baseRun(stateFile, fetchImpl, { repeats: 1 });
    assert.equal(calls, 15); // 5 組 × 3 試行
    assert.equal(summary.labeled, 0);
    const text = fs.readFileSync(stateFile, "utf8");
    assert.ok(!text.includes(SECRET) && !text.includes("fetch failed") && !text.includes("openrouter"));
    const failed = loadState(stateFile).entries.filter((e) => e.phase === "failed");
    assert.equal(failed.length, 15);
    assert.ok(failed.every((e) => e.errorKind === "TypeError:ECONNRESET" && e.status === null));
    // 再開しても送り直さない
    await baseRun(stateFile, fetchImpl, { repeats: 1 });
    assert.equal(calls, 15);
    // 全部欠けでも注釈 file は作れる（labels が空）
    const [f] = buildAnnotationFiles({ selection, selectionSha256: "x", stateFile, repeats: 1, prompt, model: "m", privacy: null });
    assert.equal(f.missing, 5);
    assert.deepEqual(f.body.labels, []);
  });
});

test("失敗：timeout は AbortSignal で中断され、TimeoutError として記録される", async () => {
  await withTmp(async (dir) => {
    const stateFile = path.join(dir, "state.jsonl");
    const fetchImpl = (url, init) =>
      new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const summary = await baseRun(stateFile, fetchImpl, { repeats: 1, timeoutMs: 15, concurrency: 5 });
    assert.equal(summary.labeled, 0);
    const failed = loadState(stateFile).entries.filter((e) => e.phase === "failed");
    assert.equal(failed.length, 15);
    assert.ok(failed.every((e) => e.errorKind === "TimeoutError"));
  });
});

test("失敗：5xx は 1 試行の中で再送し、認証の失敗（401）は run を止めて試行に数えない", async () => {
  await withTmp(async (dir) => {
    const stateFile = path.join(dir, "state.jsonl");
    let calls = 0;
    const flaky = async () => (++calls % 2 === 0 ? okResponse("none") : httpError(503));
    await baseRun(stateFile, flaky, { repeats: 1 });
    assert.equal(loadState(stateFile).done.size, 5);
    const stateAuth = path.join(dir, "auth.jsonl");
    let authCalls = 0;
    const denied = async () => {
      authCalls += 1;
      return httpError(401);
    };
    const summary = await baseRun(stateAuth, denied, { repeats: 1, concurrency: 1 });
    assert.equal(summary.halted, "HTTP 401");
    assert.equal(authCalls, 1); // 以降は送らない
    const { attempts } = loadState(stateAuth);
    assert.ok([...attempts.values()].every((n) => n === 0)); // key を直せば同じ組を最初から送れる
  });
});

test("再開：送信中に落ちた組（sending だけ残る）も試行に数え、無制限に送り直さない", async () => {
  await withTmp(async (dir) => {
    const stateFile = path.join(dir, "state.jsonl");
    const [first] = pairsOf(selection);
    fs.writeFileSync(stateFile, [1, 2, 3].map((attempt) => JSON.stringify({ pairId: first.pairId, repeat: 1, phase: "sending", attempt })).join("\n") + "\n");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return okResponse("strict");
    };
    const summary = await baseRun(stateFile, fetchImpl, { repeats: 1 });
    assert.equal(calls, 4); // 残り 4 組だけ
    assert.equal(summary.exhausted, 1);
    const [f] = buildAnnotationFiles({ selection, selectionSha256: "x", stateFile, repeats: 1, prompt, model: "m", privacy: null });
    assert.equal(f.missing, 1);
    assert.equal(f.body.meta.attempts.interrupted, 3);
  });
});

test("errorKind：message は使わず、名前と code だけ", () => {
  assert.equal(errorKind(new TypeError("secret")), "TypeError");
  assert.equal(errorKind({ name: "x y z" }), "Error");
  assert.equal(errorKind(null), "Error");
});

test("単価：公開 API の応答から取り（endpoint 間の最小・最大）、取れなければ仮定値（未確認）", async () => {
  const body = { data: { endpoints: [
    { pricing: { prompt: "0.00000005", completion: "0.00000025" } },
    { pricing: { prompt: "0.0000002", completion: "0.000001" } },
  ] } };
  const calls = [];
  const ok = await fetchPricing(async (url, init) => {
    calls.push([url, init.method, init.headers, init.body]);
    return { ok: true, status: 200, json: async () => body };
  });
  assert.deepEqual(calls.map((c) => [c[0], c[1], c[2], c[3]]), [[PRICING_URL, "GET", undefined, undefined]]); // key も本文も送らない
  assert.equal(ok.confirmed, true);
  assert.ok(Math.abs(ok.inputUsdPerMillion.min - 0.05) < 1e-9 && Math.abs(ok.inputUsdPerMillion.max - 0.2) < 1e-9);
  assert.ok(Math.abs(ok.outputUsdPerMillion.max - 1) < 1e-9);
  for (const bad of [
    async () => ({ ok: false, status: 500 }),
    async () => { throw new TypeError("x"); },
    async () => ({ ok: true, status: 200, json: async () => ({ data: { endpoints: [{ pricing: { prompt: "x" } }] } }) }),
  ]) {
    const fallback = await fetchPricing(bad);
    assert.equal(fallback.confirmed, false);
    assert.equal(fallback.source, "assumed");
  }
  // 見積りは単価・推論 token・上限を反映し、確認済みかを明示する
  const sure = sendScope({ selection, scenes, prompt, model: "m", repeats: 2, pricing: ok });
  const assumed = sendScope({ selection, scenes, prompt, model: "m", repeats: 2, pricing: assumedPricing() });
  assert.equal(sure.estimate.priceConfirmed, true);
  assert.equal(assumed.estimate.priceConfirmed, false);
  assert.match(assumed.estimate.note, /未確認/u);
  assert.equal(sure.estimate.outputTokens, 10 * 1200);
  assert.ok(sure.estimate.upperBoundUsd > sure.estimate.usd);
});

// ---- 実行ファイルの経路：偽の fetch を差し込んだ子 process で、送らないことを確かめる -----------------------
const preload = (log) =>
  `data:text/javascript,${encodeURIComponent(
    `import fs from "node:fs";globalThis.fetch=async(url)=>{fs.appendFileSync(${JSON.stringify(log)},String(url)+"\\n");throw new Error("blocked");};`,
  )}`;
let cliRuns = 0;
const runCli = (dir, args) => {
  const scenesDir = path.join(dir, "scenes");
  fs.mkdirSync(scenesDir, { recursive: true });
  fs.writeFileSync(
    path.join(scenesDir, "wk-zz.json"),
    JSON.stringify({ key: "wk-zz", scenes: [...scenes["wk-zz"].byPosition.values()] }),
  );
  const selectionFile = path.join(dir, "selection.json");
  fs.writeFileSync(selectionFile, JSON.stringify(selection));
  const log = path.join(dir, `fetch-${cliRuns++}.log`);
  const r = spawnSync(
    process.execPath,
    ["--import", preload(log), path.join(import.meta.dirname, "annotate-ai.mjs"), "--selection", selectionFile, "--scenes-dir", scenesDir, ...args],
    { encoding: "utf8" },
  );
  return { ...r, fetched: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
};

test("CLI：--dry-run --no-price-fetch は通信せず本文を出さない。--privacy-record が無い実送信は何も送らない", async () => {
  await withTmp(async (dir) => {
    const dry = runCli(dir, ["--dry-run", "--no-price-fetch"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(dry.fetched, []);
    assert.ok(!dry.stdout.includes("本文"));
    assert.equal(JSON.parse(dry.stdout).estimate.priceConfirmed, false);
    // 価格の取得は GET 1 回だけ（key なし）。ここでは偽の fetch が拒否するので仮定値に戻る
    const priced = runCli(dir, ["--dry-run"]);
    assert.equal(priced.status, 0, priced.stderr);
    assert.deepEqual(priced.fetched, [PRICING_URL]);
    assert.equal(JSON.parse(priced.stdout).pricing.confirmed, false);
    // 実送信：privacy record が無ければ止まり、fetch は 1 回も呼ばれない
    const send = runCli(dir, ["--out-dir", path.join(dir, "out"), "--state", path.join(dir, "state.jsonl"), "--no-price-fetch"]);
    assert.notEqual(send.status, 0);
    assert.match(send.stderr, /privacy-record/u);
    assert.deepEqual(send.fetched, []);
    assert.ok(!fs.existsSync(path.join(dir, "state.jsonl")));
    // 出力先が repo の内側なら、privacy record があっても止まる（§4 の独立性）
    const privacy = path.join(dir, "privacy.json");
    fs.writeFileSync(privacy, JSON.stringify({ checkedAt: "2026-11-06T00:00:00Z", accountSetting: "a", providerTerms: "b", checkedBy: "c" }));
    const inRepo = runCli(dir, ["--out-dir", import.meta.dirname, "--state", path.join(dir, "s2.jsonl"), "--privacy-record", privacy, "--no-price-fetch"]);
    assert.notEqual(inRepo.status, 0);
    assert.match(inRepo.stderr, /repo の外/u);
    assert.deepEqual(inRepo.fetched, []);
  });
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

test("sheet：匿名 ID は決定的で Scene だけから決まり、参照の数は重複の数、候補 0 件の query は出さない", () => {
  const withEmpty = {
    ...selection,
    queries: [
      ...selection.queries,
      { work: "wk-zz", queryPosition: 3, rawCount: 0, stratum: "short-le30", probeStatus: "available", candidates: [] },
    ],
  };
  const plan = planSheet(withEmpty);
  assert.deepEqual(plan, planSheet(withEmpty));
  assert.equal(plan.length, 2); // 候補 0 件の query は外れる
  assert.deepEqual(excludedQueries(withEmpty), [{ work: "wk-zz", queryPosition: 3, reason: "no-candidates" }]);
  const ids = plan.flatMap((q) => [[q.queryPosition, q.anonId], ...q.candidates.map((c) => [c.position, c.anonId])]);
  for (const [, id] of ids) assert.match(id, /^[0-9a-f]{6}$/u);
  // 同じ Scene は同じ ID、違う Scene は違う ID（query・由来・順位に依らない）
  const byPos = new Map();
  for (const [pos, id] of ids) assert.equal(byPos.get(pos) ?? id, (byPos.set(pos, id), id));
  assert.equal(new Set(byPos.values()).size, byPos.size);
  assert.equal(plan[0].anonId === anonId("fx", "wk-zz", plan[0].queryPosition), true);
  assert.notEqual(anonId("fx", "wk-zz", 1), anonId("fy", "wk-zz", 1));
  // 出現 7（今の 2＋候補 5）−異なる Scene 6 ＝ 参照 1
  const sheet = renderSheet({ selection: withEmpty, scenes, annotator: "user", plan, prompt });
  const appearances = ids.length;
  assert.equal(appearances - byPos.size, (sheet.match(/^→ ID /gmu) ?? []).length);
  // 参照の ID と見出しの ID が一致する（本文の見出しに ID: がある）
  for (const [, id] of ids) assert.ok(sheet.includes(`ID: ${id}`));
  // 新しい形（参照・ID 行入り）を取り込める
  const filled = sheet.replace(/^判定:$/gmu, "判定: s");
  const ann = ingestSheet(filled, { selectionSha256: "x", queries: plan }, { annotator: "user" });
  assert.equal(ann.labels.length, 5);
  // 対応表だけが ID と（作品・位置）の対応を持つ
  assert.ok(!sheet.includes(String(plan[0].queryPosition) + "|"));
});
