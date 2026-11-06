// AI 注釈（事前登録 第 1 版 §4・§8）：OpenRouter 経由の openai/gpt-6-luna に、(今の Scene, 候補の Scene) の組ごとに
// strict／partial／none を付けさせる。prompt は annotation-prompt.md（sha256 を記録）。同じ prompt を 2 回出し、
// 1 回目を注釈（ai）、2 回目を安定性（ai2）に使う。理由の文章は求めず、応答の本文は保存しない（label だけ）。
//
// --dry-run：送信範囲（送る本文の件数・文字数・model・endpoint。本文そのものは出さない）だけを出して終わる。
//            key は読まず、通信しない。
// 実送信：次が揃うときだけ。
//   --privacy-record <json>  §8 の「学習に使われない設定」の確認の記録（checkedAt／accountSetting／providerTerms／checkedBy）
//   key の経路は評価の harness（ir-slot.mjs）と同じ：
//     --key-file <path>（既定 ~/.config/grimodex-eval/openrouter.key、権限 600、sk-or- 接頭辞。通常 file か FIFO）
//     --product-key-store <ai-keys.json>（製品の profile の safeStorage の key を Electron で復号し、FIFO で受け取る。平文はディスクに残さない）
//   key の値・長さは表示も記録もしない。
//
// 使い方：
//   node annotate-ai.mjs --selection <selection.json> --dry-run
//   node annotate-ai.mjs --selection <selection.json> --out-dir <dir> --state <repo 外の jsonl> \
//        --privacy-record <json> [--key-file <path> | --product-key-store <ai-keys.json>] \
//        [--repeats 2] [--concurrency 4] [--model openai/gpt-6-luna] [--harness-root <評価 harness の worktree>]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileSha256, sha256Hex } from "./agg-pg.mjs";
import {
  SCENES_DIR,
  assertOutsideRepo,
  loadPrompt,
  loadScenes,
  readJson,
  sceneText,
} from "./pg-common.mjs";

export const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = "openai/gpt-6-luna";
export const DEFAULT_KEY_FILE = path.join(os.homedir(), ".config/grimodex-eval/openrouter.key");
export const DEFAULT_HARNESS_ROOT = "/home/grimodex/worktrees/Grimodex/claude-fusion-ir-eval-v6";
const KEY_PREFIX = "sk-or-";
const MAX_TOKENS = 4096;
const MAX_ATTEMPTS = 3;
// 費用の見積り（推測）：harness（ir-slot.mjs）の PRICE_ASSUMPTIONS と同じ単価。OpenRouter の現行の掲載値は未確認。
const PRICE = { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 };
const TOKENS_PER_CHAR = 1.5; // 日本語の保守的な見積り（推測）
const OUTPUT_TOKENS_PER_CALL = 200; // 短い JSON のみ。推論 token の分は未確認

/** 注釈する組（selection の全候補）。 */
export function pairsOf(selection) {
  return selection.queries.flatMap((q) =>
    q.candidates.map((c) => ({
      pairId: c.pairId,
      work: q.work,
      queryPosition: q.queryPosition,
      candidatePosition: c.position,
    })),
  );
}

/** 1 回の呼出しの messages。2 つの Scene はタグで囲んだデータとして渡す。 */
export function buildMessages(systemPrompt, currentText, candidateText) {
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `<current_scene>\n${currentText}\n</current_scene>\n\n<candidate_scene>\n${candidateText}\n</candidate_scene>`,
    },
  ];
}

export function requestBody(model, messages) {
  return {
    model,
    messages,
    max_tokens: MAX_TOKENS,
    // 入力を保存・学習に使う provider を除く（OpenRouter の provider routing）。§8 の account 設定の確認に加える防御。
    provider: { data_collection: "deny" },
  };
}

/** 応答の本文から label を取る。取れなければ null（本文は保存しない）。 */
export function parseLabel(content) {
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const label = JSON.parse(content.slice(start, end + 1))?.label;
    return ["strict", "partial", "none"].includes(label) ? label : null;
  } catch {
    return null;
  }
}

