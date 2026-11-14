// 同定の review の負荷の測定：集計（件数だけの records。事前登録 §7・§10）。
// 入力は測定 A・B の出力（repo 外の 0700／0600）。出力は件数・ID・範囲・コードだけで、
// 原稿の本文・題・人物名・表記の文字列・引用・credential の欄を持たない（assertRecordsClean が検査する）。
//   - 作品×段×場面数の表、A と B は別表、合算も優劣づけもしない
//   - 範囲表示：A は作品間の最小〜最大（平均しない）、B は作品×段ごとに 3 回の最小〜最大
//   - ★の対応表：どの値でも、どの選択肢を支持するかは決めない（decided: false）
// 起動：node scripts/quality/identity-review-load/aggregate.mjs [--output <root>] [--out <dir>]
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertOutputClean,
  findUnsafeStrings,
  safeErrorSummary,
} from "./lib.mjs";
import {
  carryOverStability,
  compareSets,
  surfaceKindSet,
} from "./measure-a-metrics.mjs";
import { DEFAULT_OUTPUT, writeJson0600 } from "./launcher-common.mjs";

function writeText0600(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export const RECORDS_SCHEMA = "identity-load-records/1";
export const EVIDENCE_SCOPE = "not-cp4-evidence";
export const DECLARATIONS = Object.freeze(["not-quality-claim", "not-gold"]);
/** §10：欄の拒否。名前が credential を示すものは records に置かない（token の件数は credential ではない）。 */
export const FORBIDDEN_KEY =
  /authorization|api[-_]?key|credential|password|bearer|secret/iu;
export const AMBIGUOUS_MATERIAL_MINIMUM = 5; // §8-5：4 作の合計が 5 未満なら「材料なし」

// ---- 測定 A ------------------------------------------------------------------

/** 1 run の指標（renderer・measure-a-metrics の出力）を、表の列（件数）に平らにする。 */
export function flattenRunA(run) {
  const m = run.metrics;
  const c = m.categoryCounts;
  const u = m.unresolved.rankCounts;
  return {
    sceneCount: run.extract?.sceneCount ?? null,
    entryCount: run.extract?.entryCountInCatalog ?? null,
    proposals: m.proposalCount,
    notInRoster: c.notInRoster,
    bindCheck: c.bindCheck,
    unresolvedCandidateIn: c.unresolvedCandidateIn,
    unresolvedCandidateOut: c.unresolvedCandidateOut,
    typeNeeded: c.typeNeeded,
    bulk: c.bulk,
    manualCreate: c.manualCreate,
    rank1: u.r1,
    rank2: u.r2,
    rank3: u.r3,
    rank4to10: u.r4to10,
    rank11plus: u.r11plus,
    unresolvedListed: m.partial.unresolvedListed,
    partialWithCandidate: m.partial.withPartialCandidate,
    partialAnyWrong: m.partial.anyPartialWrong,
    partialAllWrong: m.partial.allPartialWrong,
    partialSlots: m.partial.partialSlots,
    partialSlotsWrong: m.partial.partialSlotsWrong,
    wrongTarget: m.mismatch.wrongTarget,
    leftoverCreateNew: m.mismatch.leftoverCreateNew,
    leftoverUnresolvedOut: m.mismatch.leftoverUnresolvedOut,
    cleanupBulkOfKnownEntity: m.mismatch.cleanupBulkOfKnownEntity,
    typePersonOnNonCharacter: m.mismatch.typePersonOnNonCharacter,
    typePersonOnNonCharacterInBulk: m.mismatch.typePersonOnNonCharacterInBulk,
    collisionAmbiguousRows: m.collision.ambiguousRows,
    collisionNameOverAliasRows: m.collision.nameOverAliasRows,
    sceneRangeRows: m.collision.sceneRangeRows,
    sceneRangeUnresolved: m.collision.sceneRangeByBinding.unresolved ?? 0,
    honorificStripCandidateUnresolvedListed:
      m.honorific.unresolvedWithHonorificStripCandidate,
    opsApprovalSurface: m.operations.surfaceUnit.approval,
    opsKeepSurfaceSurface: m.operations.surfaceUnit.keepSurface,
    opsApprovalEntity: m.operations.entityUnit.approval,
    opsKeepSurfaceEntity: m.operations.entityUnit.keepSurface,
    completed: run.completed ? 1 : 0,
  };
}

export function rangeOf(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return { n: 0, min: null, max: null };
  return { n: nums.length, min: Math.min(...nums), max: Math.max(...nums) };
}

const MATRIX_LEVELS = ["empty", "L0", "L1", "L2", "L3", "L2-1char"];

/**
 * cells：run-measure-a の採用済みの cell の JSON。rowsByCell：cell id → [{ label, rows }]。
 * 作品ごとの表（matrix・決定性・累積・単独）と、決定性・累積の一致の検査、作品間の範囲。
 */
export function buildMeasureA({ cells, rowsByCell }) {
  const byWork = {};
  for (const cell of cells) {
    const w = (byWork[cell.work] ??= {
      matrix: {},
      cumulative: [],
      solo: [],
      determinism: null,
      checks: {},
    });
    const runs = cell.runs ?? [];
    if (cell.kind === "matrix") w.matrix[cell.level] = flattenRunA(runs[0]);
    else if (cell.kind === "baseline") w.matrix.empty = flattenRunA(runs[0]);
    else if (cell.kind === "determinism") w.determinism = flattenRunA(runs[0]);
    else if (cell.kind === "cumulative")
      w.cumulative = runs.map((run) => ({
        label: run.label,
        ...flattenRunA(run),
      }));
    else if (cell.kind === "solo")
      w.solo.push({ label: runs[0].label, ...flattenRunA(runs[0]) });
  }
  // 一致の検査（表記×提案の種類の集合。提案 id・scene id は run ごとに変わるので比べない）。
  for (const [work, w] of Object.entries(byWork)) {
    const rows = (id) => rowsByCell[id] ?? null;
    const set = (id, label) => {
      const found = rows(id)?.find((r) => r.label === label);
      return found ? surfaceKindSet(found.rows) : null;
    };
    const matrixL2 = set(`${work}-matrix-L2`, "F100");
    const determinism = set(`${work}-determinism-L2`, "F100");
    const cumulative100 = set(`${work}-cumulative-L2`, "F100");
    if (matrixL2 && determinism)
      w.checks.determinismVsMatrixL2 = compareSets(matrixL2, determinism);
    if (matrixL2 && cumulative100)
      w.checks.cumulativeLastVsMatrixL2 = compareSets(matrixL2, cumulative100);
    for (const p of [25, 50, 75]) {
      const solo = set(`${work}-solo-L2-F${p}`, `F${p}`);
      const cum = set(`${work}-cumulative-L2`, `F${p}`);
      if (solo && cum)
        (w.checks.cumulativeVsSolo ??= {})[`F${p}`] = compareSets(cum, solo);
    }
    const cumRows = rows(`${work}-cumulative-L2`);
    if (cumRows)
      w.carryOver = carryOverStability(
        cumRows.map((r) => ({ label: r.label, rows: r.rows })),
      );
  }
  // 作品間の範囲（平均しない）。段ごと・列ごとに最小〜最大。
  const ranges = {};
  for (const level of MATRIX_LEVELS) {
    const perWork = Object.values(byWork)
      .map((w) => w.matrix[level])
      .filter(Boolean);
    if (perWork.length === 0) continue;
    ranges[level] = {};
    for (const column of Object.keys(perWork[0]))
      ranges[level][column] = rangeOf(perWork.map((row) => row[column]));
  }
  return { byWork, ranges };
}

// ---- 測定 B ------------------------------------------------------------------

const B_METRIC_COLUMNS = [
  "candidateCount",
  "slots",
  "judged",
  "droppedInWindow",
  "beyondWindow",
  "aliasButtons",
  "aliasMatchRoster",
  "aliasMismatchRoster",
  "aliasOnUnlisted",
  "aliasOnAmbiguousInSet",
  "aliasOnAmbiguousOutOfSet",
  "honorificCandidates",
  "honorificWithAlias",
  "cutRosterCandidates",
  "aliasOnCutRoster",
  "missedBindNullAlias",
  "missedBindBeyondWindow",
  "missedBindDropped",
  "typeChecked",
  "typeMismatch",
  "aliasOfUnknownId",
];

function sumMetrics(list) {
  const out = {};
  for (const column of B_METRIC_COLUMNS)
    out[column] = list.reduce((n, m) => n + (m?.[column] ?? 0), 0);
  return out;
}

/** B1：作品×段ごとに、3 回の最小〜最大・N・判定数・自己一致・失敗・token。 */
export function buildMeasureB1(results) {
  return results.map((r) => {
    const res = r.value?.result;
    const requests = res?.requests ?? [];
    const ok = requests.filter((q) => q.ok);
    const ranges = {};
    for (const column of B_METRIC_COLUMNS)
      ranges[column] = rangeOf(ok.map((q) => q.metrics?.[column]));
    return {
      work: r.work,
      level: r.level,
      status: r.status,
      roster: r.value?.roster ?? null,
      candidates: res?.candidates ?? null,
      requestCount: requests.length,
      successCount: res?.successCount ?? 0,
      failuresByKind: res?.failuresByKind ?? {},
      retried: requests.filter((q) => q.retried).length,
      undeterminable: res?.undeterminable ?? true,
      stopped: res?.stopped?.code ?? null,
      registeredSurfaces: res?.registeredSurfaces ?? null,
      selfAgreement: res?.selfAgreement ?? null,
      metricRanges: ranges,
      tokensIn: rangeOf(ok.map((q) => q.usage?.input_tokens)),
      tokensOut: rangeOf(ok.map((q) => q.usage?.output_tokens)),
    };
  });
}

/** B2（L2 だけ・1 回）：要求ごとの指標の合計と、決定・却下の内訳。 */
export function buildMeasureB2(results) {
  return results.map((r) => {
    const res = r.value?.result;
    const iterations = res?.iterations ?? [];
    return {
      work: r.work,
      level: r.level,
      status: r.status,
      initialCandidateCount: res?.initialCandidateCount ?? null,
      plannedIterations: res?.plannedIterations ?? null,
      iterationCount: iterations.length,
      failedIterations: iterations.filter((i) => !i.ok).length,
      decisionCounts: res?.decisionCounts ?? null,
      dismissReasons: res?.dismissReasons ?? null,
      stopped: res?.stopped?.code ?? null,
      noProgress: res?.noProgress ?? null,
      applyMissing: res?.applyMissing ?? null,
      undeterminable: res?.undeterminable ?? true,
      registeredSurfaces: res?.registeredSurfaces ?? null,
      finalVisibleCount: res?.finalVisibleCount ?? null,
      metricTotals: sumMetrics(
        iterations.filter((i) => i.ok).map((i) => i.metrics),
      ),
    };
  });
}

// ---- ★ の対応表（§7.3）-----------------------------------------------------------

/**
 * どの値でも、どの選択肢を支持するかは決めない（decided は常に false）。材料は件数だけ、言えないことは
 * コードで持つ（本文は renderRecordsMarkdown の表の注に出す）。
 * ambiguousSurfaceCounts：作品ごとの、名簿の「場面で指す人が変わる表記」の数（名簿から数えた件数）。
 */
export function buildStarMapping({ measureA, ambiguousSurfaceCounts = null }) {
  const perWork = {};
  for (const [work, w] of Object.entries(measureA.byWork)) {
    const l2 = w.matrix.L2 ?? null;
    perWork[work] = {
      star4: l2
        ? {
            unresolvedCandidateIn: l2.unresolvedCandidateIn,
            leftover: l2.leftoverCreateNew + l2.leftoverUnresolvedOut,
            collision:
              l2.collisionAmbiguousRows + l2.collisionNameOverAliasRows,
            partialAnyWrong: l2.partialAnyWrong,
          }
        : null,
      star5: l2
        ? {
            sceneRangeRows: l2.sceneRangeRows,
            sceneRangeUnresolved: l2.sceneRangeUnresolved,
          }
        : null,
      star8: w.carryOver
        ? w.carryOver.perRun.map((p) => ({
            label: p.label,
            unreviewed: p.unreviewed,
            remainingInLatestSameSurface: p.remainingInLatestSameSurface,
          }))
        : null,
    };
  }
  const ambiguousTotal = ambiguousSurfaceCounts
    ? Object.values(ambiguousSurfaceCounts).reduce((n, v) => n + v, 0)
    : null;
  return {
    star4: {
      decided: false,
      materials: [
        "unresolvedCandidateIn",
        "leftover",
        "collision",
        "partialAnyWrong",
      ],
      cannotSay: [
        "rule-saves-nothing-within-one-run",
        "savings-appear-only-after-reextraction-or-scene-additions",
        "cannot-link-has-no-merge-proposal-target-today",
      ],
    },
    star5: {
      decided: false,
      materials: ["sceneRangeRows", "sceneRangeUnresolved"],
      ambiguousSurfaceTotal: ambiguousTotal,
      noMaterial:
        ambiguousTotal !== null && ambiguousTotal < AMBIGUOUS_MATERIAL_MINIMUM,
      cannotSay: [
        "surfaces-were-found-by-the-roster-author-not-the-human",
        "few-cannot-be-told-from-missed",
      ],
    },
    star8: {
      decided: false,
      materials: ["remainingInLatestSameSurface"],
      cannotSay: [
        "no-run-to-run-carry-over-in-product",
        "seed-stability-not-reauthoring-load",
      ],
    },
    star1_2_3_6_7: {
      decided: false,
      materials: [],
      cannotSay: ["policy-and-threat-model-questions"],
    },
    perWork,
  };
}

// ---- records -------------------------------------------------------------------

export function buildRecords({
  measureA,
  b1 = [],
  b2 = [],
  ambiguousSurfaceCounts = null,
}) {
  return {
    schemaVersion: RECORDS_SCHEMA,
    evidenceScope: EVIDENCE_SCOPE,
    declarations: [...DECLARATIONS],
    indicatorName: "match-with-roster",
    note: "measure-a-and-measure-b-are-separate-tables-and-are-never-combined-or-ranked",
    measureA: measureA ?? null,
    measureB: { b1: buildMeasureB1(b1), b2: buildMeasureB2(b2) },
    starMapping: measureA
      ? buildStarMapping({ measureA, ambiguousSurfaceCounts })
      : null,
  };
}

/** 欄の名前が credential を示すものと、文字列の欄（ASCII の識別子の形以外）を拒む。値は返さない。 */
export function findForbiddenKeys(value, trail = "$") {
  const found = [];
  if (Array.isArray(value))
    value.forEach((v, i) =>
      found.push(...findForbiddenKeys(v, `${trail}[${i}]`)),
    );
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) found.push(`${trail}.<forbidden-key>`);
      found.push(...findForbiddenKeys(item, `${trail}.${key}`));
    }
  return found;
}

