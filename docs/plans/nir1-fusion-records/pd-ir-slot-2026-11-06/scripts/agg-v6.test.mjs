// agg-v6.mjs の試験：第 5 版の records で summary-v5.json と一致すること、
// 第 6 版で増える項目（errorChain・failedAtMs・connectionWait など）は小さな合成の record で確かめる。
// 実行：node --test agg-v6.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildReport,
  isTruncatedShape,
  median,
  parseArgs,
  shapeKey,
} from "./agg-v6.mjs";

const HARNESS_DIR =
  "/home/grimodex/worktrees/Grimodex/claude-fusion-ir-eval-v6/scripts/quality/fusion-slot-eval";
const CLASSIFY = path.join(HARNESS_DIR, "ir-classify.mjs");
const ERROR_RECORD = path.join(HARNESS_DIR, "ir-error-record.mjs");
// harness の実物が無いまま skip して「通った」ことにしない。
for (const file of [CLASSIFY, ERROR_RECORD])
  assert.ok(
    fs.existsSync(file),
    `harness の実物が無い: ${file}（v6 worktree claude-fusion-ir-eval-v6 の commit 5f76ba2a 以降が必要）`,
  );
const HERE = path.dirname(fileURLToPath(import.meta.url));
const V5_DIR = path.resolve(HERE, "../../pd-ir-slot-2026-11-04");
const readV5 = (name) =>
  JSON.parse(fs.readFileSync(path.join(V5_DIR, name), "utf8"));
const { summarizeQueries } = await import(pathToFileURL(CLASSIFY).href);
// harness の実物（ir-renderer.ts の errorShape／errorChain と同じ関数）で record の形を作る。
const { describeErrorChain, sanitizeMessage } = await import(
  pathToFileURL(ERROR_RECORD).href
);
// 本番の抽出の失敗：extractionCoordinator は code を ", " で連結した Error を投げる（.code・.cause なし）。
const realFailure = (codes) => {
  const error = new Error(`Snapshot build failed: ${codes.join(", ")}`);
  return {
    errorShape: sanitizeMessage(error.message),
    errorChain: describeErrorChain(error),
  };
};

// JSON の往復（NaN → null など、stdout と同じ形にして比べる）。
const roundTrip = (v) => JSON.parse(JSON.stringify(v));

const files = {
  "m-ja-1": "records-m-ja-1-v3.json",
  "m-ja-2": "records-m-ja-2-v5.json",
  "m-en-1": "records-m-en-1-v5.json",
};
const poolEntries = () => Object.entries(files).map(([k, f]) => [k, readV5(f)]);
const summaryV5 = readV5("summary-v5.json");
// 第 5 版の records の role はどれも "main"。v5 の m-ja-2 を仮の対照にするときは、
// buildReport に試験用の抜け道を足さず、records の role だけを control-ai-gen に書き換えて渡す
// （本番の経路をそのまま通すため）。
// runId は pool・control・baseline をまたいで一意でなければならないので、別の run の記録として渡す。
const asControl = (d) => ({
  ...d,
  role: "control-ai-gen",
  runId: `${d.runId}-control`,
});
const asBaseline = (d) => ({ ...d, runId: `${d.runId}-baseline` });
const v5Control = () => [["g-ja-1", asControl(readV5(files["m-ja-2"]))]];

function v5Report(extra = {}) {
  return roundTrip(
    buildReport({
      summarizeQueries,
      pool: poolEntries(),
      control: v5Control(),
      ...extra,
    }),
  );
}

// 第 6 版の shapeKey は第 5 版の label を 2 点だけ変える：
//  - 根拠の目録の穴は、参照 ID ごとの別の label（"...hole: E000002, E000003"）を 1 つにまとめる（事前登録 §6）
//  - "Failed query（listEvents）" は "Failed query" にとどめる（どの SELECT か決めつけない）
// 期待値（summary-v5.json）側も同じ規則で変換して比べる。位置・件数は完全一致のまま。
function convertLabels(failuresByShape) {
  const merged = {};
  for (const [label, positions] of Object.entries(failuresByShape)) {
    const key = label.startsWith("Evidence span catalog coverage hole")
      ? "Evidence span catalog coverage hole"
      : label === "Failed query（listEvents）"
        ? "Failed query"
        : label;
    merged[key] = [...(merged[key] ?? []), ...positions].sort((a, b) => a - b);
  }
  return merged;
}
const normalizeExpected = (work) => ({
  ...work,
  extraction: {
    ...work.extraction,
    failuresByShape: convertLabels(work.extraction.failuresByShape),
  },
});

test("(a) pooled と各作品の値が summary-v5.json と一致する", () => {
  const r = v5Report();
  assert.deepEqual(r.pooled, summaryV5.pooled);
  for (const key of Object.keys(files))
    assert.deepEqual(
      r.works[key],
      normalizeExpected(summaryV5.works[key]),
      key,
    );
  // m-ja-1 は label の変換の対象が無いので、失敗の分類は第 5 版のまま。
  assert.deepEqual(
    r.works["m-ja-1"].extraction,
    summaryV5.works["m-ja-1"].extraction,
  );
  // control も同じ形（中身は m-ja-2 の第 5 版）。pooled には入らない。
  assert.deepEqual(
    r.works["g-ja-1"],
    normalizeExpected(summaryV5.works["m-ja-2"]),
  );
  assert.deepEqual(r.checks["m-ja-2"], summaryV5.checks["m-ja-2"]);
  assert.deepEqual(r.checks["m-en-1"], summaryV5.checks["m-en-1"]);
  assert.equal(r.checks["g-ja-1"], "harness の summary と一致");
});

