// 費用の台帳と停止線の試験（API は呼ばない。合成の usage だけ）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BudgetStop,
  LEDGER_SOURCE_COMMIT,
  STAGE_CAPS_USD,
  TOTAL_CAP_USD,
  createGate,
  estimateInputTokens,
  estimateOutputTokens,
  planCost,
  readModelPricing,
  usdOf,
} from "./ledger.mjs";

const SONNET = "claude-sonnet-5-5";
const PRICING = { inputPerMillion: 2, outputPerMillion: 10 };

function tmpFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-ledger-"));
  return { dir, file: path.join(dir, "spend.jsonl") };
}
function gate(overrides = {}) {
  const t = tmpFile();
  const g = createGate({
    file: t.file,
    model: SONNET,
    pricing: PRICING,
    requireTrial: false,
    ...overrides,
  });
  return { ...t, gate: g };
}
const ok = (input, output) => ({
  ok: true,
  usage: { input_tokens: input, output_tokens: output },
});
const send = (g, outcome, extra = {}) =>
  g.afterRequest({
    stage: "B1",
    outcome,
    estInputTokens: 10_000,
    estOutputTokens: 5_000,
    ...extra,
  });

test("単価は modelPricing.ts から読み、未定義のモデルは例外", () => {
  assert.deepEqual(readModelPricing(SONNET), PRICING);
  assert.deepEqual(readModelPricing("claude-opus-5-5"), {
    inputPerMillion: 4,
    outputPerMillion: 20,
  });
  assert.throws(() => readModelPricing("claude-unknown-9"), /MODEL_PRICE/u);
});

test("usdOf・上限の定数（§9・§15）・手本の commit の記録", () => {
  assert.equal(
    usdOf(PRICING, { input_tokens: 10_000, output_tokens: 5_000 }),
    0.07,
  );
  assert.equal(TOTAL_CAP_USD, 15);
  assert.deepEqual(STAGE_CAPS_USD, { trial: 1, B1: 8, B2: 4, reserve: 2 });
  assert.equal(LEDGER_SOURCE_COMMIT, "aa67168f");
  const header = readFileSync(import.meta.filename, "utf8");
  assert.ok(header.length > 0);
  assert.match(
    readFileSync(path.join(import.meta.dirname, "ledger.mjs"), "utf8"),
    /aa67168f/u,
  );
});

test("見積りの token は日本語を保守側に数える", () => {
  assert.equal(
    estimateInputTokens({ promptChars: 1000, promptNonAsciiChars: 1000 }),
    1000,
  );
  assert.equal(
    estimateInputTokens({ promptChars: 1000, promptNonAsciiChars: 0 }),
    300,
  );
  assert.equal(estimateOutputTokens(50), 6000);
  assert.equal(estimateOutputTokens(1), 800);
});

