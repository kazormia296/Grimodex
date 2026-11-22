// 測定 B の launcher の試験。偽の provider（page 側の bJudge を差し替える）と合成の sqlite で、
// 本測定の経路（key の導入→要求→ai_usage→surface の確認→key の削除）と、乾いた実行が送らないことを確かめる。
// Anthropic へは送らない。key・keyring・Electron は使わない。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import { createEgressSampler } from "./egress-policy.mjs";
import { BudgetStop, createGate } from "./ledger.mjs";
import {
  assertOutputClean,
  candidateKey,
  hashSurface,
  safeErrorSummary,
} from "./lib.mjs";
import {
  CONFIRM_SEND,
  DRY_RUN_ASSUMPTIONS,
  JUDGE_WATCHDOG_MS,
  KEY_REMOVAL_TIMEOUT_MS,
  withWatchdog,
  assertSafeStorageCondition,
  bindPageApi,
  assertSendAllowed,
  dryCellBody,
  dryCellStatus,
  measureBBody,
  realCellStatus,
} from "./run-measure-b.mjs";
import {
  assertNoFakeAiEnv,
  assertNoOverlappingJobs,
  findForbiddenEnv,
  findOverlappingJobs,
} from "./launcher-common.mjs";
import { findKeyResidue, registerCleanup, runCleanups } from "./cleanup.mjs";
import { assertRecordsClean } from "./aggregate.mjs";
import { findUnsafeStrings } from "./lib.mjs";

/** 宛先の観測（createEgressSampler の observation()）：違反が無く、標本・直近の tick・socket が成り立っている。 */
const GOOD_EGRESS = {
  violations: [],
  sampleCount: 3,
  lastTickOk: true,
  lastSocketCount: 5,
  ageMs: 10,
};
const FAKE_KEY = `sk-ant-${"y".repeat(50)}`;
const PRICING = { inputPerMillion: 2, outputPerMillion: 10 };

const roster = {
  entities: [
    {
      id: "e1",
      type: "character",
      name: "n1",
      aliases: [
        { surface: "c000", level: "L2" },
        { surface: "c001", level: "L3" },
      ],
    },
    { id: "e2", type: "location", name: "n2", aliases: [] },
  ],
};