test("第 5 版の label の変換が触れるのは、m-en-1 の穴の統合と Failed query（listEvents）の読み替えの 2 種だけ", () => {
  const r = v5Report();
  const isHole = (l) => l.startsWith("Evidence span catalog coverage hole");
  const isListEvents = (l) => l === "Failed query（listEvents）";
  const changed = new Set();
  for (const [key, work] of Object.entries(summaryV5.works)) {
    const expected = work.extraction.failuresByShape;
    const actual = r.works[key].extraction.failuresByShape;
    for (const [label, positions] of Object.entries(expected)) {
      if (isHole(label)) {
        changed.add(`${key}:hole`);
        continue;
      }
      if (isListEvents(label)) {
        changed.add(`${key}:listEvents`);
        continue;
      }
      // それ以外の label は、名前も位置も恒等。
      assert.deepEqual(actual[label], positions, `${key}: ${label}`);
    }
    // 出力側に、期待値に無い label が増えていない（2 種の統合先を除く）。
    const known = new Set(
      Object.keys(expected).filter((l) => !isHole(l) && !isListEvents(l)),
    );
    for (const label of Object.keys(actual))
      if (
        !known.has(label) &&
        label !== "Evidence span catalog coverage hole" &&
        label !== "Failed query"
      )
        assert.fail(`${key}: 想定外の label ${label}`);
    // 統合先の位置は、元の label の位置の和集合。
    const union = (pred) =>
      Object.entries(expected)
        .filter(([l]) => pred(l))
        .flatMap(([, p]) => p)
        .sort((a, b) => a - b);
    if (union(isHole).length > 0)
      assert.deepEqual(
        actual["Evidence span catalog coverage hole"],
        union(isHole),
        key,
      );
    if (union(isListEvents).length > 0)
      assert.deepEqual(actual["Failed query"], union(isListEvents), key);
  }
  // 穴の統合は m-en-1 だけ。
  assert.ok(changed.has("m-en-1:hole"));
  for (const c of changed)
    if (c.endsWith(":hole")) assert.equal(c, "m-en-1:hole");
  assert.ok([...changed].some((c) => c.endsWith(":listEvents")));
});

test("第 5 版 m-en-1 の穴の 2 つの label は 1 つにまとまる", () => {
  const r = v5Report();
  assert.deepEqual(
    r.works["m-en-1"].extraction.failuresByShape[
      "Evidence span catalog coverage hole"
    ],
    [39, 59],
  );
});

test("(b) D0 の分母は 219 で decidable、D1 は 0／804", () => {
  const r = v5Report();
  assert.deepEqual(r.pooled.D0, {
    irReadyRawLt8: 219,
    threshold: 200,
    decidable: true,
  });
  assert.deepEqual(r.pooled.D1, {
    notBuiltPlusFault: 0,
    samples: 804,
    rate: 0,
    withinLimit: true,
  });
  assert.equal(r.perWorkD1["g-ja-1"].readAsControl, true);
  assert.equal(r.perWorkD1["m-ja-2"].role, "pool");
  assert.equal("readAsControl" in r.perWorkD1["m-ja-2"], false);
});

test("control は pooled に入らない", () => {
  const withControl = v5Report();
  const poolOnly = roundTrip(
    buildReport({ summarizeQueries, pool: poolEntries() }),
  );
  assert.deepEqual(withControl.pooled, poolOnly.pooled);
});

test("(c) memoryControl が組み立てられる", () => {
  const r = v5Report();
  const m = r.memoryControl;
  assert.equal(m.reference, "m-ja-2");
  const ref = m.profiles["m-ja-2"];
  assert.deepEqual(ref.extraction.attempted, 117);
  assert.equal(ref.extraction.completed, 106);
  assert.equal(ref.extraction.failed, 11);
  assert.deepEqual(
    ref.extraction.failuresByShape[
      "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED"
    ],
    [57, 68, 72, 83, 91, 99, 101, 111],
  );
  assert.equal(
    "Failed query（listEvents）" in ref.extraction.failuresByShape,
    false,
  );
  assert.ok("Failed query" in ref.extraction.failuresByShape);
  // 第 5 版 m-ja-2 の harness の extractionSummary と一致する。
  const h = readV5(files["m-ja-2"]).extractionSummary;
  assert.equal(ref.proposals.total, h.proposals);
  assert.equal(ref.proposals.perCompletedScene, h.proposals / h.completed);
  assert.equal(
    ref.proposals.bySignificance["scene-level"] +
      ref.proposals.bySignificance.major,
    h.proposals,
  );
  assert.equal(ref.primary.slotUse, "78/90");
  assert.deepEqual(ref.rawFullRate, {
    numerator: 258,
    denominator: 348,
    value: 258 / 348,
  });
  assert.deepEqual(ref.irEmptyRate, {
    numerator: 0,
    denominator: 348,
    value: 0,
  });
  assert.equal(ref.rawFullWithIr.value, "252/258");
  assert.deepEqual(Object.keys(ref.byPriorScenes), ["lt8", "8to30", "gt30"]);
  assert.equal(ref.tail10.slotUseValue, null);
  // 同じ records を並べたので、差は全部 0（または null）。
  const d = m.differences["g-ja-1"];
  assert.equal(d.extractionCompleted, 0);
  assert.equal(d.primarySlotUseValue, 0);
  assert.equal(d.rawFullRate, 0);
  assert.equal(d.tail10SlotUseValue, null);
});

test("memoryControl：control が無ければ null、control があるのに m-ja-2 が無ければ失敗", () => {
  assert.equal(
    roundTrip(buildReport({ summarizeQueries, pool: poolEntries() }))
      .memoryControl,
    null,
  );
  assert.throws(
    () =>
      buildReport({
        summarizeQueries,
        pool: poolEntries().filter(([k]) => k !== "m-ja-2"),
        control: v5Control(),
      }),
    /m-ja-2/u,
  );
});