/** 送信範囲の要約（本文を含まない）。 */
export function sendScope({ selection, scenes, prompt, model, repeats }) {
  const pairs = pairsOf(selection);
  const distinctScenes = new Set();
  let currentChars = 0;
  let candidateChars = 0;
  let maxPairChars = 0;
  for (const p of pairs) {
    const cur = scenes[p.work].byPosition.get(p.queryPosition);
    const cand = scenes[p.work].byPosition.get(p.candidatePosition);
    assert.ok(cur && cand, `Scene が無い: ${p.pairId}`);
    const a = sceneText(cur).length;
    const b = sceneText(cand).length;
    currentChars += a;
    candidateChars += b;
    maxPairChars = Math.max(maxPairChars, a + b);
    distinctScenes.add(`${p.work}|${p.queryPosition}`);
    distinctScenes.add(`${p.work}|${p.candidatePosition}`);
  }
  const systemChars = prompt.system.length;
  const calls = pairs.length * repeats;
  const bodyChars = (currentChars + candidateChars) * repeats;
  const totalChars = bodyChars + systemChars * calls;
  const inputTokens = Math.round(totalChars * TOKENS_PER_CHAR);
  const outputTokens = calls * OUTPUT_TOKENS_PER_CALL;
  return {
    model,
    endpoint: ENDPOINT,
    provider: { data_collection: "deny" },
    queries: selection.queries.length,
    pairs: pairs.length,
    repeats,
    calls,
    distinctScenesSent: distinctScenes.size,
    sceneBodiesSent: pairs.length * 2 * repeats,
    sceneBodyChars: bodyChars,
    systemPromptChars: systemChars,
    maxChars: { perPairBodies: maxPairChars },
    totalInputChars: totalChars,
    estimate: {
      note: "推測（単価は harness の仮定値で OpenRouter の現行掲載値は未確認、token は 1.5 token／字、出力は 1 回 200 token と仮定）",
      inputTokens,
      outputTokens,
      usd: (inputTokens * PRICE.inputUsdPerMillion + outputTokens * PRICE.outputUsdPerMillion) / 1e6,
    },
    scenesFiles: Object.fromEntries(
      Object.entries(scenes).map(([w, s]) => [w, { sha256: s.sha256 }]),
    ),
  };
}

// ---- key の経路（評価の harness ir-slot.mjs と同じ） --------------------------------------
/** key の file（通常の file か FIFO）。値・長さは返り値以外に出さない。 */
export function readKeyFile(file) {
  assertOutsideRepo(file);
  const info = fs.statSync(file);
  assert.equal(info.mode & 0o077, 0, "[precheck] key の file の権限は 600");
  const key = fs.readFileSync(file, "utf8").trim();
  assertKeyShape(key);
  return key;
}

function assertKeyShape(key) {
  assert.ok(
    key.startsWith(KEY_PREFIX) && key.length >= 40 && key.length <= 300 && !/\s/u.test(key),
    "[precheck] key の形式（接頭辞と長さ）が想定と違う",
  );
}

/** 製品の profile の safeStorage の key を、harness の復号 script（Electron）が FIFO で渡す。 */
async function readProductKey(store, harnessRoot) {
  assertOutsideRepo(store);
  const dir = path.join(harnessRoot, "scripts/quality/fusion-slot-eval");
  const { makeKeyFifo, readKeyFromFifo } = await import(pathToFileURL(path.join(dir, "fifo-key.mjs")).href);
  const electron = createRequire(path.join(harnessRoot, "package.json"))("electron");
  const { fifo, cleanup } = makeKeyFifo(os.tmpdir());
  const abort = new globalThis.AbortController();
  const lines = [];
  try {
    const reading = readKeyFromFifo(fifo, { signal: abort.signal });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electron,
      [path.join(dir, "product-key-to-fifo.mjs"), "--store", store, "--service", "grimodex-openrouter", "--fifo", fifo, "--prefix", KEY_PREFIX],
      { cwd: harnessRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n"))
          if (line.startsWith("[product-key]")) lines.push(line.slice(0, 200));
      });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    exited.then((code) => code !== 0 && abort.abort());
    const value = await reading;
    assert.equal(await exited, 0, `[key] 復号の script が失敗した（${lines.join(" ")}）`);
    assertKeyShape(value);
    return value;
  } finally {
    cleanup();
  }
}

