// 測定 B の中身の試験（fake の api・合成の名簿。AI・Electron は使わない）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BudgetStop, createGate } from "./ledger.mjs";
import { buildRosterIndex } from "./measure-a-metrics.mjs";
import {
  MAX_CANDIDATES,
  assertAiGate,
  assertEntriesWithinWindow,
  assertEstimateMatches,
  assertOnlyCodexJudgment,
  authorDecision,
  buildDryRunPlan,
  buildProjectedPlan,
  projectRequest,
  dryMeasure,
  judgmentMetrics,
  readUsageForRequest,
  runB1,
  runB2,
  selfAgreement,
  sendOne,
  truncateRosterForB,
  typeMatches,
} from "./measure-b-core.mjs";

const ident = async (s) => s;
const PRICING = { inputPerMillion: 2, outputPerMillion: 10 };
const roster = {
  entities: [
    {
      id: "e1",
      type: "character",
      name: "n1",
      aliases: [
        { surface: "c000", level: "L2" },
        { surface: "c001", level: "L2" },
        { surface: "c002", level: "L3" },
      ],
      honorificSurfaces: ["c004"],
    },
    {
      id: "e2",
      type: "location",
      name: "n2",
      aliases: [{ surface: "c003", level: "L3" }],
    },
    {
      id: "e3",
      type: "other",
      name: "n3",
      aliases: [{ surface: "c005", level: "L3" }],
    },
  ],
};

function tmpGate(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-b-"));
  const gate = createGate({
    file: path.join(dir, "ledger.jsonl"),
    model: "claude-sonnet-5-5",
    pricing: PRICING,
    ...overrides,
  });
  return { dir, gate };
}

/** 画面と AI を模した fake。judge の応答は script で差し替える。 */
function fakeApi({ candidateCount = 120, script = null, entryCount = 3 } = {}) {
  const state = {
    visible: Array.from({ length: candidateCount }, (_, i) => ({
      keyHash: `c${String(i).padStart(3, "0")}`,
      count: 100 - i,
      firstSceneIndex: 1,
    })),
    usageRows: [],
    judgeCalls: 0,
    applied: [],
    entries: entryCount,
  };
  const prepared = () => ({
    rawCount: candidateCount,
    activeCount: state.visible.length,
    visibleCount: state.visible.length,
    dismissedCount: 0,
    entryCount: state.entries,
    candidates: state.visible.map((c) => ({ ...c })),
  });
  const api = {
    state,
    gate: async () => ({
      policyBlocked: false,
      licenseRestricted: false,
      language: "ja",
    }),
    prepare: async () => prepared(),
    estimate: async () => ({
      judgedSlots: Math.min(state.visible.length, 50),
      entrySlots: Math.min(state.entries, 200),
      entryAliasCount: 6,
      contextChars: 3000,
      promptChars: 9000,
      promptNonAsciiChars: 6000,
    }),
    judge: async () => {
      state.judgeCalls++;
      const step = script ? script(state.judgeCalls) : { ok: true };
      if (!step.ok)
        return {
          ok: false,
          kind: step.kind,
          httpStatus: step.httpStatus ?? null,
          durationMs: 5,
        };
      if (step.usage !== false)
        state.usageRows.push(
          step.usage ?? {
            surface: "codex_judgment",
            model: "claude-sonnet-5-5",
            tokens_in: 9000,
            tokens_out: Math.min(state.visible.length, 50) * 80,
          },
        );
      const judgments = state.visible.slice(0, 50).map((c) => ({
        keyHash: c.keyHash,
        suggestedType: "character",
        aliasOfId:
          c.keyHash === "c000" || c.keyHash === "c001"
            ? "e1"
            : c.keyHash === "c002"
              ? "e2"
              : null,
        aliasKnown: true,
      }));
      return { ok: true, judgments, durationMs: 10 };
    },
    apply: async (decisions) => {
      state.applied.push(decisions);
      const gone = new Set(decisions.map((d) => d.keyHash));
      state.visible = state.visible.filter((c) => !gone.has(c.keyHash));
      return { counts: {}, ...prepared() };
    },
    usageRowCount: async () => state.usageRows.length,
    usageRowsSince: async (n) => state.usageRows.slice(n),
    sleep: async () => undefined,
  };
  return api;
}