/** page 側の window.identityLoad を模す。judge は ai_usage・audit に 1 行ずつ書く（製品の recordAiUsage・audit の代わり）。 */
async function installFakeWindow({
  workspaceDir,
  calls,
  usageSurface = "codex_judgment",
  candidateCount = 60,
  guards = {},
}) {
  mkdirSync(workspaceDir, { recursive: true });
  const db = path.join(workspaceDir, "ws.db");
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE ai_usage (id TEXT, surface TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at TEXT);
     CREATE TABLE ai_audit_events (id INTEGER, path_id TEXT);`,
  ]);
  const hashes = [];
  for (let i = 0; i < candidateCount; i++)
    hashes.push(
      await hashSurface(candidateKey(`c${String(i).padStart(3, "0")}`)),
    );
  let visible = hashes.map((keyHash, i) => ({
    keyHash,
    count: 100 - i,
    firstSceneIndex: 1,
  }));
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
        calls.push([
          "configure",
          input.provider,
          input.model,
          input.key === FAKE_KEY,
        ]);
        return {
          provider: input.provider,
          model: input.model,
          thinkingEnabled: false,
          keyPresent: true,
        };
      },
      bDeleteKey: async () => {
        calls.push(["delete-key"]);
        return { keyPresent: false };
      },
      // F2 の guard の page 側（役割の上書き・名簿の hidden）。guards で結果を差し替えられる。
      bAssertRoleDefaults: async () => {
        guards.log?.push(["assert-role"]);
        if (guards.roleThrows) throw new Error("settings unreadable");
        const override =
          typeof guards.role === "function" ? guards.role() : guards.role;
        return (
          override ?? {
            checked: true,
            roleKeysChecked: 7,
            nonDefaultRoleKeys: 0,
            roleProvidersNonDefault: false,
            sendOverrideClear: true,
          }
        );
      },
      bAssertRosterNotHidden: async () => {
        guards.log?.push(["assert-hidden"]);
        if (guards.hiddenThrows) throw new Error("db unreadable");
        const override =
          typeof guards.hidden === "function" ? guards.hidden() : guards.hidden;
        return (
          override ?? {
            checked: true,
            entryCount: entries,
            checkedCount: entries,
            hiddenCount: 0,
          }
        );
      },
      bAiGate: async () => ({
        policyBlocked: false,
        licenseRestricted: false,
        language: "ja",
      }),
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

/** text の中の `function name(...) { ... }`（async を含む）の本体を、波括弧の対応で切り出す。 */
function functionBody(text, name) {
  const start = text.search(new RegExp(`function ${name}\\(`, "u"));
  assert.ok(start >= 0, name);
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  assert.fail(`${name} is not closed`);
  return "";
}

function withTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-runb-"));
  const finish = () => rmSync(dir, { recursive: true, force: true });
  return Promise.resolve(fn(dir)).finally(finish);
}

test("本測定は明示の許可が無ければ始めない。dry-run は送るモードではない", () => {
  assert.throws(
    () => assertSendAllowed({ mode: "b1", "confirm-send": "" }),
    /SEND_NOT_CONFIRMED/u,
  );
  assert.throws(
    () => assertSendAllowed({ mode: "b1", "confirm-send": "yes" }),
    /SEND_NOT_CONFIRMED/u,
  );
  assert.throws(
    () => assertSendAllowed({ mode: "dry-run", "confirm-send": CONFIRM_SEND }),
    /SEND_MODE/u,
  );
  assert.doesNotThrow(() =>
    assertSendAllowed({ mode: "b2", "confirm-send": CONFIRM_SEND }),
  );
});

test("safeStorage の backend：basic_text は条件つきで認める。unknown・空は止める。記録に backend の名前を残す", async () => {
  await withTmp((dir) => {
    const runRoot = path.join(dir, "run");
    const userData = path.join(runRoot, "cell", "user-data");
    mkdirSync(userData, { recursive: true });
    chmodSync(path.join(runRoot, "cell"), 0o700);
    chmodSync(userData, 0o700);
    const ok = { userData, runRoot, keep: false, overridden: true };
    const record = assertSafeStorageCondition({ ...ok, backend: "basic_text" });
    assert.deepEqual(record, {
      backend: "basic_text",
      plainTextAllowed: true,
      userDataPrivate: true,
      underRunRoot: true,
      deletedAtCellEnd: true,
    });
    assert.equal(
      assertSafeStorageCondition({ ...ok, backend: "gnome_libsecret" })
        .plainTextAllowed,
      false,
    );
    for (const backend of ["unknown", "", undefined])
      assert.throws(
        () => assertSafeStorageCondition({ ...ok, backend }),
        /SAFE_STORAGE_BACKEND/u,
      );
    const code = (patch) => {
      try {
        assertSafeStorageCondition({ ...ok, backend: "basic_text", ...patch });
      } catch (error) {
        assert.ok(!error.message.includes(dir));
        return /SAFE_STORAGE_CONDITION (\w+)/u.exec(error.message)?.[1];
      }
      return "none";
    };
    assert.equal(code({ keep: true }), "KEEP_FORBIDDEN");
    assert.equal(code({ overridden: false }), "PLAIN_TEXT_OVERRIDE_INACTIVE");
    assert.equal(
      code({ userData: path.join(dir, "missing") }),
      "USERDATA_NOT_FOUND",
    );
    const outside = path.join(dir, "outside");
    mkdirSync(outside, { mode: 0o700 });
    assert.equal(code({ userData: outside }), "USERDATA_ROOT");
    chmodSync(userData, 0o755);
    assert.equal(code({}), "USERDATA_MODE");
    chmodSync(userData, 0o700);
    chmodSync(path.join(runRoot, "cell"), 0o755); // cell の dir（userData の親）も 0700 であること
    assert.equal(code({}), "USERDATA_MODE");
  });
});

test("measureBBody：条件が満たせなければ key を読まず、満たせば backend の名前を結果に残す", async () => {
  await withTmp(async (dir) => {
    const runRoot = path.join(dir, "run");
    const userData = path.join(runRoot, "cell", "user-data");
    mkdirSync(userData, { recursive: true });
    chmodSync(path.join(runRoot, "cell"), 0o700);
    chmodSync(userData, 0o700);
    const gate = () =>
      createGate({
        file: path.join(dir, `ledger-${Math.random()}.jsonl`),
        model: "claude-sonnet-5-5",
        pricing: PRICING,
        requireTrial: false,
      });
    const app = {
      evaluate: async (fn) =>
        fn({ safeStorage: { getSelectedStorageBackend: () => "basic_text" } }),
    };
    const run = async (extra, calls, workspaceDir) => {
      const { page } = await installFakeWindow({ workspaceDir, calls });
      let reads = 0;
      const result = await measureBBody({
        page,
        app,
        projectId: "p",
        workspaceDir,
        roster,
        level: "L2",
        mode: "trial",
        gate: gate(),
        getKey: async () => {
          reads++;
          return FAKE_KEY;
        },
        userData,
        runRoot,
        usagePoll: { timeoutMs: 1000, intervalMs: 5 },
        egressObservation: () => GOOD_EGRESS,
        ...extra,
      });
      return { result, reads };
    };
    // 上書きが無い（製品の拒否を通せない）なら key を読まず、AI の設定もしない。
    const calls1 = [];
    await assert.rejects(
      run({}, calls1, path.join(dir, "w1")),
      /SAFE_STORAGE_CONDITION PLAIN_TEXT_OVERRIDE_INACTIVE/u,
    );
    assert.ok(!calls1.some((c) => c[0] === "configure" || c[0] === "judge"));
    // --keep の cell でも読まない。
    globalThis.idlRealStorageBackend = () => "basic_text";
    try {
      const calls2 = [];
      await assert.rejects(
        run({ keep: true }, calls2, path.join(dir, "w2")),
        /SAFE_STORAGE_CONDITION KEEP_FORBIDDEN/u,
      );
      assert.ok(!calls2.some((c) => c[0] === "configure"));
      // 条件が揃えば進み、backend の名前と条件を結果に残す（key は消す）。
      const calls3 = [];
      const { result, reads } = await run({}, calls3, path.join(dir, "w3"));
      assert.equal(reads, 1);
      assert.equal(result.safeStorage.backend, "basic_text");
      assert.equal(result.safeStorage.plainTextAllowed, true);
      assert.equal(calls3.at(-1)[0], "delete-key");
      assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
    } finally {
      delete globalThis.idlRealStorageBackend;
    }
  });
});

test("偽 AI の env（GRIMODEX_PRODUCT_JOURNEY*）が立っていれば本測定の process は止まる（名前だけ数える）", () => {
  assert.deepEqual(
    findForbiddenEnv({
      PATH: "/bin",
      GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1",
      GRIMODEX_PRODUCT_JOURNEY_STREAM_GATE_DIR: "x",
    }),
    [
      "GRIMODEX_PRODUCT_JOURNEY_FAKE_AI",
      "GRIMODEX_PRODUCT_JOURNEY_STREAM_GATE_DIR",
    ],
  );
  assert.throws(
    () =>
      assertNoFakeAiEnv({
        GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1",
      }),
    (e) =>
      /FORBIDDEN_ENV_SET/u.test(e.message) &&
      !e.message.includes("deterministic-v1"),
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
      bAiGate: async () => ({
        policyBlocked: false,
        licenseRestricted: false,
        language: "ja",
      }),
      bPrepare: async () => ({
        rawCount: 150,
        activeCount: 150,
        visibleCount: 150,
        dismissedCount: 0,
        entryCount: 5,
        candidates: [],
      }),
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
      // F2：乾いた実行も、本測定の guard（読み取りだけ）を合成の名簿に対して確かめる。
      bAssertRoleDefaults: async () => ({
        checked: true,
        roleKeysChecked: 7,
        nonDefaultRoleKeys: 0,
        roleProvidersNonDefault: false,
        sendOverrideClear: true,
      }),
      bAssertRosterNotHidden: async () => ({
        checked: true,
        entryCount: 45,
        checkedCount: 45,
        hiddenCount: 0,
      }),
    },
  };
  const page = { evaluate: async (fn, arg) => fn(arg) };
  const out = await dryCellBody({ page });
  assert.deepEqual(out.preconditions.hidden, {
    entryCount: 45,
    checkedCount: 45,
    hiddenCount: 0,
  });
  assert.equal(out.preconditions.role.sendOverrideClear, true);
  assert.deepEqual(
    out.levels.map((l) => l.level),
    ["empty", "L0", "L1", "L2", "L3"],
  );
  assert.ok(
    out.levels.every(
      (l) =>
        l.request.estInputTokens > 0 &&
        l.b1Requests === 3 &&
        l.b2Requests === 3,
    ),
  );
  // 空の名簿の候補数 N0=150 に対する割合：実体 30％＝45、別名の累計 0／10％／20％／30％。
  assert.deepEqual(calls, [
    ["synth", 45, 0],
    ["synth", 45, 15],
    ["synth", 45, 30],
    ["synth", 45, 45],
  ]);
  assert.deepEqual(out.synthetic, {
    entityCount: 45,
    aliasTotals: { L0: 0, L1: 15, L2: 30, L3: 45 },
    candidateCountN0: 150,
  });
  // 乾いた実行でも、hidden があれば cell は失敗する（送る前に分かる）。
  const original = globalThis.window.identityLoad.bAssertRosterNotHidden;
  globalThis.window.identityLoad.bAssertRosterNotHidden = async () => ({
    checked: true,
    entryCount: 45,
    checkedCount: 45,
    hiddenCount: 1,
  });
  await assert.rejects(dryCellBody({ page }), /ROSTER_HAS_HIDDEN/u);
  globalThis.window.identityLoad.bAssertRosterNotHidden = original;
});

test("乾いた実行の採用条件：AI の command・send_chat_message・AI の行・外向き通信が 0", () => {
  const good = {
    ipc: { commandNames: ["codex_create"], commandCounts: { codex_create: 3 } },
    aiRows: { verified: true, tables: { ai_usage: 0, ai_audit_events: 0 } },
    egress: {
      nonLoopbackDestinationCount: 0,
      sampleCount: 4,
      socketCountMax: 6,
    },
  };
  assert.equal(dryCellStatus(good), "ok");
  // 標本が 0、または socket を 1 つも見ていない標本は、何も見ていないのと同じ（F3a の B1。乾いた実行が本測定の観測の事前確認になる）。
  for (const egress of [
    { ...good.egress, sampleCount: 0 },
    { ...good.egress, socketCountMax: 0 },
    { nonLoopbackDestinationCount: 0, sampleCount: 4 },
  ])
    assert.equal(dryCellStatus({ ...good, egress }), "egress-unverified");
  assert.equal(
    dryCellStatus({
      ...good,
      ipc: {
        commandNames: ["send_chat_message"],
        commandCounts: { send_chat_message: 1 },
      },
    }),
    "ai-detected",
  );
  assert.equal(
    dryCellStatus({
      ...good,
      ipc: { commandNames: ["get_ai_settings"], commandCounts: {} },
    }),
    "ai-detected",
  );
  assert.equal(
    dryCellStatus({
      ...good,
      aiRows: { verified: true, tables: { ai_usage: 1 } },
    }),
    "ai-detected",
  );
  assert.equal(
    dryCellStatus({ ...good, aiRows: { verified: false, tables: {} } }),
    "ai-unverified",
  );
  assert.equal(
    dryCellStatus({
      ...good,
      egress: {
        nonLoopbackDestinationCount: 1,
        sampleCount: 4,
        socketCountMax: 6,
      },
    }),
    "egress-detected",
  );
});

/** F2：宛先の許可リストが適用され（標本あり・許可リスト以外が 0）、build の出所が records にある cell の土台。 */
const OK_EGRESS = {
  policyApplied: true,
  sampleCount: 4,
  sampleFailures: 0,
  socketCountMax: 6,
  disallowedDestinations: [],
  nonLoopbackDestinationCount: 1,
  nonLoopbackDestinations: ["tcp 160.79.104.10:443"],
};
const OK_PROVENANCE = {
  head: "a".repeat(40),
  files: [],
  stableAfterCell: true,
};

test("本測定の採用条件：許した AI command だけ・送信回数が IPC と一致", () => {
  const cell = (names, sent) => ({
    ipc: { commandNames: names, commandCounts: { send_chat_message: sent } },
    egress: OK_EGRESS,
    buildProvenance: OK_PROVENANCE,
  });
  assert.equal(
    realCellStatus(
      cell(["get_ai_settings", "save_ai_settings", "send_chat_message"], 3),
      { requestsSent: 3 },
    ),
    "ok",
  );
  assert.equal(
    realCellStatus(cell(["send_chat_message", "send_chat_message_stream"], 3), {
      requestsSent: 3,
    }),
    "unexpected-ai-command",
  );
  assert.equal(
    realCellStatus(cell(["send_chat_message"], 2), { requestsSent: 3 }),
    "send-count-mismatch",
  );
});

test("偽の provider での本測定の経路（B1）：key を入れ、3 要求、surface を確かめ、key を消す", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls });
    const gate = createGate({
      file: path.join(dir, "ledger.jsonl"),
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
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
      egressObservation: () => GOOD_EGRESS,
    });
    assert.equal(value.requestsSent, 3);
    assert.equal(value.result.successCount, 3);
    assert.deepEqual(value.surfaces, {
      ok: true,
      readable: true,
      usageSurfaceCount: 1,
      auditPathCount: 1,
      usageRows: 3,
      successfulRequests: 3,
      usageCoversSuccesses: true,
    });
    assert.equal(
      realCellStatus(
        {
          ipc: { commandNames: [], commandCounts: { send_chat_message: 3 } },
          egress: OK_EGRESS,
          buildProvenance: OK_PROVENANCE,
        },
        value,
      ),
      "ok",
    );
    assert.deepEqual(value.usageModels, { "claude-sonnet-5-5": 3 });
    assert.equal(calls.filter((c) => c[0] === "judge").length, 3);
    assert.deepEqual(calls[0], ["register", 2]);
    assert.deepEqual(calls[1], [
      "configure",
      "anthropic",
      "claude-sonnet-5-5",
      true,
    ]);
    assert.deepEqual(calls.at(-1), ["delete-key"]);
    assert.equal(gate.state.billedRequests, 3);
    // 結果に key・表記の文字列が無い。
    assert.ok(!JSON.stringify(value).includes(FAKE_KEY));
  });
});

test("偽の provider：別の surface の AI 経路が混ざれば、課金したうえで停止し、cell は不採用。それでも key は消す", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({
      workspaceDir,
      calls,
      usageSurface: "chat",
    });
    const gate = createGate({
      file: path.join(dir, "ledger.jsonl"),
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
    const value = await measureBBody({
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
      egressObservation: () => GOOD_EGRESS,
    });
    // surface が chat の行は課金され、停止線（AI_SURFACE_UNEXPECTED）が立つ。結果は残り、cell は不採用。
    assert.equal(value.result.stopped.code, "AI_SURFACE_UNEXPECTED");
    assert.equal(gate.state.stopped.code, "AI_SURFACE_UNEXPECTED");
    assert.equal(gate.state.billedRequests, 1);
    assert.equal(value.surfaces.ok, false);
    assert.equal(
      realCellStatus(
        {
          ipc: { commandNames: [], commandCounts: { send_chat_message: 1 } },
          egress: OK_EGRESS,
          buildProvenance: OK_PROVENANCE,
        },
        value,
      ),
      "ai-surface-set",
    );
    assert.deepEqual(calls.at(-1), ["delete-key"]);
  });
});

test("key は getKey で、検査・登録の後・送信の直前に 1 回だけ読む", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls });
    const gate = createGate({
      file: path.join(dir, "ledger.jsonl"),
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
    let reads = 0;
    await measureBBody({
      page,
      app: null,
      projectId: "p",
      workspaceDir,
      roster,
      level: "L2",
      mode: "trial",
      gate,
      getKey: async () => {
        reads++;
        assert.deepEqual(
          calls.map((c) => c[0]),
          ["register"],
        ); // 登録の後
        return FAKE_KEY;
      },
      expectedSafeStorageCheck: false,
      usagePoll: { timeoutMs: 1000, intervalMs: 5 },
      egressObservation: () => GOOD_EGRESS,
    });
    assert.equal(reads, 1);
  });
});

test("乾いた実行の api は judge・apply を持たない（送信の関数を渡さない）。本測定の api は持つ", () => {
  const page = { evaluate: async () => undefined };
  const dry = bindPageApi({ page, workspaceDir: "x", allowSend: false });
  assert.equal("judge" in dry, false);
  assert.equal("apply" in dry, false);
  assert.equal(typeof dry.prepare, "function");
  const real = bindPageApi({ page, workspaceDir: "x" });
  assert.equal(typeof real.judge, "function");
  assert.equal(typeof real.apply, "function");
  // page 側：bJudge は key を入れた設定（bConfigureAi が key つき）の間だけ送る。
  const renderer = readFileSync(
    new URL("./renderer.ts", import.meta.url),
    "utf8",
  );
  // 止め方（sendArmed が false なら judge を呼ばず not-armed）は runGuardedJudge の振る舞いの試験（lib.test.mjs）。ここは配線。
  assert.match(
    functionBody(renderer, "bJudge"),
    /return runGuardedJudge\(\{\s*\/\/[^\n]*\n\s*sendArmed,/u,
  );
  assert.match(renderer, /sendArmed = Boolean\(input\.key\) && keyPresent/u);
});

test("本文の出る env（GRIMODEX_AI_WIRE_LOG・trace の RUST_LOG）も本測定の process に持ち込まない", () => {
  assert.deepEqual(
    findForbiddenEnv({
      GRIMODEX_AI_WIRE_LOG: "1",
      RUST_LOG: "grimodex_ai=trace",
    }),
    ["GRIMODEX_AI_WIRE_LOG", "RUST_LOG"],
  );
  assert.deepEqual(findForbiddenEnv({ RUST_LOG: "warn" }), []);
  assert.throws(
    () => assertNoFakeAiEnv({ GRIMODEX_AI_WIRE_LOG: "1" }),
    /FORBIDDEN_ENV_SET/u,
  );
  assert.doesNotThrow(() => assertNoFakeAiEnv(process.env));
});

test("他の job（cargo・rustc・Grimodex の electron）の重なりは測定を始めない。自分の子孫と利用者の desktop の electron は数えない", () => {
  const me = process.pid;
  const ps = [
    "    1     0 systemd systemd",
    "  200     1 cargo cargo build",
    "  300     1 node node x.mjs",
    "  400     1 electron electron /repo/dist-electron/main.cjs",
    "  500     1 rustc rustc --crate-name x",
    "  600     1 electron /usr/lib/electron/electron --type=gpu-process",
    `  700   ${me} electron electron /repo/dist-electron/main.cjs`,
    "  710   700 electron electron --type=renderer grimodex",
    `  800   ${me} cargo cargo run`,
  ].join("\n");
  assert.deepEqual(findOverlappingJobs(ps, me), ["cargo", "electron", "rustc"]);
  assert.deepEqual(
    findOverlappingJobs("  1 0 systemd systemd\n  2 1 node n", me),
    [],
  );
  assert.throws(() => assertNoOverlappingJobs(() => ps), /OVERLAPPING_JOBS/u);
  assert.doesNotThrow(() =>
    assertNoOverlappingJobs(
      () => `  1 0 systemd\n  600 1 electron /usr/lib/electron/electron`,
    ),
  );
});

test("kill された run の残り（key-fifo・B の cell）を検出し、signal の後始末は登録した処理を実行する", async () => {
  await withTmp(async (dir) => {
    mkdirSync(path.join(dir, "run", "B-b1-g-ja-2-L2"), { recursive: true });
    mkdirSync(path.join(dir, "run", "B-dry-g-ja-2"), { recursive: true });
    mkdirSync(path.join(dir, "key-fifo-abc"), { recursive: true });
    assert.deepEqual(
      findKeyResidue(dir),
      ["key-fifo-abc", "B-b1-g-ja-2-L2"].sort(),
    );
    assert.deepEqual(findKeyResidue(path.join(dir, "none")), []);
    let ran = 0;
    const off = registerCleanup(() => ran++);
    const kept = registerCleanup(() => ran++);
    off(); // 通常の後始末の後は登録を外す
    runCleanups();
    assert.equal(ran, 1);
    void kept;
  });
});

test("records・出力に、key の形の値が混ざっていれば拒む（欄名でなく値の形。失敗経路の混入も）", () => {
  assert.equal(findUnsafeStrings({ a: FAKE_KEY }).length, 1);
  assert.equal(findUnsafeStrings({ [FAKE_KEY]: "x" }).length, 1);
  assert.equal(findUnsafeStrings({ a: "sk-" + "z".repeat(24) }).length, 1);
  assert.equal(findUnsafeStrings({ a: "task-1 desk" }).length, 0);
  assert.throws(
    () =>
      assertRecordsClean({ cells: [{ errors: [`failed with ${FAKE_KEY}`] }] }),
    /RECORDS_UNCLEAN/u,
  );
  // 本測定の失敗の cell の記録（safeErrorSummary）にも、key の値は載らない。
  assert.ok(
    !JSON.stringify(safeErrorSummary(new Error(`bad ${FAKE_KEY}`))).includes(
      FAKE_KEY,
    ),
  );
});

test("偽の provider（B2）：模擬作者が名簿どおりに進め、ceil(N/50) 要求", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({
      workspaceDir,
      calls,
      candidateCount: 120,
    });
    const gate = createGate({
      file: path.join(dir, "ledger.jsonl"),
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
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
      egressObservation: () => GOOD_EGRESS,
    });
    assert.equal(value.requestsSent, 3);
    assert.equal(value.result.plannedIterations, 3);
    assert.equal(value.result.finalVisibleCount, 0);
    // 名簿（全段）で e1 の別名 c000・c001 は、登録が L2 でも名簿どおりに e1 への別名にする。残りは名簿に無く却下。
    assert.equal(value.result.decisionCounts.alias, 2);
    assert.equal(value.result.dismissReasons.unlisted, 118);
  });
});

test("乾いた実行の summary の前提の文は、出力の混入検査（ASCII の識別子の形・key の形なし）を通る", () => {
  assert.deepEqual(findUnsafeStrings(DRY_RUN_ASSUMPTIONS), []);
  assert.ok(Object.keys(DRY_RUN_ASSUMPTIONS).includes("entryOrderAndIds"));
});

// ---- F2：送る前の guard（役割の上書き・名簿の hidden・宛先・build の出所） ----------------------

/** guards を差し替えた fake の page で measureBBody を動かす。key は getKey で読み、読んだ回数を返す。 */
async function runGuarded(
  dir,
  {
    guards = {},
    egressObservation = () => GOOD_EGRESS,
    mode = "b1",
    expectedEntries,
  } = {},
) {
  const calls = [];
  const workspaceDir = path.join(dir, "workspace");
  const { page } = await installFakeWindow({
    workspaceDir,
    calls,
    guards: { log: calls, ...guards },
  });
  const gate = createGate({
    file: path.join(dir, "ledger.jsonl"),
    model: "claude-sonnet-5-5",
    pricing: PRICING,
    requireTrial: false,
  });
  let reads = 0;
  let value = null;
  let error = null;
  try {
    value = await measureBBody({
      page,
      app: null,
      projectId: "p",
      workspaceDir,
      roster,
      level: "L2",
      mode,
      gate,
      getKey: async () => {
        reads++;
        return FAKE_KEY;
      },
      expectedSafeStorageCheck: false,
      usagePoll: { timeoutMs: 1000, intervalMs: 5 },
      egressObservation,
      ...(expectedEntries ? {} : {}),
    });
  } catch (caught) {
    error = caught;
  }
  return { value, error, calls, gate, reads, page };
}
const judgeCount = (calls) => calls.filter((c) => c[0] === "judge").length;

test("送る前の guard：通れば結果に件数だけ残し、guard は key を読む前に走る。key は 1 回だけ読む", async () => {
  await withTmp(async (dir) => {
    const { value, error, calls, reads } = await runGuarded(dir);
    assert.equal(error, null);
    assert.equal(reads, 1);
    assert.deepEqual(value.preconditions.role, {
      roleKeysChecked: 7,
      nonDefaultRoleKeys: 0,
      roleProvidersNonDefault: false,
      sendOverrideClear: true,
    });
    assert.deepEqual(value.preconditions.hidden, {
      entryCount: 2,
      checkedCount: 2,
      hiddenCount: 0,
    });
    // 3 要求の直前それぞれにも確かめる。
    assert.equal(value.preconditions.sendGuardChecks, 3);
    assert.equal(judgeCount(calls), 3);
    const firstConfigure = calls.findIndex((c) => c[0] === "configure");
    const firstAssert = calls.findIndex((c) => c[0] === "assert-role");
    assert.ok(firstAssert >= 0 && firstAssert < firstConfigure);
    // 新しい欄（HEAD・sha256・宛先の IP 形の文字列）が、出力の検査を通る。
    const record = {
      observed: {
        buildProvenance: {
          head: "a".repeat(40),
          recordedAt: "2026-11-23T01:02:03.000Z",
          files: [
            { path: "dist-electron/main.cjs", sha256: "b".repeat(64) },
            {
              path: "electron/native/grimodex-node/grimodex-node.node",
              sha256: "c".repeat(64),
            },
          ],
        },
        egress: {
          ...OK_EGRESS,
          nonLoopbackDestinations: [
            "tcp 160.79.104.10:443",
            "tcp 2607:6bc0:0:0:0:0:0:1:443",
          ],
          policy: { allowCidrs: ["160.79.104.0/23", "2607:6bc0::/48"] },
        },
      },
      value,
    };
    assert.deepEqual(findUnsafeStrings(record), []);
    assertOutputClean(record, ["彼は静かに歩いた。".repeat(3)]);
  });
});

test("名簿に hidden があれば、key を読まず設定もせず送らない。判定が返らない・形が違うときも止まる", async () => {
  for (const [guards, pattern] of [
    [
      {
        hidden: {
          checked: true,
          entryCount: 2,
          checkedCount: 2,
          hiddenCount: 1,
        },
      },
      /ROSTER_HAS_HIDDEN/u,
    ],
    [{ hiddenThrows: true }, /ROSTER_HIDDEN_UNDECIDABLE/u],
    [{ hidden: { checked: false } }, /ROSTER_HIDDEN_UNDECIDABLE/u],
    // 調べた数が Entry の数と違う、登録した数と違うのも判定できない。
    [
      {
        hidden: {
          checked: true,
          entryCount: 2,
          checkedCount: 1,
          hiddenCount: 0,
        },
      },
      /ROSTER_HIDDEN_UNDECIDABLE/u,
    ],
    [
      {
        hidden: {
          checked: true,
          entryCount: 3,
          checkedCount: 3,
          hiddenCount: 0,
        },
      },
      /ROSTER_HIDDEN_UNDECIDABLE/u,
    ],
  ]) {
    await withTmp(async (dir) => {
      const { error, calls, reads } = await runGuarded(dir, { guards });
      assert.match(String(error?.message), pattern);
      assert.equal(reads, 0);
      assert.ok(!calls.some((c) => c[0] === "configure" || c[0] === "judge"));
    });
  }
});

test("役割の上書きが空・既定でなければ、key を読まず送らない。設定が読めない・形が違うときも止まる", async () => {
  const base = {
    checked: true,
    roleKeysChecked: 7,
    nonDefaultRoleKeys: 0,
    roleProvidersNonDefault: false,
    sendOverrideClear: true,
  };
  for (const [guards, pattern] of [
    [
      { role: { ...base, nonDefaultRoleKeys: 1 } },
      /ROLE_OVERRIDE_NOT_DEFAULT/u,
    ],
    [
      { role: { ...base, roleProvidersNonDefault: true } },
      /ROLE_OVERRIDE_NOT_DEFAULT/u,
    ],
    [
      { role: { ...base, sendOverrideClear: false } },
      /ROLE_OVERRIDE_NOT_DEFAULT/u,
    ],
    [{ roleThrows: true }, /ROLE_OVERRIDE_UNDECIDABLE/u],
    [{ role: { ...base, roleKeysChecked: 3 } }, /ROLE_OVERRIDE_UNDECIDABLE/u],
  ]) {
    await withTmp(async (dir) => {
      const { error, calls, reads } = await runGuarded(dir, { guards });
      assert.match(String(error?.message), pattern);
      assert.equal(reads, 0);
      assert.ok(!calls.some((c) => c[0] === "configure" || c[0] === "judge"));
    });
  }
});

test("許可リスト以外の宛先の観測が cell の頭にあれば、key を読まず送らない", async () => {
  await withTmp(async (dir) => {
    const { error, reads, calls } = await runGuarded(dir, {
      egressObservation: () => ({
        ...GOOD_EGRESS,
        violations: ["tcp 203.0.113.5:443"],
      }),
    });
    assert.match(String(error?.message), /EGRESS_NOT_ALLOWED/u);
    assert.equal(reads, 0);
    assert.equal(judgeCount(calls), 0);
  });
});

test("送信の途中で宛先・役割・hidden が崩れたら、次の送信は出ない（停止線が立ち、cell は budget-stopped）", async () => {
  const brokenRole = {
    checked: true,
    roleKeysChecked: 7,
    nonDefaultRoleKeys: 1,
    roleProvidersNonDefault: false,
    sendOverrideClear: true,
  };
  for (const [kind, code] of [
    ["egress", "EGRESS_NOT_ALLOWED"],
    ["role", "ROLE_OVERRIDE_NOT_DEFAULT"],
    ["hidden", "ROSTER_HAS_HIDDEN"],
    ["roleUndecidable", "ROLE_OVERRIDE_UNDECIDABLE"],
  ]) {
    await withTmp(async (dir) => {
      // 1 要求目の bJudge が返った後に崩す。
      const state = { judged: 0 };
      const after = (value) => () => (state.judged > 0 ? value : undefined);
      const guards = {
        role:
          kind === "role"
            ? after(brokenRole)
            : kind === "roleUndecidable"
              ? after({ checked: false })
              : undefined,
        hidden:
          kind === "hidden"
            ? after({
                checked: true,
                entryCount: 2,
                checkedCount: 2,
                hiddenCount: 1,
              })
            : undefined,
      };
      const calls = [];
      const workspaceDir = path.join(dir, "workspace");
      const { page } = await installFakeWindow({
        workspaceDir,
        calls,
        guards,
      });
      const originalJudge = globalThis.window.identityLoad.bJudge;
      globalThis.window.identityLoad.bJudge = async () => {
        const result = await originalJudge();
        state.judged++;
        return result;
      };
      const gate = createGate({
        file: path.join(dir, "ledger.jsonl"),
        model: "claude-sonnet-5-5",
        pricing: PRICING,
        requireTrial: false,
      });
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
        egressObservation: () => ({
          ...GOOD_EGRESS,
          violations:
            kind === "egress" && state.judged > 0
              ? ["tcp 203.0.113.5:443"]
              : [],
        }),
      });
      assert.equal(judgeCount(calls), 1, kind);
      assert.equal(value.requestsSent, 1, kind);
      assert.equal(value.result.stopped.code, code, kind);
      assert.equal(gate.state.stopped.code, code, kind);
      assert.equal(
        realCellStatus(
          {
            ipc: { commandNames: [], commandCounts: { send_chat_message: 1 } },
            egress: OK_EGRESS,
            buildProvenance: OK_PROVENANCE,
          },
          value,
        ),
        "budget-stopped",
        kind,
      );
      assert.deepEqual(calls.at(-1), ["delete-key"]);
    });
  }
});

test("page に guard の関数が無ければ止まる（関数が無いのを skip しない）", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls });
    delete globalThis.window.identityLoad.bAssertRosterNotHidden;
    const gate = createGate({
      file: path.join(dir, "ledger.jsonl"),
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
    let reads = 0;
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
        getKey: async () => {
          reads++;
          return FAKE_KEY;
        },
        expectedSafeStorageCheck: false,
        usagePoll: { timeoutMs: 1000, intervalMs: 5 },
        egressObservation: () => GOOD_EGRESS,
      }),
      /ROSTER_HIDDEN_UNDECIDABLE/u,
    );
    assert.equal(reads, 0);
    assert.equal(judgeCount(calls), 0);
    // 宛先の観測の関数を渡さなければ、これも送らない。
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
        usagePoll: { timeoutMs: 1000, intervalMs: 5 },
      }),
      /EGRESS_GUARD_MISSING/u,
    );
  });
});

test("実測定の採用条件：許可リストが適用され標本があり許可リスト以外が 0、build の出所が records にあること", () => {
  const base = {
    ipc: { commandNames: [], commandCounts: { send_chat_message: 1 } },
    egress: OK_EGRESS,
    buildProvenance: OK_PROVENANCE,
  };
  const value = { requestsSent: 1 };
  assert.equal(realCellStatus(base, value), "ok");
  // 許可リストが適用されていない（policy なしの cell）／標本が 0／標本が全部失敗した cell は確かめられない。
  assert.equal(
    realCellStatus(
      { ...base, egress: { ...OK_EGRESS, policyApplied: false } },
      value,
    ),
    "egress-unverified",
  );
  assert.equal(
    realCellStatus(
      { ...base, egress: { ...OK_EGRESS, sampleCount: 0 } },
      value,
    ),
    "egress-unverified",
  );
  assert.equal(
    realCellStatus({ ...base, egress: undefined }, value),
    "egress-unverified",
  );
  // 許可リスト以外の宛先があれば不採用（Anthropic の宛先が記録に残るだけでは不採用にしない）。
  assert.equal(
    realCellStatus(
      {
        ...base,
        egress: {
          ...OK_EGRESS,
          disallowedDestinations: ["tcp 203.0.113.5:443"],
        },
      },
      value,
    ),
    "egress-detected",
  );
  assert.equal(
    realCellStatus({ ...base, buildProvenance: undefined }, value),
    "build-unverified",
  );
  assert.equal(
    realCellStatus({ ...base, buildProvenance: { head: "main" } }, value),
    "build-unverified",
  );
  // socket を 1 つも見ていない標本は、何も見ていないのと同じ（F3a の B1）。
  for (const egress of [
    { ...OK_EGRESS, socketCountMax: 0 },
    { ...OK_EGRESS, socketCountMax: undefined },
  ])
    assert.equal(
      realCellStatus({ ...base, egress }, value),
      "egress-unverified",
    );
  // cell の後の出所の照合が揃っていない（cell の間に build 物・guard の file が変わった・照合できなかった）。
  for (const stableAfterCell of [false, undefined])
    assert.equal(
      realCellStatus(
        { ...base, buildProvenance: { ...OK_PROVENANCE, stableAfterCell } },
        value,
      ),
      "build-unverified",
    );
});

test("本測定は、許可リストと build の出所が無ければ cell も key も使わずに止まる（本物の launcher を呼ばない形の確認）", () => {
  const source = readFileSync(
    new URL("./run-measure-b.mjs", import.meta.url),
    "utf8",
  );
  const main = source.slice(source.indexOf("async function mainReal"));
  const provenance = main.indexOf("assertBuildProvenance({ root: ROOT })");
  const policy = main.indexOf("buildEgressPolicy({");
  const receive = main.indexOf("receiveRealEnv(");
  const getKey = main.indexOf("makeKeyGetter(");
  const gateStart = main.indexOf("createGate({");
  const vite = main.indexOf("withVite(");
  // 許可リストは FIFO の受け取りの前、build の出所の照合（数秒）は受け取りの後。どちらも gate（台帳）・cell・key より前。
  assert.ok(policy > 0 && receive > policy);
  assert.ok(provenance > receive && gateStart > provenance);
  assert.ok(vite > gateStart && getKey > vite);
  assert.match(main, /egressPolicy,\n\s+keep: false/u);
});

// ---- F3a：宛先の観測・watchdog・key の後始末・env ------------------------------------------------------------------

/** 本物の標本（createEgressSampler）に fake の sample をつなぎ、launcher と同じ形（同期で 1 回 tick して観測を返す）の観測の関数を作る。 */
function samplerObservation(sample, { now } = {}) {
  const sampler = createEgressSampler({
    rootPid: 1,
    policy: null,
    sample,
    ...(now ? { now } : {}),
  });
  return {
    sampler,
    observe: () => {
      sampler.tick();
      return sampler.observation();
    },
  };
}

test("宛先の観測が成り立っていなければ（標本が採れない・socket が 0・古い tick）、cell の頭で key を読まず・設定せず・1 回も送らない（F3a の B1）", async () => {
  let clock = 0;
  const stale = samplerObservation(() => ({ tablesRead: 4, socketCount: 3 }), {
    now: () => clock,
  });
  stale.sampler.tick();
  clock = 60_000; // 直近の tick から 60 s（tick せずに観測だけ返す）
  for (const [name, observe, code] of [
    [
      "sample が throw する",
      samplerObservation(() => {
        throw new Error("x");
      }).observe,
      "EGRESS_UNOBSERVED",
    ],
    [
      "表が 1 つも読めない（tablesRead 0）",
      samplerObservation(() => ({ tablesRead: 0, socketCount: 3 })).observe,
      "EGRESS_UNOBSERVED",
    ],
    [
      "結果が無い",
      samplerObservation(() => undefined).observe,
      "EGRESS_UNOBSERVED",
    ],
    [
      "socket を 1 つも見ていない",
      samplerObservation(() => ({ tablesRead: 4, socketCount: 0 })).observe,
      "EGRESS_NO_SOCKETS",
    ],
    ["古い tick", () => stale.sampler.observation(), "EGRESS_STALE"],
  ]) {
    await withTmp(async (dir) => {
      const { error, calls, reads, gate } = await runGuarded(dir, {
        egressObservation: observe,
      });
      assert.match(String(error?.message), new RegExp(code, "u"), name);
      assert.equal(reads, 0, name);
      assert.equal(judgeCount(calls), 0, name);
      assert.ok(!calls.some((c) => c[0] === "configure"), name);
      assert.equal(gate.state.reserved, 0, name);
    });
  }
});

test("宛先の観測が送信の途中で成り立たなくなったら（標本が失敗・socket が 0）、次の送信は出ない。停止線が立ち、cell は budget-stopped（F3a の B1）", async () => {
  for (const [name, bad, code] of [
    [
      "sample が throw する",
      () => {
        throw new Error("x");
      },
      "EGRESS_SAMPLE_FAILED",
    ],
    [
      "tablesRead 0",
      () => ({ tablesRead: 0, socketCount: 3 }),
      "EGRESS_SAMPLE_FAILED",
    ],
    [
      "socket 0",
      () => ({ tablesRead: 4, socketCount: 0 }),
      "EGRESS_NO_SOCKETS",
    ],
  ]) {
    await withTmp(async (dir) => {
      // tick の 1 回目（cell の頭）・2 回目（1 要求目の直前）は正常、3 回目（2 要求目の直前）から崩れる。
      let ticks = 0;
      const { observe } = samplerObservation((pid, destinations) => {
        ticks++;
        return ticks <= 2
          ? { tablesRead: 4, socketCount: 3 }
          : bad(destinations);
      });
      const { value, error, calls, gate } = await runGuarded(dir, {
        egressObservation: observe,
      });
      assert.equal(error, null, name);
      assert.equal(judgeCount(calls), 1, name);
      assert.equal(value.requestsSent, 1, name);
      assert.equal(value.result.stopped.code, code, name);
      assert.equal(gate.state.stopped.code, code, name);
      // 2 要求目の予約は取り消されている（送っていない）。
      assert.equal(gate.state.reserved, 0, name);
      assert.deepEqual(calls.at(-1), ["delete-key"], name);
    });
  }
});

test("key を出力しうる debug 系の env（DEBUG・PWDEBUG・NODE_DEBUG・ELECTRON_ENABLE_LOGGING・inspector）が立っていれば本測定の process は止まる（F3a の M1）", () => {
  for (const env of [
    { DEBUG: "pw:protocol" },
    { DEBUG: "*" },
    { PWDEBUG: "1" },
    { NODE_DEBUG: "http" },
    { NODE_DEBUG_NATIVE: "http" },
    { ELECTRON_ENABLE_LOGGING: "1" },
    { ELECTRON_ENABLE_STACK_DUMPING: "1" },
    { NODE_OPTIONS: "--inspect=0" },
    { NODE_OPTIONS: "--max-old-space-size=4096 --inspect-brk" },
  ]) {
    const [name] = Object.keys(env);
    assert.deepEqual(findForbiddenEnv({ PATH: "/bin", ...env }), [name], name);
    assert.throws(() => assertNoFakeAiEnv(env), /FORBIDDEN_ENV_SET 1/u, name);
  }
  // 無害な NODE_OPTIONS は止めない。値は表示しない（名前だけ数える）。
  assert.deepEqual(
    findForbiddenEnv({ NODE_OPTIONS: "--max-old-space-size=4096" }),
    [],
  );
  try {
    assertNoFakeAiEnv({ DEBUG: "pw:protocol-secret-marker" });
    assert.fail("not thrown");
  } catch (error) {
    assert.ok(!String(error.message).includes("secret-marker"));
  }
  // 本物の launcher（run-measure-b.mjs）が、許可リスト・FIFO・key より前に止まる。子 process で動かす（Electron・network は使わない）。
  for (const env of [
    { DEBUG: "pw:protocol" },
    { NODE_OPTIONS: "--inspect=0" },
  ]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "idl-env-"));
    try {
      const child = spawnSync(
        process.execPath,
        [
          new URL("./run-measure-b.mjs", import.meta.url).pathname,
          "--mode",
          "trial",
          "--confirm-send",
          CONFIRM_SEND,
          "--output",
          dir,
        ],
        {
          env: { PATH: process.env.PATH ?? "", ...env },
          encoding: "utf8",
        },
      );
      const out = JSON.parse(child.stdout.trim().split("\n").at(-1));
      assert.equal(out.status, "launcher-failed");
      assert.ok(out.codes.includes("FORBIDDEN_ENV_SET"), JSON.stringify(env));
      assert.notEqual(child.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("watchdog（F3a の m2）：定数は IPC の AI 用の上限と同じ。期限までに返らなければ失敗として返し、timer を止め、元の promise の遅れた reject を握りつぶす", async () => {
  // IPC の AI 用の caller timeout（electron/shared/ipcCallerTimeouts.ts）と同じ値（send_chat_message には caller の timeout が無い）。
  const source = readFileSync(
    new URL("../../../electron/shared/ipcCallerTimeouts.ts", import.meta.url),
    "utf8",
  );
  const declared = /AI_IPC_TIMEOUT_MS\s*=\s*([0-9_]+)/u.exec(source)?.[1];
  assert.equal(Number(declared.replaceAll("_", "")), JUDGE_WATCHDOG_MS);
  assert.ok(KEY_REMOVAL_TIMEOUT_MS > 0 && KEY_REMOVAL_TIMEOUT_MS <= 120_000);
  // 期限前に返れば、その値。timer は止まる。
  const timers = [];
  const fakeTimers = {
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
  };
  assert.equal(
    await withWatchdog(Promise.resolve("done"), 50, () => "late", fakeTimers),
    "done",
  );
  assert.equal(timers[0].cleared, true);
  // 期限が来たら onTimeout の値。元の promise が後から reject しても未処理の reject にならない。
  let rejectLate;
  const hung = new Promise((_, reject) => {
    rejectLate = reject;
  });
  const waiting = withWatchdog(hung, 50, () => "timeout", fakeTimers);
  timers[1].fn();
  assert.equal(await waiting, "timeout");
  assert.equal(timers[1].cleared, true);
  rejectLate(new Error("late"));
  await new Promise((resolve) => setImmediate(resolve));
  // 期限前の reject は、同じ例外で reject。onTimeout が throw するなら reject。
  await assert.rejects(
    withWatchdog(Promise.reject(new Error("boom")), 50, () => "x", fakeTimers),
    /boom/u,
  );
  const throwing = withWatchdog(
    new Promise(() => undefined),
    50,
    () => {
      throw new Error("deadline");
    },
    fakeTimers,
  );
  timers.at(-1).fn();
  await assert.rejects(throwing, /deadline/u);
});

test("page の bJudge が期限までに返らなければ（watchdog-timeout）、届いたか分からない失敗として最大の見積りで課金し、停止線を立て、key を消す（F3a の m2）", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls });
    globalThis.window.identityLoad.bJudge = () => {
      calls.push(["judge"]);
      return new Promise(() => undefined); // 止まったまま返らない
    };
    const gate = createGate({
      file: path.join(dir, "ledger.jsonl"),
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
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
      usagePoll: { timeoutMs: 200, intervalMs: 5 },
      egressObservation: () => GOOD_EGRESS,
      judgeWatchdogMs: 20,
    });
    // 1 要求目で止まり、再送も 2・3 要求目も出ない。
    assert.equal(judgeCount(calls), 1);
    assert.equal(
      value.result.stopped.code,
      "WATCHDOG_TIMEOUT_REQUEST_MAY_BE_IN_FLIGHT",
    );
    assert.equal(
      gate.state.stopped.code,
      "WATCHDOG_TIMEOUT_REQUEST_MAY_BE_IN_FLIGHT",
    );
    // 台帳には行が残り、usage が無いので最大の見積りで課金されている。
    const rows = readFileSync(path.join(dir, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.type !== "STOP");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].charge, "estimate");
    assert.ok(rows[0].usd > 0);
    // key は消す（finally）。
    assert.deepEqual(calls.at(-1), ["delete-key"]);
    assert.equal(
      realCellStatus(
        {
          ipc: { commandNames: [], commandCounts: { send_chat_message: 1 } },
          egress: OK_EGRESS,
          buildProvenance: OK_PROVENANCE,
        },
        value,
      ),
      "budget-stopped",
    );
  });
});

test("key を消す呼び出しが止まっても、期限で諦めて cell の後始末へ進む。元の例外は隠さない（F3a の m2・m7）", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls });
    globalThis.window.identityLoad.bDeleteKey = () =>
      new Promise(() => undefined);
    const gate = createGate({
      file: path.join(dir, "ledger.jsonl"),
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
    const run = (dirOfRun = workspaceDir) =>
      measureBBody({
        page,
        app: null,
        projectId: "p",
        workspaceDir: dirOfRun,
        roster,
        level: "L2",
        mode: "trial",
        gate,
        key: FAKE_KEY,
        expectedSafeStorageCheck: false,
        usagePoll: { timeoutMs: 200, intervalMs: 5 },
        egressObservation: () => GOOD_EGRESS,
        keyRemovalTimeoutMs: 20,
      });
    // 送信は成功したが、key の削除が返らない：期限の後に失敗として返る（cell は失敗。残りは cell の後始末と key の残りの検査）。
    await assert.rejects(run(), /KEY_REMOVAL_TIMEOUT/u);
    // 途中で別の例外が出ていたなら、削除の失敗でそれを隠さない（新しい page で、削除は止まったまま）。
    const second = path.join(dir, "workspace-2");
    await installFakeWindow({ workspaceDir: second, calls: [] });
    globalThis.window.identityLoad.bDeleteKey = () =>
      new Promise(() => undefined);
    globalThis.window.identityLoad.bConfigureAi = async () => {
      throw new Error("[artifact] CONFIGURE_FAILED after save");
    };
    await assert.rejects(run(second), /CONFIGURE_FAILED/u);
  });
});

test("key を入れる途中で失敗しても（保存の後に throw）、key の削除を通す（F3a の m7）。getKey の失敗は key に触れていないので削除しない", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls });
    globalThis.window.identityLoad.bConfigureAi = async (input) => {
      calls.push(["configure", input.key === FAKE_KEY]);
      throw new Error("[artifact] CONFIGURE_FAILED after save");
    };
    const gate = createGate({
      file: path.join(dir, "ledger.jsonl"),
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
    const base = {
      page,
      app: null,
      projectId: "p",
      workspaceDir,
      roster,
      level: "L2",
      mode: "trial",
      gate,
      expectedSafeStorageCheck: false,
      usagePoll: { timeoutMs: 200, intervalMs: 5 },
      egressObservation: () => GOOD_EGRESS,
    };
    await assert.rejects(
      measureBBody({ ...base, key: FAKE_KEY }),
      /CONFIGURE_FAILED/u,
    );
    assert.deepEqual(
      calls.filter((c) => ["configure", "delete-key", "judge"].includes(c[0])),
      [["configure", true], ["delete-key"]],
    );
    // key の取得（FIFO）が失敗した：key を入れていないので、削除も送信もしない（新しい page・新しい名簿で）。
    const second = path.join(dir, "workspace-2");
    const secondCalls = [];
    await installFakeWindow({ workspaceDir: second, calls: secondCalls });
    await assert.rejects(
      measureBBody({
        ...base,
        workspaceDir: second,
        getKey: async () => {
          throw new Error("[precheck] HANDOFF_NOT_RECEIVED");
        },
      }),
      /HANDOFF_NOT_RECEIVED/u,
    );
    assert.ok(
      !secondCalls.some((c) =>
        ["configure", "delete-key", "judge"].includes(c[0]),
      ),
    );
  });
});

test("judge が例外を投げても（page の crash）台帳に行が残り、最大の見積りで課金され、停止線が立ち、key を消す。送る直前の guard の停止は予約を取り消す（F3a の M2）", async () => {
  await withTmp(async (dir) => {
    const calls = [];
    const workspaceDir = path.join(dir, "workspace");
    const { page } = await installFakeWindow({ workspaceDir, calls });
    globalThis.window.identityLoad.bJudge = async () => {
      calls.push(["judge"]);
      throw new Error("Target page, context or browser has been closed");
    };
    const file = path.join(dir, "ledger.jsonl");
    const gate = createGate({
      file,
      model: "claude-sonnet-5-5",
      pricing: PRICING,
      requireTrial: false,
    });
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
      usagePoll: { timeoutMs: 200, intervalMs: 5 },
      egressObservation: () => GOOD_EGRESS,
    });
    assert.equal(judgeCount(calls), 1);
    assert.equal(
      value.result.stopped.code,
      "JUDGE_ERROR_REQUEST_MAY_BE_IN_FLIGHT",
    );
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.type !== "STOP");
    assert.deepEqual(
      rows.map((r) => [r.failure_kind, r.charge, r.billed]),
      [["judge-error", "estimate", false]],
    );
    assert.ok(gate.state.total > 0);
    assert.deepEqual(calls.at(-1), ["delete-key"]);
    // 例外の文面は台帳にも結果にも出ない。
    assert.ok(!readFileSync(file, "utf8").includes("Target page"));
    assert.ok(!JSON.stringify(value).includes("Target page"));
  });
  // 送る直前の guard（beforeSend）が止めた回は、送っていないので予約が残らない。
  await withTmp(async (dir) => {
    const { value, calls, gate } = await runGuarded(dir, {
      egressObservation: (() => {
        let n = 0;
        return () => ({
          ...GOOD_EGRESS,
          violations: ++n >= 3 ? ["tcp 203.0.113.5:443"] : [],
        });
      })(),
    });
    assert.equal(judgeCount(calls), 1);
    assert.equal(value.result.stopped.code, "EGRESS_NOT_ALLOWED");
    assert.equal(gate.state.reserved, 0);
    assert.ok(gate.state.stopped);
    assert.ok(BudgetStop);
  });
});