test("records の role：--pool は main、--control は control-ai-gen でなければ失敗", () => {
  // 第 5 版の records（role main）をそのまま control に入れると失敗する。
  assert.throws(
    () =>
      buildReport({
        summarizeQueries,
        pool: poolEntries(),
        control: [["g-ja-1", asBaseline(readV5(files["m-ja-2"]))]],
      }),
    /g-ja-1.*role.*control-ai-gen/u,
  );
  assert.throws(
    () =>
      buildReport({
        summarizeQueries,
        pool: [["m-ja-2", asControl(readV5(files["m-ja-2"]))]],
      }),
    /m-ja-2.*role.*main/u,
  );
  const noRole = readV5(files["m-ja-2"]);
  delete noRole.role;
  assert.throws(
    () => buildReport({ summarizeQueries, pool: [["m-ja-2", noRole]] }),
    /role.*null/u,
  );
});

test("出力に definitions と inputs の sha256 が入る", () => {
  const r = roundTrip(
    buildReport({
      summarizeQueries,
      pool: poolEntries(),
      digests: {
        classifySha256: "c".repeat(64),
        records: {
          pool: { "m-ja-2": "a".repeat(64) },
          control: {},
          baseline: {},
        },
      },
    }),
  );
  for (const k of [
    "primary",
    "rawFullRate",
    "irEmptyRate",
    "proposalsPerCompletedScene",
    "D0",
    "D1",
  ])
    assert.equal(typeof r.definitions[k], "string", k);
  assert.match(r.definitions.irEmptyRate, /重なりうる/u);
  assert.match(r.definitions.D1, /ir-timeout は含まない/u);
  assert.equal(r.inputs.irClassifySha256, "c".repeat(64));
  assert.equal(r.inputs.recordsSha256.pool["m-ja-2"], "a".repeat(64));
  // digests を渡さなければ null（嘘の値を入れない）。
  const bare = roundTrip(
    buildReport({ summarizeQueries, pool: poolEntries() }),
  );
  assert.equal(bare.inputs.irClassifySha256, null);
  assert.equal(bare.inputs.recordsSha256, null);
});

test("(d) 同じ records を --baseline に入れると全位置が両方成功か両方失敗", () => {
  const r = v5Report({
    baseline: [["m-ja-2", asBaseline(readV5(files["m-ja-2"]))]],
  });
  const c = r.baselineComparison["m-ja-2"];
  assert.equal(c.counts.bothCompleted, 106);
  assert.equal(c.counts.bothFailed, 11);
  assert.equal(c.counts.failedOnlyInV5, 0);
  assert.equal(c.counts.failedOnlyInV6, 0);
  assert.equal(c.counts.notComparable, 0);
  assert.deepEqual(
    c.positions.bothFailed,
    [53, 57, 65, 68, 72, 83, 91, 99, 101, 107, 111],
  );
  assert.deepEqual(c.v5, c.v6);
  assert.equal(c.v5.total.slotUse, "78/90");
});

test("baseline の key が pool に無ければ失敗する（control の key も不可）", () => {
  assert.throws(
    () =>
      buildReport({
        summarizeQueries,
        pool: poolEntries(),
        baseline: [["x", asBaseline(readV5(files["m-ja-2"]))]],
      }),
    /--baseline の key x が --pool に無い/u,
  );
  assert.throws(
    () =>
      buildReport({
        summarizeQueries,
        pool: poolEntries(),
        control: v5Control(),
        baseline: [["g-ja-1", asBaseline(readV5(files["m-ja-2"]))]],
      }),
    /--baseline の key g-ja-1 が --pool に無い/u,
  );
});

test("baseline の検査：runId・role・language・sceneCount・key の重複", () => {
  const base = () => asBaseline(readV5(files["m-ja-2"]));
  const run = (baseline) => () =>
    buildReport({
      summarizeQueries,
      pool: poolEntries(),
      control: v5Control(),
      baseline,
    });
  // 正しい baseline は通る。
  assert.doesNotThrow(run([["m-ja-2", base()]]));
  // current と同じ runId（同じ records の二重投入）。
  assert.throws(
    run([["m-ja-2", readV5(files["m-ja-2"])]]),
    /runId が重複.*main5-m-ja-2/u,
  );
  // 別の作品の runId を持つ baseline も重複。
  assert.throws(
    run([["m-ja-2", { ...base(), runId: readV5(files["m-en-1"]).runId }]]),
    /runId が重複/u,
  );
  // control の runId との重複。
  assert.throws(
    run([["m-ja-2", { ...base(), runId: v5Control()[0][1].runId }]]),
    /runId が重複/u,
  );
  // runId が無い baseline。
  const noRun = base();
  delete noRun.runId;
  assert.throws(run([["m-ja-2", noRun]]), /runId が無い/u);
  // role は main。
  assert.throws(
    run([["m-ja-2", { ...base(), role: "control-ai-gen" }]]),
    /role.*"main"/u,
  );
  assert.throws(
    run([["m-ja-2", { ...base(), role: undefined }]]),
    /role.*null/u,
  );
  // language と sceneCount は current と一致。
  assert.throws(
    run([["m-ja-2", { ...base(), language: "en" }]]),
    /language.*"en".*"ja"/u,
  );
  const noLang = base();
  delete noLang.language;
  assert.throws(run([["m-ja-2", noLang]]), /language.*null/u);
  assert.throws(
    run([["m-ja-2", { ...base(), sceneCount: 116 }]]),
    /sceneCount.*116.*117/u,
  );
  // baseline の key の重複。
  assert.throws(
    run([
      ["m-ja-2", base()],
      ["m-ja-2", { ...base(), runId: "other" }],
    ]),
    /--baseline の key が重複/u,
  );
});