test("truncateRosterForB：200 を超えたら出場面数の少ない順に切る（切った数を返す）", () => {
  const entities = Array.from({ length: 205 }, (_, i) => ({
    id: `e${String(i).padStart(3, "0")}`,
    sceneCount: i < 5 ? 1 : 10,
  }));
  const cut = truncateRosterForB({ entities });
  assert.equal(cut.cut, 5);
  assert.equal(cut.roster.entities.length, 200);
  assert.ok(cut.roster.entities.every((e) => e.sceneCount === 10));
  const small = truncateRosterForB({ entities: entities.slice(0, 10) });
  assert.equal(small.cut, 0);
  // sceneCount が無ければ evidence の distinct な場面で数える。
  const byEvidence = truncateRosterForB(
    {
      entities: [
        { id: "a", evidence: [{ scene: 1 }, { scene: 2 }] },
        { id: "b", evidence: [{ scene: 1 }] },
      ],
    },
    1,
  );
  assert.deepEqual(
    byEvidence.roster.entities.map((e) => e.id),
    ["a"],
  );
});

test("検査：窓の一致・policy／license／言語・Entry の窓・surface の集合", () => {
  assert.doesNotThrow(() =>
    assertEstimateMatches(
      { visibleCount: 120, entryCount: 10 },
      { judgedSlots: 50, entrySlots: 10 },
    ),
  );
  assert.throws(
    () =>
      assertEstimateMatches(
        { visibleCount: 120, entryCount: 10 },
        { judgedSlots: 49, entrySlots: 10 },
      ),
    /ESTIMATE_SLOTS_DIFFER/u,
  );
  assert.throws(
    () =>
      assertEstimateMatches(
        { visibleCount: 3, entryCount: 300 },
        { judgedSlots: 3, entrySlots: 300 },
      ),
    /ESTIMATE_ENTRIES_DIFFER/u,
  );
  assert.doesNotThrow(() =>
    assertAiGate({
      policyBlocked: false,
      licenseRestricted: false,
      language: "ja",
    }),
  );
  assert.throws(
    () =>
      assertAiGate({
        policyBlocked: true,
        licenseRestricted: false,
        language: "ja",
      }),
    /AI_POLICY_OFF/u,
  );
  assert.throws(
    () =>
      assertAiGate({
        policyBlocked: false,
        licenseRestricted: true,
        language: "ja",
      }),
    /LICENSE_RESTRICTED/u,
  );
  assert.throws(
    () =>
      assertAiGate({
        policyBlocked: false,
        licenseRestricted: false,
        language: "en",
      }),
    /LANGUAGE_NOT_JA/u,
  );
  assert.throws(
    () => assertEntriesWithinWindow({ entryCount: 201 }),
    /ENTRIES_OVER_WINDOW/u,
  );
  // surface の集合：要求があれば codex_judgment だけ、無ければ空。
  assert.doesNotThrow(() =>
    assertOnlyCodexJudgment({
      usageSurfaces: ["codex_judgment", "codex_judgment"],
      auditPathIds: ["codex_judgment"],
      requestsSent: 2,
    }),
  );
  assert.throws(
    () =>
      assertOnlyCodexJudgment({
        usageSurfaces: ["codex_judgment", "chat"],
        auditPathIds: ["codex_judgment"],
        requestsSent: 2,
      }),
    /AI_SURFACE_SET/u,
  );
  assert.throws(
    () =>
      assertOnlyCodexJudgment({
        usageSurfaces: ["codex_judgment"],
        auditPathIds: ["codex_judgment", "summary"],
        requestsSent: 1,
      }),
    /AI_SURFACE_SET/u,
  );
  assert.throws(
    () =>
      assertOnlyCodexJudgment({
        usageSurfaces: [],
        auditPathIds: [],
        requestsSent: 1,
      }),
    /AI_SURFACE_SET/u,
  );
  assert.doesNotThrow(() =>
    assertOnlyCodexJudgment({
      usageSurfaces: [],
      auditPathIds: [],
      requestsSent: 0,
    }),
  );
  assert.throws(
    () =>
      assertOnlyCodexJudgment({
        usageSurfaces: ["codex_judgment"],
        auditPathIds: [],
        requestsSent: 0,
      }),
    /AI_SURFACE_SET/u,
  );
});