export async function obtainKey(opts) {
  if (opts["product-key-store"]) return readProductKey(opts["product-key-store"], opts["harness-root"] ?? DEFAULT_HARNESS_ROOT);
  return readKeyFile(opts["key-file"] ?? DEFAULT_KEY_FILE);
}

// ---- §8 の送信前の確認の記録 -----------------------------------------------------------
export function readPrivacyRecord(file) {
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(KEY_PREFIX), "[precheck] privacy record に key らしい値が入っている");
  const record = JSON.parse(raw);
  for (const field of ["checkedAt", "accountSetting", "providerTerms", "checkedBy"])
    assert.ok(typeof record[field] === "string" && record[field].trim() !== "", `[precheck] privacy record の ${field} が空`);
  assert.ok(!Number.isNaN(Date.parse(record.checkedAt)), "[precheck] privacy record の checkedAt が日時でない");
  return { record, sha256: sha256Hex(raw) };
}

// ---- 送信 ------------------------------------------------------------------------------
async function callOnce({ key, body, fetchImpl }) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/kazormia296/Grimodex",
        "X-Title": "Grimodex precision gold annotation",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    lastStatus = res.status;
    await res.text(); // 本文（エラー）は読み捨て、保存も表示もしない
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new Error(`OpenRouter が失敗（HTTP ${lastStatus}）`);
}

/** state（jsonl：label と数値だけ。応答の本文・key は無い）から、完了済みと試行回数を読む。 */
export function loadState(file) {
  const done = new Map();
  const attempts = new Map();
  if (file && fs.existsSync(file))
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      const id = `${e.pairId}#${e.repeat}`;
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      if (e.label) done.set(id, e);
    }
  return { done, attempts };
}

export async function runAnnotation({ selection, scenes, prompt, model, repeats, concurrency, key, stateFile, fetchImpl = globalThis.fetch }) {
  const { done, attempts } = loadState(stateFile);
  const jobs = [];
  for (const p of pairsOf(selection))
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const id = `${p.pairId}#${repeat}`;
      if (!done.has(id) && (attempts.get(id) ?? 0) < MAX_ATTEMPTS) jobs.push({ ...p, repeat, id });
    }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const cur = scenes[job.work].byPosition.get(job.queryPosition);
      const cand = scenes[job.work].byPosition.get(job.candidatePosition);
      const body = requestBody(model, buildMessages(prompt.system, sceneText(cur), sceneText(cand)));
      const data = await callOnce({ key, body, fetchImpl });
      const entry = {
        pairId: job.pairId,
        repeat: job.repeat,
        label: parseLabel(data.choices?.[0]?.message?.content),
        returnedModel: typeof data.model === "string" ? data.model : null,
        provider: typeof data.provider === "string" ? data.provider : null,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? null,
          completionTokens: data.usage?.completion_tokens ?? null,
          cost: data.usage?.cost ?? null,
        },
        at: new Date().toISOString(),
      };
      fs.appendFileSync(stateFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { scheduled: jobs.length };
}