test("台帳は 0600 の JSONL で、本文・key の欄を持たない", () => {
  const { dir, file, gate: g } = gate();
  try {
    send(g, ok(9_000, 4_000));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const row = JSON.parse(readFileSync(file, "utf8").trim());
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "billed",
        "est_input_tokens",
        "est_output_tokens",
        "failure_kind",
        "http_status",
        "input_tokens",
        "model",
        "note",
        "ok",
        "output_tokens",
        "stage",
        "ts",
        "usd",
      ].sort(),
    );
    assert.equal(row.usd, 0.058);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight：全体の上限を超える見積りは送らない", () => {
  const { dir, gate: g } = gate({ totalCapUsd: 0.05 });
  try {
    assert.throws(
      () =>
        g.preflight({
          stage: "B1",
          estInputTokens: 10_000,
          estOutputTokens: 5_000,
        }),
      (e) => e instanceof BudgetStop && e.code === "TOTAL_CAP_WOULD_EXCEED",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight：段の上限を超える見積りは送らない", () => {
  const { dir, gate: g } = gate({
    stageCapsUsd: { ...STAGE_CAPS_USD, trial: 0.05 },
  });
  try {
    assert.throws(
      () =>
        g.preflight({
          stage: "trial",
          estInputTokens: 10_000,
          estOutputTokens: 5_000,
        }),
      (e) => e.code === "STAGE_CAP_WOULD_EXCEED",
    );
    assert.throws(
      () =>
        g.preflight({ stage: "nope", estInputTokens: 1, estOutputTokens: 1 }),
      (e) => e.code === "UNKNOWN_STAGE",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("上限に達したら即時停止し、以後の preflight も止まる", () => {
  const { dir, gate: g } = gate({ totalCapUsd: 0.1 });
  try {
    g.preflight({
      stage: "B1",
      estInputTokens: 10_000,
      estOutputTokens: 5_000,
    });
    assert.throws(
      () =>
        send(g, ok(20_000, 6_000), {
          estInputTokens: 20_000,
          estOutputTokens: 6_000,
        }),
      (e) => e.code === "TOTAL_CAP_REACHED",
    );
    assert.throws(
      () => g.preflight({ stage: "B1", estInputTokens: 1, estOutputTokens: 1 }),
      (e) => e.code === "TOTAL_CAP_REACHED",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("累計 80％で、残りの外挿が上限を超えるなら止める", () => {
  // 上限 1 USD、1 要求 0.07 USD。12 要求で 0.84（84％）。残り 3 要求の外挿 = 0.84+0.21 = 1.05 > 1。
  const { dir, gate: g } = gate({
    totalCapUsd: 1,
    stageCapsUsd: { ...STAGE_CAPS_USD, B1: 100 },
  });
  try {
    for (let i = 0; i < 11; i++)
      send(g, ok(10_000, 5_000), { remainingAfterThis: 3 });
    assert.throws(
      () => send(g, ok(10_000, 5_000), { remainingAfterThis: 3 }),
      (e) => e.code === "EXTRAPOLATION_EXCEEDS_CAP",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 残りが少なければ止まらない。
  const second = gate({
    totalCapUsd: 1,
    stageCapsUsd: { ...STAGE_CAPS_USD, B1: 100 },
  });
  try {
    for (let i = 0; i < 12; i++)
      send(second.gate, ok(10_000, 5_000), { remainingAfterThis: 1 });
    assert.equal(second.gate.state.stopped, null);
  } finally {
    rmSync(second.dir, { recursive: true, force: true });
  }
});

test("401／403 は即時停止", () => {
  for (const status of [401, 403]) {
    const { dir, gate: g } = gate();
    try {
      assert.throws(
        () => send(g, { ok: false, failureKind: "auth", httpStatus: status }),
        (e) => e.code === "AUTH_401_403",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("429 が 2 回連続で停止（間に成功があれば数え直す）", () => {
  const a = gate();
  try {
    send(a.gate, ok(9_000, 4_000));
    send(a.gate, { ok: false, failureKind: "rate-limit", httpStatus: 429 });
    send(a.gate, ok(9_000, 4_000));
    send(a.gate, { ok: false, failureKind: "rate-limit", httpStatus: 429 });
    assert.equal(a.gate.state.stopped, null);
    assert.throws(
      () =>
        send(a.gate, { ok: false, failureKind: "rate-limit", httpStatus: 429 }),
      (e) => e.code === "RATE_LIMIT_STREAK",
    );
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
});

test("API の失敗が 5 件連続で停止", () => {
  const { dir, gate: g } = gate();
  try {
    for (let i = 0; i < 6; i++) send(g, ok(9_000, 4_000));
    for (let i = 0; i < 4; i++)
      send(g, { ok: false, failureKind: "server", httpStatus: 500 });
    assert.throws(
      () => send(g, { ok: false, failureKind: "server", httpStatus: 500 }),
      (e) => e.code === "FAILURE_STREAK",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("最初の 5 要求で 3 件以上失敗したら停止（連続でなくても）", () => {
  const { dir, gate: g } = gate();
  try {
    send(g, { ok: false, failureKind: "no-valid-result" });
    send(g, ok(9_000, 4_000));
    send(g, { ok: false, failureKind: "no-valid-result" });
    send(g, ok(9_000, 4_000));
    assert.throws(
      () => send(g, { ok: false, failureKind: "no-valid-result" }),
      (e) => e.code === "EARLY_FAILURES",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 5 要求のうち 2 件の失敗なら止まらない。
  const second = gate();
  try {
    send(second.gate, { ok: false, failureKind: "no-valid-result" });
    send(second.gate, ok(9_000, 4_000));
    send(second.gate, { ok: false, failureKind: "no-valid-result" });
    send(second.gate, ok(9_000, 4_000));
    send(second.gate, ok(9_000, 4_000));
    assert.equal(second.gate.state.stopped, null);
  } finally {
    rmSync(second.dir, { recursive: true, force: true });
  }
});

test("token が見積りの 2 倍超なら停止（入力・出力のどちらでも。較正の無い試走の段は見積りの 2 倍）", () => {
  const a = gate();
  try {
    assert.throws(
      () => send(a.gate, ok(20_001, 4_000)),
      (e) => e.code === "TOKENS_OVER_TRIAL_MEASURED",
    );
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = gate();
  try {
    assert.throws(
      () => send(b.gate, ok(9_000, 10_001)),
      (e) => e.code === "TOKENS_OVER_TRIAL_MEASURED",
    );
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
  const c = gate();
  try {
    send(c.gate, ok(20_000, 10_000)); // ちょうど 2 倍は止めない
    assert.equal(c.gate.state.stopped, null);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test("token が無い（行なし・null・0）要求は費用 0 の失敗として記録され、billed にならない", () => {
  const { dir, file, gate: g } = gate();
  try {
    send(g, { ok: false, failureKind: "no-usage-row" });
    send(g, {
      ok: false,
      failureKind: "tokens-null",
      usage: { input_tokens: null, output_tokens: null },
    });
    send(g, {
      ok: false,
      failureKind: "tokens-zero",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      rows.map((r) => r.billed),
      [false, false, false],
    );
    assert.equal(g.state.total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("既存の台帳があれば累計を引き継ぐ（process をまたぐ）", () => {
  const { dir, file, gate: first } = gate();
  try {
    send(first, ok(10_000, 5_000));
    const second = createGate({
      file,
      model: SONNET,
      pricing: PRICING,
      requireTrial: false,
    });
    assert.equal(Number(second.state.total.toFixed(4)), 0.07);
    assert.equal(second.state.billedRequests, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planCost：段ごとの上限と照らす（台帳に書かない）", () => {
  const plan = planCost(
    [
      { stage: "B1", estInputTokens: 10_000, estOutputTokens: 5_000 },
      { stage: "B1", estInputTokens: 10_000, estOutputTokens: 5_000 },
      { stage: "B2", estInputTokens: 100_000, estOutputTokens: 60_000 },
    ],
    { pricing: PRICING },
  );
  assert.equal(plan.requests, 3);
  assert.equal(plan.byStage.B1.usd, 0.14);
  assert.equal(plan.byStage.B2.withinCap, true);
  assert.equal(plan.withinCap, true);
  const over = planCost(
    [{ stage: "trial", estInputTokens: 1_000_000, estOutputTokens: 1_000_000 }],
    { pricing: PRICING },
  );
  assert.equal(over.byStage.trial.withinCap, false);
  assert.equal(over.withinCap, true);
});

test("STOP は台帳に残り、createGate を作り直しても停止のまま（halt も同じ。解除は STOP 行を消す人）", () => {
  const { dir, file, gate: first } = gate();
  try {
    assert.throws(
      () => send(first, { ok: false, failureKind: "auth", httpStatus: 401 }),
      (e) => e.code === "AUTH_401_403",
    );
    const lines = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.at(-1).type, "STOP");
    assert.equal(lines.at(-1).code, "AUTH_401_403");
    const second = createGate({
      file,
      model: SONNET,
      pricing: PRICING,
      requireTrial: false,
    });
    assert.equal(second.state.stopped.code, "AUTH_401_403");
    assert.throws(
      () =>
        second.preflight({
          stage: "B1",
          estInputTokens: 1,
          estOutputTokens: 1,
        }),
      (e) => e.code === "AUTH_401_403",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const h = gate();
  try {
    const stopped = h.gate.halt("CELL_NOT_OK", { status: "ai-surface-set" });
    assert.equal(stopped.code, "CELL_NOT_OK");
    h.gate.halt("OTHER"); // 最初の停止の理由を保つ
    assert.equal(h.gate.state.stopped.code, "CELL_NOT_OK");
    const again = createGate({
      file: h.file,
      model: SONNET,
      pricing: PRICING,
      requireTrial: false,
    });
    assert.equal(again.state.stopped.code, "CELL_NOT_OK");
    assert.throws(
      () =>
        again.preflight({ stage: "B1", estInputTokens: 1, estOutputTokens: 1 }),
      (e) => e.code === "CELL_NOT_OK",
    );
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("試走の行が無ければ B1／B2 は始めない。較正は試走の実測の比の 2 倍で見る", () => {
  const t = gate({ requireTrial: true });
  try {
    assert.throws(
      () =>
        t.gate.preflight({
          stage: "B1",
          estInputTokens: 10_000,
          estOutputTokens: 5_000,
        }),
      (e) => e.code === "TRIAL_REQUIRED",
    );
    assert.equal(t.gate.state.stopped, null); // 送らないだけ
    // 試走：実測は見積りの 0.5 倍（入力 5k・出力 2.5k）。
    t.gate.preflight({
      stage: "trial",
      estInputTokens: 10_000,
      estOutputTokens: 5_000,
    });
    t.gate.afterRequest({
      stage: "trial",
      outcome: ok(5_000, 2_500),
      estInputTokens: 10_000,
      estOutputTokens: 5_000,
    });
    assert.deepEqual(
      {
        n: t.gate.state.trial.n,
        maxIn: t.gate.state.trial.maxIn,
        maxOut: t.gate.state.trial.maxOut,
      },
      { n: 1, maxIn: 0.5, maxOut: 0.5 },
    );
    t.gate.preflight({
      stage: "B1",
      estInputTokens: 10_000,
      estOutputTokens: 5_000,
    });
    // B1：較正した見積りは 5k／2.5k なので、その 2 倍 = 10k／5k を超えたら停止。
    t.gate.afterRequest({
      stage: "B1",
      outcome: ok(10_000, 5_000),
      estInputTokens: 10_000,
      estOutputTokens: 5_000,
    });
    assert.throws(
      () => send(t.gate, ok(10_001, 2_000)),
      (e) => e.code === "TOKENS_OVER_TRIAL_MEASURED",
    );
    // 台帳から作り直しても較正は引き継ぐ。
    const again = createGate({ file: t.file, model: SONNET, pricing: PRICING });
    assert.equal(again.state.trial.maxIn, 0.5);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("失敗でも読めた token は課金する。別 surface・分類不能・応答後の usage 不明は停止", () => {
  const a = gate();
  try {
    // 有効結果なし（失敗）でも usage があれば台帳に課金される。
    send(a.gate, {
      ok: false,
      failureKind: "no-valid-result",
      usage: { input_tokens: 10_000, output_tokens: 5_000 },
      responded: true,
    });
    assert.equal(Number(a.gate.state.total.toFixed(4)), 0.07);
    assert.equal(a.gate.state.billedRequests, 1);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  for (const [outcome, code] of [
    [
      {
        ok: false,
        failureKind: "wrong-surface",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "AI_SURFACE_UNEXPECTED",
    ],
    [{ ok: false, failureKind: "other" }, "UNCLASSIFIED_FAILURE"],
    [
      { ok: false, failureKind: "no-usage-row", responded: true },
      "USAGE_NOT_RECORDED",
    ],
  ]) {
    const b = gate();
    try {
      assert.throws(
        () => send(b.gate, outcome),
        (e) => e.code === code,
      );
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  }
});

test("累計は台帳から取り直す（別の gate が追記した行も見える）", () => {
  const { dir, file, gate: first } = gate();
  try {
    const second = createGate({
      file,
      model: SONNET,
      pricing: PRICING,
      requireTrial: false,
    });
    send(second, ok(10_000, 5_000));
    first.preflight({ stage: "B1", estInputTokens: 1, estOutputTokens: 1 });
    assert.equal(Number(first.state.total.toFixed(4)), 0.07);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("2 倍超の線は、試走の実測 token の 2 倍も並べる（試走より大きい要求で §9 より緩くならない）", () => {
  const t = gate({ requireTrial: true });
  try {
    t.gate.preflight({
      stage: "trial",
      estInputTokens: 10_000,
      estOutputTokens: 5_000,
    });
    t.gate.afterRequest({
      stage: "trial",
      outcome: ok(5_000, 2_500),
      estInputTokens: 10_000,
      estOutputTokens: 5_000,
    });
    // 見積りが大きい要求（較正した線は 2×20k×0.5=20k）でも、実測 token の 2 倍（10k）を超えたら止める。
    assert.throws(
      () =>
        t.gate.afterRequest({
          stage: "B1",
          outcome: ok(10_001, 1_000),
          estInputTokens: 20_000,
          estOutputTokens: 5_000,
        }),
      (e) => e.code === "TOKENS_OVER_TRIAL_MEASURED",
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