test("readUsageForRequest：行なし・null・0・別 surface を別の失敗理由にし、行が遅れて来ても待つ", async () => {
  const mk = (rows) => ({
    usageRowsSince: async (n) => rows.slice(n),
    sleep: async () => undefined,
  });
  assert.deepEqual(
    await readUsageForRequest(mk([]), 0, { timeoutMs: 1, intervalMs: 1 }),
    { ok: false, kind: "no-usage-row" },
  );
  const row = (over) => ({
    surface: "codex_judgment",
    model: "m",
    tokens_in: 10,
    tokens_out: 5,
    ...over,
  });
  assert.equal(
    (await readUsageForRequest(mk([row({ tokens_in: null })]), 0)).kind,
    "tokens-null",
  );
  assert.equal(
    (await readUsageForRequest(mk([row({ tokens_out: null })]), 0)).kind,
    "tokens-null",
  );
  assert.equal(
    (await readUsageForRequest(mk([row({ tokens_in: 0, tokens_out: 0 })]), 0))
      .kind,
    "tokens-zero",
  );
  assert.equal(
    (await readUsageForRequest(mk([row({ tokens_out: 0 })]), 0)).kind,
    "tokens-zero",
  );
  assert.equal(
    (await readUsageForRequest(mk([row({ surface: "chat" })]), 0)).kind,
    "wrong-surface",
  );
  const ok = await readUsageForRequest(mk([row({})]), 0);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.usage, { input_tokens: 10, output_tokens: 5 });
  // 行が 3 回目の poll で現れる（void recordAiUsage は待たない）。
  let polls = 0;
  const delayed = {
    usageRowsSince: async () => (++polls >= 3 ? [row({})] : []),
    sleep: async () => undefined,
  };
  assert.equal(
    (await readUsageForRequest(delayed, 0, { timeoutMs: 1000, intervalMs: 1 }))
      .ok,
    true,
  );
  assert.equal(polls, 3);
});

test("judgmentMetrics：名簿どおり・名簿と違う別名・結び残し・名簿に無い表記への別名・窓の外", async () => {
  const index = await buildRosterIndex(roster, ident);
  const candidates = [
    "c000", // e1：別名 e1 → 名簿どおり
    "c001", // e1：null → 結び残し
    "c002", // e1：別名が e2 → 名簿と違う別名
    "c003", // e2：不一致の型
    "zzz1", // 未判定：別名あり → 名簿に無い表記への別名
    "c004", // 敬称の形 → e1 の実体として数える（honorific）
  ].map((keyHash) => ({ keyHash, count: 5, firstSceneIndex: 1 }));
  const judgments = new Map([
    ["c000", { suggestedType: "character", aliasOfId: "e1", aliasKnown: true }],
    ["c001", { suggestedType: "character", aliasOfId: null, aliasKnown: true }],
    ["c002", { suggestedType: "character", aliasOfId: "e2", aliasKnown: true }],
    ["c003", { suggestedType: "character", aliasOfId: null, aliasKnown: true }],
    ["zzz1", { suggestedType: "item", aliasOfId: "e1", aliasKnown: true }],
  ]);
  const m = judgmentMetrics({ index, candidates, judgments });
  assert.equal(m.candidateCount, 6);
  assert.equal(m.judged, 5);
  assert.equal(m.droppedInWindow, 1); // c004 は窓の中だが判定なし
  assert.equal(m.aliasButtons, 3);
  assert.equal(m.aliasMatchRoster, 1);
  assert.equal(m.aliasMismatchRoster, 1);
  assert.equal(m.aliasOnUnlisted, 1);
  assert.equal(m.missedBindNullAlias, 2); // c001・c003
  assert.equal(m.missedBindDropped, 1); // c004
  assert.equal(m.typeChecked, 4);
  assert.equal(m.typeMismatch, 1); // c003 は location なのに character
  // 窓の外：51 件目以降は判定なしで、名簿で既存なら結び残し（窓の外）。
  const many = Array.from({ length: 55 }, (_, i) => ({
    keyHash: i === 52 ? "c000" : `u${i}`,
    count: 1,
    firstSceneIndex: 1,
  }));
  const m2 = judgmentMetrics({ index, candidates: many, judgments: new Map() });
  assert.equal(m2.beyondWindow, 5);
  assert.equal(m2.missedBindBeyondWindow, 1);
  assert.equal(m2.slots, MAX_CANDIDATES);
});