test("runId の重複は pool・control の間でも失敗する（無ければ失敗）", () => {
  const pool = poolEntries();
  assert.throws(
    () =>
      buildReport({
        summarizeQueries,
        pool,
        control: [
          [
            "g-ja-1",
            { ...asControl(readV5(files["m-ja-2"])), runId: pool[1][1].runId },
          ],
        ],
      }),
    /runId が重複/u,
  );
  assert.throws(
    () =>
      buildReport({
        summarizeQueries,
        pool: [
          ["m-ja-2", readV5(files["m-ja-2"])],
          ["m-en-1", { ...readV5(files["m-en-1"]), runId: "main5-m-ja-2" }],
        ],
      }),
    /runId が重複/u,
  );
  const noRun = readV5(files["m-ja-2"]);
  delete noRun.runId;
  assert.throws(
    () => buildReport({ summarizeQueries, pool: [["m-ja-2", noRun]] }),
    /m-ja-2.*runId が無い/u,
  );
});

test("key の重複は失敗する", () => {
  assert.throws(
    () =>
      buildReport({
        summarizeQueries,
        pool: poolEntries(),
        control: [["m-ja-2", asControl(readV5(files["m-ja-2"]))]],
      }),
    /重複/u,
  );
});

// ---- 合成の record（第 6 版で増える項目） ----

const sample = (over = {}) => ({
  status: "completed",
  initialSnapshot: { indexUsable: true, querySupported: true },
  completion: { outcome: "ir-ready" },
  resultKind: "fused",
  irStatus: "available",
  rows: [{ position: 1, kind: "ir" }],
  rawCount: 0,
  rawPositions: [],
  ...over,
});
const query = (position, samples, over = {}) => ({
  position,
  priorScenes: position - 1,
  priorScenesBucket: "lt8",
  tail10: false,
  probe: null,
  samples,
  ...over,
});
const done = (position, proposals = []) => ({
  position,
  status: "completed",
  proposals,
});
const failed = (position, over = {}) => ({
  position,
  status: "failed",
  errorCode: "extraction-failed",
  errorShape: "Snapshot build failed: SNAPSHOT_SOURCE_READ_FAILED",
  proposals: [],
  ...over,
});
let runSeq = 0;
const records = (extraction, queries, role = "main", over = {}) => ({
  role,
  runId: `synthetic-${++runSeq}`,
  language: "ja",
  status: "complete-with-failures",
  sceneCount: extraction.length,
  extraction,
  checkpoints: [{ fraction: 1, sceneCount: extraction.length, queries }],
  ...over,
});

test("shapeKey：第 5 版の分類を残し、code は文字列のどこにあっても同じ規則で拾う", () => {
  assert.equal(shapeKey({}), "(なし)");
  // errorShape が無い失敗は errorCode を添える。
  assert.equal(
    shapeKey({ errorCode: "extraction-failed" }),
    "(なし:extraction-failed)",
  );
  assert.equal(shapeKey({ errorShape: null, errorCode: null }), "(なし)");
  assert.equal(
    shapeKey({ errorShape: "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED" }),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED",
  );
  // 第 5 版の record：32 字以上の code は <long> に伏せられていた（既知は SCOPE_VALIDATION_FAILED）。label はそのまま。
  assert.equal(
    shapeKey({ errorShape: "Snapshot build failed: <long>" }),
    "Snapshot build failed: <long>",
  );
  // "Failed query" は接頭辞だけ（どの SELECT か決めつけない）。
  assert.equal(
    shapeKey({ errorShape: "Failed query: select" }),
    "Failed query",
  );
  assert.equal(
    shapeKey({
      errorShape:
        "AI request failed (503): Service temporarily unavailable. Please try again later and more",
    }),
    "AI request failed (503): Service temporarily unavailable. Pl",
  );
  assert.equal(
    shapeKey({
      errorShape: "Snapshot build failed: SNAPSHOT_SOURCE_READ_FAILED: timeout",
    }),
    "Snapshot build failed: SNAPSHOT_SOURCE_READ_FAILED",
  );
  assert.equal(
    shapeKey({ errorShape: "Evidence span catalog coverage hole: a, b" }),
    "Evidence span catalog coverage hole",
  );
  // 前後に英数字が続く列は一体の列で、code として拾わない。
  assert.equal(
    shapeKey({ errorShape: "failed: XSNAPSHOT_SOURCE_CHANGED" }),
    "failed: XSNAPSHOT_SOURCE_CHANGED",
  );
  // NEX_ の code も同じ規則（文字列の途中にあっても）。prefix がある形は code の後ろの文言を残さない。
  assert.equal(
    shapeKey({ errorShape: "outer: wrapped NEX_FOO_BAR happened" }),
    "outer: wrapped: NEX_FOO_BAR",
  );
  // prefix が無い形は "(code)" を置き、code の後ろの文言の先頭も残す。
  assert.equal(
    shapeKey({ errorShape: "NEX_FOO_BAR happened here" }),
    "(code): NEX_FOO_BAR: happened here",
  );
  // code だけなら後ろの文言は無い。
  assert.equal(shapeKey({ errorShape: "NEX_FOO_BAR" }), "(code): NEX_FOO_BAR");
});

test("shapeKey：Failed query と coverage hole は固定 code の探索より前に決める", () => {
  // SQL の中の大文字の識別子が code の形に見えても、label は割れない。
  assert.equal(
    shapeKey({
      errorShape:
        'Failed query: select "id" from "SNAPSHOT_SOURCE_ROWS" where NEX_FOO_BAR = ?',
    }),
    "Failed query",
  );
  assert.equal(
    shapeKey({
      errorShape: "Failed query: select SNAPSHOT_AAA_BBB, SNAPSHOT_CCC_DDD",
    }),
    "Failed query",
  );
  assert.equal(
    shapeKey({
      errorShape:
        "Evidence span catalog coverage hole: SNAPSHOT_EVIDENCE_E000002",
    }),
    "Evidence span catalog coverage hole",
  );
  assert.equal(
    shapeKey({
      errorShape:
        "Snapshot build failed: Evidence span catalog coverage hole NEX_FOO_BAR",
    }),
    "Evidence span catalog coverage hole",
  );
});