/** state から注釈 file（ai／ai2…）を作る。未完了があれば null。 */
export function buildAnnotationFiles({ selection, selectionSha256, stateFile, repeats, prompt, model, privacy }) {
  const entries = fs
    .readFileSync(stateFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const pairs = pairsOf(selection);
  const files = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const mine = entries.filter((e) => e.repeat === repeat);
    const labelOf = new Map(mine.filter((e) => e.label).map((e) => [e.pairId, e]));
    const missing = pairs.filter((p) => !labelOf.has(p.pairId)).length;
    const invalid = mine.filter((e) => !e.label).length;
    const used = pairs.map((p) => labelOf.get(p.pairId)).filter(Boolean);
    const sum = (f) => used.reduce((a, e) => a + (e.usage[f] ?? 0), 0);
    files.push({
      name: repeat === 1 ? "ai" : `ai${repeat}`,
      missing,
      body: {
        schemaVersion: "fusion-slot-pg-annotations/1",
        annotator: repeat === 1 ? "ai" : `ai${repeat}`,
        selectionSha256,
        meta: {
          source: "openrouter",
          model,
          returnedModels: [...new Set(used.map((e) => e.returnedModel))].sort(),
          providers: [...new Set(used.map((e) => e.provider))].sort(),
          endpoint: ENDPOINT,
          promptFileSha256: prompt.fileSha256,
          systemPromptSha256: prompt.systemSha256,
          dataCollection: "deny",
          privacyRecord: privacy,
          repeat,
          labeled: used.length,
          invalidResponses: invalid,
          firstAt: used.map((e) => e.at).sort()[0] ?? null,
          lastAt: used.map((e) => e.at).sort().at(-1) ?? null,
          usage: { promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), cost: sum("cost") },
        },
        labels: pairs
          .filter((p) => labelOf.has(p.pairId))
          .map((p) => ({ work: p.work, queryPosition: p.queryPosition, candidatePosition: p.candidatePosition, label: labelOf.get(p.pairId).label })),
      },
    });
  }
  return files;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; ) {
    const name = argv[i];
    assert.ok(name.startsWith("--"), `引数の形が不正: ${name}`);
    if (name === "--dry-run") {
      opts.dryRun = true;
      i += 1;
    } else {
      assert.ok(argv[i + 1] !== undefined, `${name} に値が要る`);
      opts[name.slice(2)] = argv[i + 1];
      i += 2;
    }
  }
  return opts;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  assert.ok(opts.selection, "--selection が要る");
  const model = opts.model ?? DEFAULT_MODEL;
  const repeats = Number(opts.repeats ?? 2);
  const concurrency = Number(opts.concurrency ?? 4);
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3, "--repeats は 1〜3");
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8, "--concurrency は 1〜8");
  const selection = readJson(opts.selection);
  const selectionSha256 = fileSha256(opts.selection);
  const scenesDir = opts["scenes-dir"] ?? SCENES_DIR;
  const scenes = {};
  for (const work of new Set(selection.queries.map((q) => q.work)))
    scenes[work] = loadScenes(scenesDir, selection, work);
  const prompt = loadPrompt();
  const scope = {
    ...sendScope({ selection, scenes, prompt, model, repeats }),
    promptFileSha256: prompt.fileSha256,
    systemPromptSha256: prompt.systemSha256,
    selectionSha256,
  };
  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", sent: false, ...scope }, null, 2)}\n`);
    return;
  }
  // ---- 実送信（この script の dry-run 以外）。§8：学習に使われない設定の確認の記録が先。
  assert.ok(opts["privacy-record"], "[precheck] --privacy-record（§8 の確認の記録）が要る");
  assert.ok(opts["out-dir"] && opts.state, "--out-dir と --state が要る");
  assertOutsideRepo(opts.state);
  const privacy = readPrivacyRecord(opts["privacy-record"]);
  process.stdout.write(`${JSON.stringify({ mode: "send", ...scope }, null, 2)}\n`);
  const key = await obtainKey(opts);
  await runAnnotation({ selection, scenes, prompt, model, repeats, concurrency, key, stateFile: opts.state });
  const files = buildAnnotationFiles({
    selection, selectionSha256, stateFile: opts.state, repeats, prompt, model,
    privacy: { sha256: privacy.sha256, checkedAt: privacy.record.checkedAt },
  });
  const incomplete = files.filter((f) => f.missing > 0);
  if (incomplete.length > 0) {
    process.stdout.write(`${JSON.stringify({ complete: false, missing: Object.fromEntries(incomplete.map((f) => [f.name, f.missing])) })}\n`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(opts["out-dir"], { recursive: true });
  for (const f of files)
    fs.writeFileSync(path.join(opts["out-dir"], `annotations-${f.name}.json`), `${JSON.stringify(f.body, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ complete: true, files: files.map((f) => f.name) })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main(process.argv.slice(2));