test("typeMatches：other は item・lore を許す", () => {
  assert.ok(typeMatches("other", "lore"));
  assert.ok(typeMatches("other", "item"));
  assert.ok(!typeMatches("other", "character"));
  assert.ok(typeMatches("character", "character"));
  assert.ok(!typeMatches("location", "character"));
});

test("selfAgreement：2 回以上判定された候補が全回で同じ aliasOfId か", () => {
  const run = (a, b) =>
    new Map([
      ["k1", { aliasOfId: a, suggestedType: "character" }],
      ["k2", { aliasOfId: b, suggestedType: "location" }],
    ]);
  assert.deepEqual(
    selfAgreement([run("e1", null), run("e1", "e2"), run("e1", null)]),
    {
      keysCompared: 2,
      aliasAgree: 1,
      typeAgree: 2,
      successfulRuns: 3,
    },
  );
  assert.equal(selfAgreement([run("e1", null)]).keysCompared, 0);
});

test("sendOne：成功・429 は 1 回だけ再送・判定の中身の失敗は再送しない・上限超過は送らない", async () => {
  const withGate = async (fn, overrides = {}) => {
    const g = tmpGate(overrides);
    try {
      await fn(g.gate);
    } finally {
      rmSync(g.dir, { recursive: true, force: true });
    }
  };
  await withGate(async (gate) => {
    const api = fakeApi();
    const ok = await sendOne({
      api,
      gate,
      stage: "B1",
      estimate: await api.estimate(),
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.attempts, 1);
    assert.equal(ok.retried, false);
    assert.ok(ok.judgments.length > 0);
  });
  // 429 → 再送で成功。
  await withGate(async (gate) => {
    const api = fakeApi({
      script: (n) =>
        n === 1
          ? { ok: false, kind: "rate-limit", httpStatus: 429 }
          : { ok: true },
    });
    const r = await sendOne({
      api,
      gate,
      stage: "B1",
      estimate: await api.estimate(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 2);
    assert.equal(r.retried, true);
  });
  // 判定の中身の失敗は再送しない。
  await withGate(async (gate) => {
    const api = fakeApi({
      script: () => ({ ok: false, kind: "no-valid-result" }),
    });
    const f = await sendOne({
      api,
      gate,
      stage: "B1",
      estimate: await api.estimate(),
    });
    assert.equal(f.ok, false);
    assert.equal(f.attempts, 1);
    assert.equal(api.state.judgeCalls, 1);
  });
  // 行なしは、空の Map と同じく別の失敗理由。
  await withGate(async (gate) => {
    const api = fakeApi({ script: () => ({ ok: true, usage: false }) });
    const nr = await sendOne({
      api,
      gate,
      stage: "B1",
      estimate: await api.estimate(),
      usagePoll: { timeoutMs: 1, intervalMs: 1 },
    });
    assert.equal(nr.ok, false);
    assert.equal(nr.failureKind, "no-usage-row");
  });
  // 401 で停止（BudgetStop）。
  await withGate(async (gate) => {
    const api = fakeApi({
      script: () => ({ ok: false, kind: "auth", httpStatus: 401 }),
    });
    await assert.rejects(
      sendOne({ api, gate, stage: "B1", estimate: await api.estimate() }),
      (e) => e instanceof BudgetStop && e.code === "AUTH_401_403",
    );
  });
  // 上限を超える見積りは、送信の関数を呼ばない。
  await withGate(
    async (gate) => {
      const api = fakeApi();
      await assert.rejects(
        sendOne({ api, gate, stage: "B1", estimate: await api.estimate() }),
        (e) => e.code === "TOTAL_CAP_WOULD_EXCEED",
      );
      assert.equal(api.state.judgeCalls, 0);
    },
    { totalCapUsd: 0.001 },
  );
});

test("runB1：同じ候補に 3 回。2 回以上の失敗は判断不能。要求本文・表記は結果に残らない", async () => {
  const index = await buildRosterIndex(roster, ident);
  const a = tmpGate();
  try {
    const api = fakeApi();
    const r = await runB1({
      api,
      gate: a.gate,
      index,
      registeredKeyHashes: ["c000", "gone"],
    });
    assert.equal(r.requests.length, 3);
    assert.equal(r.successCount, 3);
    assert.equal(r.undeterminable, false);
    assert.equal(r.candidates.visibleCount, 120);
    assert.equal(r.registeredNotInCandidates, 1); // "gone" は候補に無い
    assert.equal(r.selfAgreement.keysCompared, 50);
    assert.equal(r.selfAgreement.aliasAgree, 50);
    assert.equal(r.requests[0].metrics.aliasMatchRoster, 2);
    assert.equal(r.requests[0].metrics.beyondWindow, 70);
    assert.ok(!("judgmentMap" in r.requests[0]));
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = tmpGate();
  try {
    const api = fakeApi({
      script: (n) =>
        n === 1 ? { ok: true } : { ok: false, kind: "no-valid-result" },
    });
    const r = await runB1({ api, gate: b.gate, index });
    assert.equal(r.undeterminable, true);
    assert.deepEqual(r.failuresByKind, { "no-valid-result": 2 });
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("authorDecision：名簿どおりに別名・受理・却下（理由別）", () => {
  const typeOf = (id) => ({ e1: "character", e2: "location", e9: "other" })[id];
  assert.deepEqual(
    authorDecision(
      { kind: "entity", id: "e1", honorific: false },
      new Set(["e1"]),
      typeOf,
    ),
    { action: "alias", targetId: "e1", reason: "alias" },
  );
  assert.deepEqual(
    authorDecision(
      { kind: "entity", id: "e9", honorific: false },
      new Set(["e1"]),
      typeOf,
    ),
    { action: "accept", newId: "e9", type: "lore", reason: "accept" },
  );
  assert.equal(
    authorDecision(
      { kind: "entity", id: "e1", honorific: true },
      new Set(["e1"]),
      typeOf,
    ).reason,
    "honorific",
  );
  assert.equal(
    authorDecision({ kind: "ambiguous", ids: ["e1", "e2"] }, new Set(), typeOf)
      .reason,
    "ambiguous",
  );
  assert.equal(
    authorDecision({ kind: "unlisted" }, new Set(), typeOf).reason,
    "unlisted",
  );
});

test("runB2：ceil(N/50) 回の要求で、名簿どおりに進め、名簿に無い候補は却下として数える", async () => {
  const index = await buildRosterIndex(roster, ident);
  const a = tmpGate({ totalCapUsd: 15 });
  try {
    const api = fakeApi({ candidateCount: 120 });
    const r = await runB2({
      api,
      gate: a.gate,
      index,
      rosterTypeOf: (id) => index.entities.get(id).type,
      registeredIds: new Set(["e1", "e2", "e3"]),
    });
    assert.equal(r.plannedIterations, 3);
    assert.equal(r.iterations.length, 3);
    assert.equal(r.finalVisibleCount, 0);
    assert.equal(r.noProgress, false);
    assert.equal(r.decisionCounts.alias, 5); // c000〜c003・c005 が別名、c004 は敬称で却下
    assert.equal(r.dismissReasons.honorific, 1);
    assert.equal(r.dismissReasons.unlisted, 120 - 6);
    assert.equal(
      r.decisionCounts.alias +
        r.decisionCounts.accept +
        r.decisionCounts.dismiss,
      120,
    );
    // 決定は judgeCandidates の結果ではなく名簿に従う（c002 は AI が e2 と言っても e1 に別名登録）。
    const first = api.state.applied[0].find((d) => d.keyHash === "c002");
    assert.equal(first.targetId, "e1");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  // 反映しても候補が減らなければ止まる。
  const b = tmpGate();
  try {
    const api = fakeApi({ candidateCount: 10 });
    api.apply = async () => ({
      visibleCount: 10,
      candidates: [],
      entryCount: 3,
    });
    const r = await runB2({
      api,
      gate: b.gate,
      index,
      rosterTypeOf: () => "character",
      registeredIds: new Set(["e1"]),
    });
    assert.equal(r.noProgress, true);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("乾いた実行：送信の関数を呼ばず、件数と要求の見積りだけを返す", async () => {
  const api = fakeApi({ candidateCount: 120 });
  api.judge = async () => {
    throw new Error("send must not be called in a dry run");
  };
  const d = await dryMeasure({ api });
  assert.equal(d.candidates.visibleCount, 120);
  assert.equal(d.b2Requests, 3);
  assert.equal(d.b1Requests, 3);
  assert.equal(d.request.judgedSlots, 50);
  assert.ok(d.request.estInputTokens > 0 && d.request.estOutputTokens > 0);
  assert.equal(api.state.judgeCalls, 0);
  assert.equal(api.state.usageRows.length, 0);
  const plan = buildDryRunPlan(
    [
      {
        work: "w",
        level: "empty",
        request: d.request,
        b1Requests: 3,
        b2Requests: 3,
      },
      {
        work: "w",
        level: "L0",
        request: d.request,
        b1Requests: 3,
        b2Requests: 3,
      },
      {
        work: "w",
        level: "L2",
        request: d.request,
        b1Requests: 3,
        b2Requests: 3,
      },
    ],
    { pricing: PRICING },
  );
  // 空の基準は送らない。B1＝L0・L2 で 6、B2＝L2 で 3、試走 3。
  assert.equal(plan.cost.byStage.B1.requests, 6);
  assert.equal(plan.cost.byStage.B2.requests, 3);
  assert.equal(plan.cost.byStage.trial.requests, 3);
  assert.equal(plan.cost.requests, 12);
});

test("dryMeasure は policy／license／言語の状態を記録するが、止めない（送らないので）", async () => {
  const api = fakeApi();
  api.gate = async () => ({
    policyBlocked: false,
    licenseRestricted: true,
    language: "ja",
  });
  const d = await dryMeasure({ api });
  assert.equal(d.gate.licenseRestricted, true);
});

test("外挿：合成の内訳から、名簿の規模を仮定した要求の見積りを作る（候補は空の名簿の行を上限に使う）", () => {
  const row = (level, over) => ({
    work: "w",
    level,
    candidates: { visibleCount: 120 },
    request: {
      judgedSlots: 50,
      entrySlots: 0,
      entryAliasCount: 0,
      parts: {
        baseChars: 400,
        baseNonAscii: 300,
        candidatesChars: 5000,
        candidatesNonAscii: 4000,
        entriesChars: 0,
        entriesNonAscii: 0,
      },
      estInputTokens: 1,
      estOutputTokens: 1,
      ...over,
    },
    b1Requests: 3,
    b2Requests: 3,
  });
  const empty = row("empty", {});
  // 合成：L0 は 10 実体（実体あたり 20 字・非 ascii 8）、L3 は別名 20 個（別名あたり ascii 4・非 ascii 6）。
  const l0 = row("L0", {
    entrySlots: 10,
    entryAliasCount: 0,
    parts: { ...empty.request.parts, entriesChars: 200, entriesNonAscii: 80 },
  });
  const l3 = row("L3", {
    entrySlots: 10,
    entryAliasCount: 20,
    parts: { ...empty.request.parts, entriesChars: 400, entriesNonAscii: 200 },
  });
  const p = projectRequest({
    emptyRow: empty,
    l0Row: l0,
    l3Row: l3,
    entities: 100,
    aliasesPerEntity: 2,
  });
  // ascii：base 100＋候補 1000＋実体 100×12＋別名 200×4＝3100 → ×0.3。非 ascii：300＋4000＋100×8＋200×6＝6300。
  assert.equal(p.estInputTokens, Math.ceil(3100 * 0.3 + 6300));
  assert.equal(p.estOutputTokens, 6000);
  assert.equal(p.basis.aliasCostFallback, false);
  assert.equal(
    projectRequest({
      emptyRow: { ...empty, request: { ...empty.request, parts: null } },
      l0Row: l0,
      l3Row: l3,
      entities: 1,
      aliasesPerEntity: 0,
    }),
    null,
  );
  const plan = buildProjectedPlan(
    { w: [empty, l0, row("L1", l0.request && {}), row("L2", {}), l3] },
    { entities: 100, aliasesPerEntityByLevel: { L0: 0, L1: 1, L2: 2, L3: 4 } },
    { pricing: PRICING },
  );
  // L1・L2 の行は内訳が無い（parts あり・entries 0）が、外挿は L0・L3 の測定から作るので 4 段とも作れる。
  assert.equal(plan.cost.byStage.B1.requests, 12);
  assert.equal(plan.cost.byStage.B2.requests, 3);
  assert.equal(plan.cost.byStage.trial.requests, 3);
  assert.equal(plan.perWork.w.b2Requests, 3);
});