test("shapeKey：prefix が空なら code の後ろの文言の先頭 40 字を残す", () => {
  // 第 5 版では "<long>: eventOutput event count mismatch" だった形（第 6 版では code が残る）。
  assert.equal(
    shapeKey({
      errorShape:
        "SNAPSHOT_SCOPE_VALIDATION_FAILED: eventOutput event count mismatch",
    }),
    "(code): SNAPSHOT_SCOPE_VALIDATION_FAILED: eventOutput event count mismatch",
  );
  // 40 字で切る。
  const tail = "a".repeat(30) + " " + "b".repeat(30);
  assert.equal(
    shapeKey({ errorShape: `SNAPSHOT_SOURCE_CHANGED, ${tail}` }),
    `(code): SNAPSHOT_SOURCE_CHANGED: ${tail.slice(0, 40)}`,
  );
  // 複数の code：最後の code の後ろの文言を残す（code の間の文言は label に入れない）。
  assert.equal(
    shapeKey({
      errorShape:
        "SNAPSHOT_SOURCE_READ_FAILED, between, SNAPSHOT_SOURCE_CHANGED: tail text",
    }),
    "(code): SNAPSHOT_SOURCE_CHANGED, SNAPSHOT_SOURCE_READ_FAILED: tail text",
  );
  // prefix がある通常の形は今のまま（後ろの文言は残さない）。
  assert.equal(
    shapeKey({
      errorShape:
        "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, SNAPSHOT_SOURCE_READ_FAILED",
    }),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, SNAPSHOT_SOURCE_READ_FAILED",
  );
  // 240 字で切れた code は、後ろの文言にも入れない。
  const cut = `${"SNAPSHOT_SOURCE_CHANGED, ".repeat(10)}`.slice(0, 240);
  const padded = {
    errorShape: (cut + "SNAPSHOT_SOURCE_CHANGED").slice(0, 240),
  };
  assert.equal(padded.errorShape.length, 240);
  assert.equal(shapeKey(padded), "(code): SNAPSHOT_SOURCE_CHANGED");
});

test("shapeKey：code と code の間の <long> も label の末尾に足す", () => {
  assert.equal(
    shapeKey({
      errorShape:
        "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, <long>, SNAPSHOT_SOURCE_READ_FAILED",
    }),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, SNAPSHOT_SOURCE_READ_FAILED, <long>",
  );
  // 最後の code の後ろの <long>（従来どおり）。
  assert.equal(
    shapeKey({
      errorShape: "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, <long>",
    }),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, <long>",
  );
  // <long> が複数あっても 1 つ。
  assert.equal(
    shapeKey({
      errorShape: "x: SNAPSHOT_AAA_BBB, <long>, SNAPSHOT_CCC_DDD, <long>",
    }),
    "x: SNAPSHOT_AAA_BBB, SNAPSHOT_CCC_DDD, <long>",
  );
  // 最初の code より前の <long> は prefix に残る（足さない）。
  assert.equal(
    shapeKey({ errorShape: "<long> wrapped: SNAPSHOT_SOURCE_CHANGED" }),
    "<long> wrapped: SNAPSHOT_SOURCE_CHANGED",
  );
});

test("shapeKey：code が無い Snapshot build failed は <long> を含むときだけ <long> の label", () => {
  assert.equal(
    shapeKey({ errorShape: "Snapshot build failed: <long>" }),
    "Snapshot build failed: <long>",
  );
  assert.equal(
    shapeKey({ errorShape: "Snapshot build failed: <long>, <long>" }),
    "Snapshot build failed: <long>",
  );
  // <long> を含まなければ、shape を LABEL_MAX（60 字）で切った値。
  assert.equal(
    shapeKey({ errorShape: "Snapshot build failed: something else happened" }),
    "Snapshot build failed: something else happened",
  );
  const long = `Snapshot build failed: ${"z".repeat(80)}`;
  assert.equal(shapeKey({ errorShape: long }), long.slice(0, 60));
  assert.equal(
    shapeKey({ errorShape: "Snapshot build failed" }),
    "Snapshot build failed",
  );
});

