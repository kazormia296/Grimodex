// 測定 B の launcher の試験。偽の provider（page 側の bJudge を差し替える）と合成の sqlite で、
// 本測定の経路（key の導入→要求→ai_usage→surface の確認→key の削除）と、乾いた実行が送らないことを確かめる。
// Anthropic へは送らない。key・keyring・Electron は使わない。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createGate } from "./ledger.mjs";
import { candidateKey, hashSurface } from "./lib.mjs";
import {
  CONFIRM_SEND,
  assertSafeStorageBackend,
  assertSendAllowed,
  dryCellBody,
  dryCellStatus,
  measureBBody,
  realCellStatus,
} from "./run-measure-b.mjs";
import { assertNoFakeAiEnv, findForbiddenEnv } from "./launcher-common.mjs";

const FAKE_KEY = `sk-ant-${"y".repeat(50)}`;
const PRICING = { inputPerMillion: 2, outputPerMillion: 10 };

const roster = {
  entities: [
    { id: "e1", type: "character", name: "n1", aliases: [{ surface: "c000", level: "L2" }, { surface: "c001", level: "L3" }] },
    { id: "e2", type: "location", name: "n2", aliases: [] },
  ],
};

/** page 側の window.identityLoad を模す。judge は ai_usage・audit に 1 行ずつ書く（製品の recordAiUsage・audit の代わり）。 */
async function installFakeWindow({ workspaceDir, calls, usageSurface = "codex_judgment", candidateCount = 60 }) {
  mkdirSync(workspaceDir, { recursive: true });
  const db = path.join(workspaceDir, "ws.db");
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE ai_usage (id TEXT, surface TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at TEXT);
     CREATE TABLE ai_audit_events (id INTEGER, path_id TEXT);`,
  ]);
  const hashes = [];
  for (let i = 0; i < candidateCount; i++)
    hashes.push(await hashSurface(candidateKey(`c${String(i).padStart(3, "0")}`)));
  let visible = hashes.map((keyHash, i) => ({ keyHash, count: 100 - i, firstSceneIndex: 1 }));
  let entries = 0;
  let seq = 0;
  const prepared = () => ({
    rawCount: candidateCount,
    activeCount: visible.length,
    visibleCount: visible.length,
    dismissedCount: 0,
    entryCount: entries,
    candidates: visible,
  });
  globalThis.window = {
    identityLoad: {
      registerRoster: async (input) => {
        entries += input.entries.length;
        calls.push(["register", input.entries.length]);
        return { created: input.entries.length };
      },
      bConfigureAi: async (input) => {
        calls.push(["configure", input.provider, input.model, input.key === FAKE_KEY]);
        return { provider: input.provider, model: input.model, thinkingEnabled: false, keyPresent: true };
      },
      bDeleteKey: async () => {
        calls.push(["delete-key"]);
        return { keyPresent: false };
      },
      bAiGate: async () => ({ policyBlocked: false, licenseRestricted: false, language: "ja" }),
      bPrepare: async () => prepared(),
      bEstimate: async () => ({
        judgedSlots: Math.min(visible.length, 50),
        entrySlots: Math.min(entries, 200),
        entryAliasCount: 2,
        contextChars: 2000,
        promptChars: 8000,
        promptNonAsciiChars: 6000,
      }),
      bJudge: async () => {
        calls.push(["judge"]);
        seq++;
        execFileSync("sqlite3", [
          db,
          `INSERT INTO ai_usage VALUES ('${seq}','${usageSurface}','claude-sonnet-5-5',8000,${Math.min(visible.length, 50) * 80},'2026-01-01T00:00:${String(seq).padStart(2, "0")}Z');
           INSERT INTO ai_audit_events VALUES (${seq},'codex_judgment');`,
        ]);
        return {
          ok: true,
          judgments: visible.slice(0, 50).map((c) => ({
            keyHash: c.keyHash,
            suggestedType: "character",
            aliasOfId: c.keyHash === hashes[0] ? "e1" : null,
            aliasKnown: true,
          })),
          durationMs: 3,
        };
      },
      bApply: async ({ decisions }) => {
        calls.push(["apply", decisions.length]);
        const gone = new Set(decisions.map((d) => d.keyHash));
        visible = visible.filter((c) => !gone.has(c.keyHash));
        return { counts: {}, ...prepared() };
      },
    },
  };
  return { page: { evaluate: async (fn, arg) => fn(arg) }, db };
}

function withTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-runb-"));
  const finish = () => rmSync(dir, { recursive: true, force: true });
  return Promise.resolve(fn(dir)).finally(finish);
}

test("本測定は明示の許可が無ければ始めない。dry-run は送るモードではない", () => {
  assert.throws(() => assertSendAllowed({ mode: "b1", "confirm-send": "" }), /SEND_NOT_CONFIRMED/u);
  assert.throws(() => assertSendAllowed({ mode: "b1", "confirm-send": "yes" }), /SEND_NOT_CONFIRMED/u);
  assert.throws(() => assertSendAllowed({ mode: "dry-run", "confirm-send": CONFIRM_SEND }), /SEND_MODE/u);
  assert.doesNotThrow(() => assertSendAllowed({ mode: "b2", "confirm-send": CONFIRM_SEND }));
});

test("safeStorage の backend：basic_text・不明は止める", () => {
  assert.throws(() => assertSafeStorageBackend("basic_text"), /SAFE_STORAGE_BACKEND/u);
  assert.throws(() => assertSafeStorageBackend("unknown"), /SAFE_STORAGE_BACKEND/u);
  assert.throws(() => assertSafeStorageBackend(undefined), /SAFE_STORAGE_BACKEND/u);
  assert.doesNotThrow(() => assertSafeStorageBackend("gnome_libsecret"));
});

test("偽 AI の env（GRIMODEX_PRODUCT_JOURNEY*）が立っていれば本測定の process は止まる（名前だけ数える）", () => {
  assert.deepEqual(findForbiddenEnv({ PATH: "/bin", GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1", GRIMODEX_PRODUCT_JOURNEY_STREAM_GATE_DIR: "x" }), [
    "GRIMODEX_PRODUCT_JOURNEY_FAKE_AI",
    "GRIMODEX_PRODUCT_JOURNEY_STREAM_GATE_DIR",
  ]);
  assert.throws(
    () => assertNoFakeAiEnv({ GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1" }),
    (e) => /FAKE_AI_ENV_SET/u.test(e.message) && !e.message.includes("deterministic-v1"),
  );
  assert.doesNotThrow(() => assertNoFakeAiEnv({ PATH: "/bin" }));
  // この試験 process 自身にも立っていない。
  assert.doesNotThrow(() => assertNoFakeAiEnv(process.env));
});

test("乾いた実行：送信の関数（bJudge）を呼ばず、key の導入・AI 設定もしない", async () => {
  const calls = [];
  globalThis.window = {
    identityLoad: {
      bSynthRoster: async (input) => {
        calls.push(["synth", input.entityCount, input.aliasTotal]);
        return { created: input.entityCount };
      },
      bAiGate: async () => ({ policyBlocked: false, licenseRestricted: false, language: "ja" }),
      bPrepare: async () => ({ rawCount: 150, activeCount: 150, visibleCount: 150, dismissedCount: 0, entryCount: 5, candidates: [] }),
      bEstimate: async () => ({
        judgedSlots: 50,
        entrySlots: 5,
        entryAliasCount: 0,
        contextChars: 3000,
        promptChars: 9000,
        promptNonAsciiChars: 6000,
      }),
      bJudge: async () => {
        throw new Error("send must not be called in a dry run");
      },
      bConfigureAi: async () => {
        throw new Error("AI settings must not be touched in a dry run");
      },
    },
  };
  const page = { evaluate: async (fn, arg) => fn(arg) };
  const out = await dryCellBody({ page });
  assert.deepEqual(out.levels.map((l) => l.level), ["empty", "L0", "L1", "L2", "L3"]);
  assert.ok(out.levels.every((l) => l.request.estInputTokens > 0 && l.b1Requests === 3 && l.b2Requests === 3));
  assert.deepEqual(calls, [
    ["synth", 60, 0],
    ["synth", 60, 40],
    ["synth", 60, 100],
    ["synth", 60, 160],
  ]);
});

test("乾いた実行の採用条件：AI の command・send_chat_message・AI の行・外向き通信が 0", () => {
  const good = {
    ipc: { commandNames: ["codex_create"], commandCounts: { codex_create: 3 } },
    aiRows: { verified: true, tables: { ai_usage: 0, ai_audit_events: 0 } },
    egress: { nonLoopbackDestinationCount: 0, sampleCount: 4 },
  };
  assert.equal(dryCellStatus(good), "ok");
  assert.equal(dryCellStatus({ ...good, ipc: { commandNames: ["send_chat_message"], commandCounts: { send_chat_message: 1 } } }), "ai-detected");
  assert.equal(dryCellStatus({ ...good, ipc: { commandNames: ["get_ai_settings"], commandCounts: {} } }), "ai-detected");
  assert.equal(dryCellStatus({ ...good, aiRows: { verified: true, tables: { ai_usage: 1 } } }), "ai-detected");
  assert.equal(dryCellStatus({ ...good, aiRows: { verified: false, tables: {} } }), "ai-unverified");
  assert.equal(dryCellStatus({ ...good, egress: { nonLoopbackDestinationCount: 1, sampleCount: 4 } }), "egress-detected");
});

test("本測定の採用条件：許した AI command だけ・送信回数が IPC と一致", () => {
  const cell = (names, sent) => ({ ipc: { commandNames: names, commandCounts: { send_chat_message: sent } } });
  assert.equal(realCellStatus(cell(["get_ai_settings", "save_ai_settings", "send_chat_message"], 3), { requestsSent: 3 }), "ok");
  assert.equal(realCellStatus(cell(["send_chat_message", "send_chat_message_stream"], 3), { requestsSent: 3 }), "unexpected-ai-command");
  assert.equal(realCellStatus(cell(["send_chat_message"], 2), { requestsSent: 3 }), "send-count-mismatch");
});

test("偽の provider での本測定の経路（B1）：key を入れ、3 要求、surface を確かめ、key を消す", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls });
    const gate = createGate({ file: path.join(dir, "ledger.jsonl"), model: "claude-sonnet-5-5", pricing: PRICING });
    const value = await measureBBody({
      page,
      app: null,
      projectId: "p",
      workspaceDir,
      roster,
      level: "L2",
      mode: "b1",
      gate,
      key: FAKE_KEY,
      expectedSafeStorageCheck: false,
      usagePoll: { timeoutMs: 1000, intervalMs: 5 },
    });
    assert.equal(value.requestsSent, 3);
    assert.equal(value.result.successCount, 3);
    assert.deepEqual(value.surfaces, { usageSurfaceCount: 1, auditPathCount: 1 });
    assert.deepEqual(value.usageModels, { "claude-sonnet-5-5": 3 });
    assert.equal(calls.filter((c) => c[0] === "judge").length, 3);
    assert.deepEqual(calls[0], ["register", 2]);
    assert.deepEqual(calls[1], ["configure", "anthropic", "claude-sonnet-5-5", true]);
    assert.deepEqual(calls.at(-1), ["delete-key"]);
    assert.equal(gate.state.billedRequests, 3);
    // 結果に key・表記の文字列が無い。
    assert.ok(!JSON.stringify(value).includes(FAKE_KEY));
  });
});

test("偽の provider：別の surface の AI 経路が混ざれば止まり、それでも key は消す", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls, usageSurface: "chat" });
    const gate = createGate({ file: path.join(dir, "ledger.jsonl"), model: "claude-sonnet-5-5", pricing: PRICING });
    await assert.rejects(
      measureBBody({
        page,
        app: null,
        projectId: "p",
        workspaceDir,
        roster,
        level: "L2",
        mode: "trial",
        gate,
        key: FAKE_KEY,
        expectedSafeStorageCheck: false,
        usagePoll: { timeoutMs: 50, intervalMs: 5 },
      }),
      // surface が chat の行は codex_judgment の成功に数えられず、要求は失敗になる。終了時の集合の検査でも止まる。
      () => true,
    );
    assert.deepEqual(calls.at(-1), ["delete-key"]);
  });
});

test("偽の provider（B2）：模擬作者が名簿どおりに進め、ceil(N/50) 要求", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls, candidateCount: 120 });
    const gate = createGate({ file: path.join(dir, "ledger.jsonl"), model: "claude-sonnet-5-5", pricing: PRICING });
    const value = await measureBBody({
      page,
      app: null,
      projectId: "p",
      workspaceDir,
      roster,
      level: "L2",
      mode: "b2",
      gate,
      key: FAKE_KEY,
      expectedSafeStorageCheck: false,
      usagePoll: { timeoutMs: 1000, intervalMs: 5 },
    });
    assert.equal(value.requestsSent, 3);
    assert.equal(value.result.plannedIterations, 3);
    assert.equal(value.result.finalVisibleCount, 0);
    // 名簿（全段）で e1 の別名 c000・c001 は、登録が L2 でも名簿どおりに e1 への別名にする。残りは名簿に無く却下。
    assert.equal(value.result.decisionCounts.alias, 2);
    assert.equal(value.result.dismissReasons.unlisted, 118);
  });
});