export function assertRecordsClean(records, scenesTexts = []) {
  const forbidden = findForbiddenKeys(records);
  const unsafe = findUnsafeStrings(records);
  assert.equal(
    forbidden.length + unsafe.length,
    0,
    `[artifact] RECORDS_UNCLEAN forbiddenKeys=${forbidden.length} unsafeStrings=${unsafe.length}`,
  );
  if (scenesTexts.length > 0) assertOutputClean(records, scenesTexts);
}

// ---- 表（markdown。件数だけ）--------------------------------------------------------

function rangeText(range) {
  if (!range || range.n === 0) return "-";
  return range.min === range.max
    ? String(range.min)
    : `${range.min}–${range.max}`;
}

export function renderRecordsMarkdown(records) {
  const lines = [];
  lines.push(
    "# 同定の review の負荷：集計（件数のみ。名簿との一致であって品質の証拠ではない）",
    "",
  );
  lines.push(
    `- evidenceScope: ${records.evidenceScope}（${records.declarations.join("・")}）`,
  );
  lines.push("- 測定 A と B は別表。合算も優劣づけもしない。", "");
  if (records.measureA) {
    lines.push("## 測定 A（構造抽出。AI なし）", "");
    lines.push(
      "作品 × 段（F100）。提案の分類は件数。範囲は作品間の最小〜最大（平均しない）。",
      "",
    );
    lines.push(
      "| 作品 | 段 | 場面数 | 提案 | 名簿に無い | 結び付け確認 | 解決(候補内) | 解決(候補外) | 型を決める | 手で見る create | 一括承認 | 承認の下限 | 表記を残す下限 |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [work, w] of Object.entries(records.measureA.byWork))
      for (const level of MATRIX_LEVELS) {
        const r = w.matrix[level];
        if (!r) continue;
        lines.push(
          `| ${work} | ${level} | ${r.sceneCount} | ${r.proposals} | ${r.notInRoster} | ${r.bindCheck} | ${r.unresolvedCandidateIn} | ${r.unresolvedCandidateOut} | ${r.typeNeeded} | ${r.manualCreate} | ${r.bulk} | ${r.opsApprovalSurface} | ${r.opsKeepSurfaceSurface} |`,
        );
      }
    lines.push("", "作品間の範囲（段ごと）。", "");
    lines.push(
      "| 段 | 提案 | 結び付け確認 | 解決(候補内) | 解決(候補外) | 一括承認 | 承認の下限 |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const [level, r] of Object.entries(records.measureA.ranges))
      lines.push(
        `| ${level} | ${rangeText(r.proposals)} | ${rangeText(r.bindCheck)} | ${rangeText(r.unresolvedCandidateIn)} | ${rangeText(r.unresolvedCandidateOut)} | ${rangeText(r.bulk)} | ${rangeText(r.opsApprovalSurface)} |`,
      );
    lines.push("", "累積の列（L2・同じ workspace。場面数ごと）。", "");
    lines.push(
      "| 作品 | 段 | 場面数 | 提案 | 未 review | 最新に同じ表記で残る |",
    );
    lines.push("|---|---|---|---|---|---|");
    for (const [work, w] of Object.entries(records.measureA.byWork))
      w.cumulative.forEach((r, i) => {
        const p = w.carryOver?.perRun?.[i];
        lines.push(
          `| ${work} | ${r.label} | ${r.sceneCount} | ${r.proposals} | ${p?.unreviewed ?? "-"} | ${p?.remainingInLatestSameSurface ?? "-"} |`,
        );
      });
    lines.push("");
  }
  lines.push("## 測定 B（候補画面。AI 判定）", "");
  lines.push(
    "作品 × 段。3 回の最小〜最大。N は段ごとに候補の集合が違うので、段をまたいで比べない。敬称の形（別名に入れない）は別枠で、名簿どおり・結び残しに含めない。",
    "",
  );
  lines.push(
    "| 作品 | 段 | N | 成功/要求 | 別名ボタン | 名簿どおり | 名簿と違う | 結び残し(null) | 結び残し(窓の外) | 結び残し(窓内で判定なし) | 敬称の形(別枠) | 自己一致 | 判断不能 |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of records.measureB.b1) {
    const m = r.metricRanges;
    lines.push(
      `| ${r.work} | ${r.level} | ${r.candidates?.visibleCount ?? "-"} | ${r.successCount}/${r.requestCount} | ${rangeText(m.aliasButtons)} | ${rangeText(m.aliasMatchRoster)} | ${rangeText(m.aliasMismatchRoster)} | ${rangeText(m.missedBindNullAlias)} | ${rangeText(m.missedBindBeyondWindow)} | ${rangeText(m.missedBindDropped)} | ${rangeText(m.honorificCandidates)} | ${r.selfAgreement ? `${r.selfAgreement.aliasAgree}/${r.selfAgreement.keysCompared}` : "-"} | ${r.undeterminable ? "はい" : "いいえ"} |`,
    );
  }
  lines.push("", "B2（L2・模擬作者）。", "");
  lines.push(
    "| 作品 | 初期 N | 要求/予定 | 別名 | 受理 | 却下 | 名簿どおりの別名 | 名簿と違う別名 | 反映できなかった決定 | 判断不能 |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of records.measureB.b2)
    lines.push(
      `| ${r.work} | ${r.initialCandidateCount ?? "-"} | ${r.iterationCount}/${r.plannedIterations ?? "-"} | ${r.decisionCounts?.alias ?? "-"} | ${r.decisionCounts?.accept ?? "-"} | ${r.decisionCounts?.dismiss ?? "-"} | ${r.metricTotals.aliasMatchRoster} | ${r.metricTotals.aliasMismatchRoster} | ${r.applyMissing ?? "-"} | ${r.undeterminable ? "はい" : "いいえ"} |`,
    );
  if (records.starMapping) {
    lines.push(
      "",
      "## ★ との対応（どの値でも、どの選択肢を支持するかは決めない）",
      "",
    );
    lines.push("| ★ | 決まるか | 材料 | 言えないこと（コード） |");
    lines.push("|---|---|---|---|");
    for (const key of ["star4", "star5", "star8", "star1_2_3_6_7"]) {
      const s = records.starMapping[key];
      lines.push(
        `| ${key} | いいえ（参考値） | ${s.materials.join(", ") || "-"} | ${s.cannotSay.join(", ")} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---- 入力の読み取り（repo 外の出力 dir）-----------------------------------------------

function readJsonDir(dir, suffixExclude = /\.(rows|rejected|failed)\.json$/u) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !suffixExclude.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")));
}

export function loadInputs(root) {
  const aDir = path.join(root, "measure-a");
  const cells = readJsonDir(aDir)
    .filter((c) => c.status === "ok")
    .map((c) => ({ ...c, work: c.observed?.work ?? c.work }));
  const rowsByCell = {};
  for (const cell of cells) {
    const file = path.join(aDir, `${cell.cell}.rows.json`);
    if (existsSync(file))
      rowsByCell[cell.cell] = JSON.parse(readFileSync(file, "utf8"));
  }
  return {
    cells,
    rowsByCell,
    b1: readJsonDir(path.join(root, "measure-b-b1")),
    b2: readJsonDir(path.join(root, "measure-b-b2")),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = { output: DEFAULT_OUTPUT, out: "" };
  for (let i = 0; i < args.length; i += 2)
    options[args[i].slice(2)] = args[i + 1];
  const root = path.resolve(options.output);
  const outDir = options.out || path.join(root, "records");
  const inputs = loadInputs(root);
  const measureA =
    inputs.cells.length > 0
      ? buildMeasureA({ cells: inputs.cells, rowsByCell: inputs.rowsByCell })
      : null;
  const records = buildRecords({ measureA, b1: inputs.b1, b2: inputs.b2 });
  assertRecordsClean(records);
  writeJson0600(path.join(outDir, "identity-load-records.json"), records);
  writeText0600(
    path.join(outDir, "identity-load-records.md"),
    renderRecordsMarkdown(records),
  );
  console.log(
    JSON.stringify({
      status: "ok",
      cellsA: inputs.cells.length,
      b1: inputs.b1.length,
      b2: inputs.b2.length,
    }),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "aggregate-failed",
        ...safeErrorSummary(error),
      }),
    );
    process.exitCode = 1;
  }
}