test("shapeKey：harness の実物（sanitizeMessage／describeErrorChain）に new Error を通した本番の形", () => {
  // 前提：v6 の harness は固定の診断 code を 32 字以上でも伏せない。
  const scope = realFailure(["SNAPSHOT_SCOPE_VALIDATION_FAILED"]);
  assert.equal(
    scope.errorShape,
    "Snapshot build failed: SNAPSHOT_SCOPE_VALIDATION_FAILED",
  );
  // 本番の Error は .code・.cause を持たないので、errorChain の code は null（分類には使えない）。
  assert.equal(scope.errorChain.chain[0].code, null);
  assert.equal(
    shapeKey(scope),
    "Snapshot build failed: SNAPSHOT_SCOPE_VALIDATION_FAILED",
  );
  assert.equal(
    shapeKey(realFailure(["SNAPSHOT_SOURCE_READ_FAILED"])),
    "Snapshot build failed: SNAPSHOT_SOURCE_READ_FAILED",
  );
  assert.equal(
    shapeKey(realFailure(["SNAPSHOT_SOURCE_CHANGED"])),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED",
  );
  // 複数の code：並び順に依らず辞書順に連結し、重複は 1 つにする。
  assert.equal(
    shapeKey(
      realFailure([
        "SNAPSHOT_SOURCE_READ_FAILED",
        "SNAPSHOT_SCOPE_VALIDATION_FAILED",
        "SNAPSHOT_SOURCE_CHANGED",
        "SNAPSHOT_SOURCE_CHANGED",
      ]),
    ),
    "Snapshot build failed: SNAPSHOT_SCOPE_VALIDATION_FAILED, SNAPSHOT_SOURCE_CHANGED, SNAPSHOT_SOURCE_READ_FAILED",
  );
  assert.equal(
    shapeKey(
      realFailure(["SNAPSHOT_SOURCE_READ_FAILED", "SNAPSHOT_SOURCE_CHANGED"]),
    ),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, SNAPSHOT_SOURCE_READ_FAILED",
  );
  // 33 字の SNAPSHOT_DOCUMENT_ORIGIN_MISMATCH なども同じ規則で拾える。
  assert.equal(
    shapeKey(realFailure(["SNAPSHOT_DOCUMENT_ORIGIN_MISMATCH"])),
    "Snapshot build failed: SNAPSHOT_DOCUMENT_ORIGIN_MISMATCH",
  );
  // 語彙の外の長い列は harness が <long> に伏せたまま。code と並ぶときは <long> も残す。
  const unknown = realFailure(["A".repeat(40)]);
  assert.equal(unknown.errorShape, "Snapshot build failed: <long>");
  assert.equal(shapeKey(unknown), "Snapshot build failed: <long>");
  assert.equal(
    shapeKey(realFailure(["SNAPSHOT_SOURCE_CHANGED", "B".repeat(40)])),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED, <long>",
  );
  // 240 字（MESSAGE_MAX）で切れた形：切れた末尾の code（SNAPSHOT_SOURCE_C など）を拾わない。
  const many = realFailure(Array(12).fill("SNAPSHOT_SOURCE_CHANGED"));
  assert.equal(many.errorShape.length, 240);
  assert.match(many.errorShape, /SNAPSHOT_SOURCE_C$/u);
  assert.equal(
    shapeKey(many),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED",
  );
  // 件数が違っても（切れる／切れない）同じ原因は同じ label になる。
  assert.equal(
    shapeKey(many),
    shapeKey(realFailure(["SNAPSHOT_SOURCE_CHANGED"])),
  );
  // 240 字ちょうどで、完全な code で終わる場合も切れた可能性があるので外す（前の code は残る）。
  const tailCode = ", SNAPSHOT_SOURCE_READ_FAILED";
  const head = "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED";
  const exact = {
    errorShape:
      head +
      " " +
      "x".repeat(240 - head.length - tailCode.length - 1) +
      tailCode,
  };
  assert.equal(exact.errorShape.length, 240);
  assert.equal(
    shapeKey(exact),
    "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED",
  );
  // 切れた code しか残らないときは <切断>。
  const onlyCut = {
    errorShape: `${"y".repeat(220)} SNAPSHOT_SOURCE_CHANGED`.slice(0, 240),
  };
  assert.equal(onlyCut.errorShape.length, 240);
  assert.equal(shapeKey(onlyCut), `${"y".repeat(60)}: <切断>`);
  // 240 字に満たなければ末尾の code も拾う。
  assert.equal(
    shapeKey({ errorShape: "failed: SNAPSHOT_SOURCE_CHANGED" }),
    "failed: SNAPSHOT_SOURCE_CHANGED",
  );
  // errorChain は分類に使わない（手で code を入れた record でも errorShape で決まる）。
  assert.equal(
    shapeKey({
      errorShape: "Snapshot build failed: <long>",
      errorChain: {
        chain: [{ depth: 0, code: "SNAPSHOT_SCOPE_VALIDATION_FAILED" }],
      },
    }),
    "Snapshot build failed: <long>",
  );
});

test("extractionTiming：connectionWait と failedAtMs の件数・最大・中央値", () => {
  const ex = [
    done(1),
    failed(2, {
      failedAtMs: 100,
      connectionWait: {
        ready: true,
        timedOut: false,
        waitedMs: 2000,
        polls: 3,
      },
    }),
    failed(3, {
      failedAtMs: 300,
      connectionWait: {
        ready: false,
        timedOut: true,
        waitedMs: 120000,
        polls: 100,
      },
    }),
    failed(4, {
      failedAtMs: 200,
      connectionWait: {
        ready: true,
        timedOut: false,
        waitedMs: 4000,
        polls: 5,
      },
    }),
    failed(5, {
      failedAtMs: 400,
      connectionWait: {
        ready: false,
        timedOut: false,
        waitedMs: 0,
        polls: 0,
        lastState: { phase: "wait-failed" },
      },
    }),
    failed(6),
  ];
  const r = roundTrip(
    buildReport({
      summarizeQueries,
      pool: [["m-ja-2", records(ex, [query(2, [sample()])])]],
    }),
  );
  assert.deepEqual(r.extractionTiming["m-ja-2"], {
    failedExtractions: 5,
    withConnectionWait: 4,
    ready: 2,
    timedOut: 1,
    waitFailed: 1,
    waitedMsMax: 120000,
    waitedMsMedian: 3000,
    failedAtMsMedian: 250,
  });
});

test("extractionTiming：項目が無ければ null", () => {
  const r = roundTrip(
    buildReport({
      summarizeQueries,
      pool: [["m-ja-2", records([done(1), failed(2)], [query(2, [sample()])])]],
    }),
  );
  assert.deepEqual(r.extractionTiming["m-ja-2"], {
    failedExtractions: 1,
    withConnectionWait: 0,
    ready: 0,
    timedOut: 0,
    waitFailed: 0,
    waitedMsMax: null,
    waitedMsMedian: null,
    failedAtMsMedian: null,
  });
});

