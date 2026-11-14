// 測定 B の launcher の試験。偽の provider（page 側の bJudge を差し替える）と合成の sqlite で、
// 本測定の経路（key の導入→要求→ai_usage→surface の確認→key の削除）と、乾いた実行が送らないことを確かめる。
// Anthropic へは送らない。key・keyring・Electron は使わない。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { createGate } from "./ledger.mjs";
import { candidateKey, hashSurface, safeErrorSummary } from "./lib.mjs";
import {
  CONFIRM_SEND,
  DRY_RUN_ASSUMPTIONS,
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
    },
  };
  const page = { evaluate: async (fn, arg) => fn(arg) };
  const out = await dryCellBody({ page });
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
});

test("乾いた実行の採用条件：AI の command・send_chat_message・AI の行・外向き通信が 0", () => {
  const good = {
    ipc: { commandNames: ["codex_create"], commandCounts: { codex_create: 3 } },
    aiRows: { verified: true, tables: { ai_usage: 0, ai_audit_events: 0 } },
    egress: { nonLoopbackDestinationCount: 0, sampleCount: 4 },
  };
  assert.equal(dryCellStatus(good), "ok");
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
      egress: { nonLoopbackDestinationCount: 1, sampleCount: 4 },
    }),
    "egress-detected",
  );
});

test("本測定の採用条件：許した AI command だけ・送信回数が IPC と一致", () => {
  const cell = (names, sent) => ({
    ipc: { commandNames: names, commandCounts: { send_chat_message: sent } },
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
        { ipc: { commandNames: [], commandCounts: { send_chat_message: 3 } } },
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
    });
    // surface が chat の行は課金され、停止線（AI_SURFACE_UNEXPECTED）が立つ。結果は残り、cell は不採用。
    assert.equal(value.result.stopped.code, "AI_SURFACE_UNEXPECTED");
    assert.equal(gate.state.stopped.code, "AI_SURFACE_UNEXPECTED");
    assert.equal(gate.state.billedRequests, 1);
    assert.equal(value.surfaces.ok, false);
    assert.equal(
      realCellStatus(
        { ipc: { commandNames: [], commandCounts: { send_chat_message: 1 } } },
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
  assert.match(
    renderer,
    /if \(!sendArmed\)\s+return \{ ok: false as const, kind: "not-armed"/u,
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