test("第 6 版の失敗の形が failuresByShape に別々に数えられる", () => {
  const ex = [
    done(1),
    failed(2),
    failed(3, realFailure(["SNAPSHOT_SCOPE_VALIDATION_FAILED"])),
    failed(4, { errorShape: "Evidence span catalog coverage hole: x" }),
    failed(5, { errorShape: "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED" }),
    failed(6, { errorShape: undefined }),
    failed(7, { errorShape: undefined, errorCode: undefined }),
    failed(8, { errorShape: "Snapshot build failed: <long>" }),
  ];
  const r = roundTrip(
    buildReport({
      summarizeQueries,
      pool: [["m-ja-2", records(ex, [query(2, [sample()])])]],
    }),
  );
  assert.deepEqual(r.works["m-ja-2"].extraction, {
    attempted: 8,
    completed: 1,
    failuresByShape: {
      "Snapshot build failed: SNAPSHOT_SOURCE_READ_FAILED": [2],
      "Snapshot build failed: SNAPSHOT_SCOPE_VALIDATION_FAILED": [3],
      "Evidence span catalog coverage hole": [4],
      "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED": [5],
      "(なし:extraction-failed)": [6],
      "(なし)": [7],
      "Snapshot build failed: <long>": [8],
    },
  });
});

test("baselineComparison：位置ごとの 4 通りと、片方にしか無い位置", () => {
  const v5 = records(
    [done(1), done(2), failed(3), failed(4), done(5)],
    [query(2, [sample()])],
    "main",
    { sceneCount: 5 },
  );
  const v6 = records(
    [
      done(1),
      failed(2),
      done(3),
      failed(4, { errorShape: "Evidence span catalog coverage hole: x" }),
    ],
    [query(2, [sample()])],
    "main",
    { sceneCount: 5 },
  );
  const r = roundTrip(
    buildReport({
      summarizeQueries,
      pool: [["m-ja-2", v6]],
      baseline: [["m-ja-2", v5]],
    }),
  );
  const c = r.baselineComparison["m-ja-2"];
  assert.deepEqual(c.positions, {
    bothCompleted: [1],
    failedOnlyInV5: [3],
    failedOnlyInV6: [2],
    bothFailed: [4],
    notComparable: [5],
  });
  assert.deepEqual(c.counts, {
    bothCompleted: 1,
    failedOnlyInV5: 1,
    failedOnlyInV6: 1,
    bothFailed: 1,
    notComparable: 1,
  });
  assert.equal(c.v5.attempted, 5);
  assert.equal(c.v6.attempted, 4);
  assert.equal(c.v6.completed, 2);
});

test("control の D1 を超えると readAsControl が false、pooled に入らない", () => {
  const bad = (n) =>
    Array.from({ length: n }, () =>
      sample({ initialSnapshot: { indexUsable: false, querySupported: true } }),
    );
  const good = Array.from({ length: 19 }, () => sample());
  const control = records(
    [done(1), done(2)],
    [query(2, [...good, ...bad(2)])],
    "control-ai-gen",
  ); // 2/21 > 5％
  const r = roundTrip(
    buildReport({
      summarizeQueries,
      pool: [["m-ja-2", records([done(1), done(2)], [query(2, good)])]],
      control: [["g-ja-1", control]],
    }),
  );
  assert.equal(r.perWorkD1["g-ja-1"].notBuiltPlusFault, 2);
  assert.equal(r.perWorkD1["g-ja-1"].samples, 21);
  assert.equal(r.perWorkD1["g-ja-1"].withinLimit, false);
  assert.equal(r.perWorkD1["g-ja-1"].readAsControl, false);
  assert.equal(r.pooled.samples, 19);
  assert.equal(r.pooled.D1.withinLimit, true);
});

test("memoryControl：Raw の満杯率・IR が空の割合・提案の分布・差", () => {
  const raw8 = Array.from({ length: 8 }, (_, i) => i + 1);
  const full = sample({
    resultKind: "raw",
    irStatus: "empty",
    rows: raw8.map((p) => ({ position: p, kind: "raw" })),
    rawCount: 8,
    rawPositions: raw8,
  });
  const empty = sample({
    resultKind: "raw",
    irStatus: "empty",
    rows: [{ position: 1, kind: "raw" }],
    rawCount: 1,
    rawPositions: [1],
  });
  const used = sample();
  const prop = (significance, actuality) => ({ significance, actuality });
  const ref = records(
    [
      done(1, [prop("major", "actual"), prop("scene-level", "actual")]),
      done(2, [prop("scene-level", "attempted")]),
      failed(3),
    ],
    [query(2, [used, used, empty, full])],
  );
  const ctl = records(
    [done(1, [prop("scene-level", "actual")]), done(2), done(3)],
    [query(2, [used, empty, empty, empty])],
    "control-ai-gen",
  );
  const r = roundTrip(
    buildReport({
      summarizeQueries,
      pool: [["m-ja-2", ref]],
      control: [["g-ja-1", ctl]],
    }),
  );
  const a = r.memoryControl.profiles["m-ja-2"];
  const b = r.memoryControl.profiles["g-ja-1"];
  assert.deepEqual(a.proposals.bySignificance, { major: 1, "scene-level": 2 });
  assert.deepEqual(a.proposals.byActuality, { actual: 2, attempted: 1 });
  assert.equal(a.proposals.total, 3);
  assert.equal(a.proposals.perCompletedScene, 1.5);
  assert.equal(b.proposals.perCompletedScene, 1 / 3);
  assert.deepEqual(a.rawFullRate, {
    numerator: 1,
    denominator: 4,
    value: 0.25,
  });
  assert.deepEqual(a.irEmptyRate, { numerator: 2, denominator: 4, value: 0.5 });
  assert.deepEqual(b.irEmptyRate, {
    numerator: 3,
    denominator: 4,
    value: 0.75,
  });
  assert.equal(a.extraction.failed, 1);
  const d = r.memoryControl.differences["g-ja-1"];
  assert.equal(d.irEmptyRate, 0.25);
  assert.equal(d.rawFullRate, -0.25);
  assert.equal(d.extractionCompleted, 1);
  assert.equal(d.proposalsTotal, -2);
});

test("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([3]), 3);
  assert.equal(median([1, 9, 5]), 5);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

test("parseArgs：flag ごとに key=file を集める", () => {
  assert.deepEqual(
    parseArgs([
      "/c.mjs",
      "--pool",
      "m-ja-2=x.json",
      "b=y.json",
      "--control",
      "g=z.json",
      "--baseline",
      "m-ja-2=w.json",
    ]),
    {
      classifyPath: "/c.mjs",
      pool: [
        ["m-ja-2", "x.json"],
        ["b", "y.json"],
      ],
      control: [["g", "z.json"]],
      baseline: [["m-ja-2", "w.json"]],
    },
  );
  assert.throws(
    () => parseArgs(["/c.mjs", "--control", "g=z.json"]),
    /--pool/u,
  );
  assert.throws(() => parseArgs(["/c.mjs", "--pool", "bad"]), /key=records/u);
});

test("parseArgs：--control が空、--pool に m-ja-2 が無いときは理由つきで失敗する", () => {
  assert.throws(
    () => parseArgs(["/c.mjs", "--pool", "m-ja-2=x.json"]),
    /--control が必要/u,
  );
  assert.throws(
    () =>
      parseArgs(["/c.mjs", "--pool", "m-ja-1=x.json", "--control", "g=z.json"]),
    /--pool に m-ja-2/u,
  );
});

test("parseArgs：同じ flag の key の重複、prototype の名前、不正な key は失敗する", () => {
  const ok = ["/c.mjs", "--pool", "m-ja-2=x.json", "--control", "g=z.json"];
  for (const flag of ["--pool", "--control", "--baseline"])
    assert.throws(
      () => parseArgs([...ok, flag, "k=a.json", "k=b.json"]),
      /重複/u,
      flag,
    );
  // "toString" や "constructor" は flag ではなく、flag の前の引数として扱われる。
  assert.throws(() => parseArgs(["/c.mjs", "toString"]), /flag の前/u);
  assert.throws(() => parseArgs(["/c.mjs", "constructor"]), /flag の前/u);
  assert.throws(
    () => parseArgs([...ok, "--baseline", "__proto__=a.json"]),
    /key の形が不正/u,
  );
});

test("CLI：stdout の JSON が buildReport と一致する（sha256 も）", () => {
  const sha = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  // CLI は records の role を検証するので、control 用に role を書き換えた records を一時 file に置く。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agg-v6-test-"));
  try {
    const controlFile = path.join(tmp, "control.json");
    fs.writeFileSync(
      controlFile,
      JSON.stringify(asControl(readV5(files["m-ja-2"]))),
    );
    const baselineFile = path.join(tmp, "baseline.json");
    fs.writeFileSync(
      baselineFile,
      JSON.stringify(asBaseline(readV5(files["m-ja-2"]))),
    );
    const poolFiles = Object.fromEntries(
      Object.entries(files).map(([k, f]) => [k, path.join(V5_DIR, f)]),
    );
    const out = execFileSync(
      process.execPath,
      [
        path.join(HERE, "agg-v6.mjs"),
        CLASSIFY,
        "--pool",
        ...Object.entries(poolFiles).map(([k, f]) => `${k}=${f}`),
        "--control",
        `g-ja-1=${controlFile}`,
        "--baseline",
        `m-ja-2=${baselineFile}`,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const cli = JSON.parse(out);
    assert.deepEqual(
      cli,
      v5Report({
        baseline: [["m-ja-2", asBaseline(readV5(files["m-ja-2"]))]],
        digests: {
          classifySha256: sha(CLASSIFY),
          records: {
            pool: Object.fromEntries(
              Object.entries(poolFiles).map(([k, f]) => [k, sha(f)]),
            ),
            control: { "g-ja-1": sha(controlFile) },
            baseline: { "m-ja-2": sha(baselineFile) },
          },
        },
      }),
    );
    assert.match(cli.inputs.irClassifySha256, /^[0-9a-f]{64}$/u);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI：symlink 経由の起動でも実行される", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agg-v6-link-"));
  try {
    const link = path.join(tmp, "link.mjs");
    fs.symlinkSync(path.join(HERE, "agg-v6.mjs"), link);
    // 引数が足りないので失敗するが、main が走った証拠として usage の失敗が出る（無言で終わらない）。
    assert.throws(
      () => execFileSync(process.execPath, [link], { stdio: "pipe" }),
      /ir-classify\.mjs の path が必要/u,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("240 字で切れた失敗は、label とは別に位置を出し、prefix の無い rest に code の断片を残さない", async () => {
  const { sanitizeMessage } = await import(pathToFileURL(ERROR_RECORD).href);
  const many = Array.from(
    { length: 8 },
    () => "SNAPSHOT_SOURCE_READ_FAILED",
  ).join(", ");
  const shape = sanitizeMessage(
    `Snapshot build failed: ${many}, SNAPSHOT_SOURCE_CHANGED`,
  );
  assert.equal(shape.length, 240);
  const e = { position: 3, status: "failed", errorShape: shape };
  assert.equal(isTruncatedShape(e), true);
  assert.equal(
    shapeKey(e),
    "Snapshot build failed: SNAPSHOT_SOURCE_READ_FAILED",
  );
  assert.equal(isTruncatedShape({ errorShape: "short" }), false);
  // prefix が無く 240 字で切れた形：rest の末尾の語の断片は落とす。
  const noPrefix = `NEX_FOO_BAR: ${"x".repeat(200)} tail SNAPSHOT_SO`.slice(
    0,
    240,
  );
  const padded = noPrefix.padEnd(240, "y");
  const label = shapeKey({ errorShape: padded });
  assert.ok(label.startsWith("(code): NEX_FOO_BAR"), label);
  assert.ok(!/SNAPSHOT_SO$/u.test(label), label);
  // prefix の切り口に区切りが残らない。
  const longPrefix = `${"a".repeat(59)}: SNAPSHOT_SOURCE_CHANGED`;
  assert.equal(
    shapeKey({ errorShape: longPrefix }),
    `${"a".repeat(59)}: SNAPSHOT_SOURCE_CHANGED`,
  );
});
