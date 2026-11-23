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
  REVIEWED_WORKS,
  WORKS,
} from "./lib.mjs";
import { B_METRIC_DEFINITION_VERSION } from "./measure-b-core.mjs";
import {
  METRIC_DEFINITION_VERSION,
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
/**
 * 名簿を AI が作り、作者が確認していない作品（§16。事前登録 DR-ILM-38 (vi)）。この作品の値には印を付け、合計は
 * 「全作品」と「この作品を除く」の両方を出す。§8 の 1（作者の確認が未了の作品は判断不能）の判定は変えない。
 */
export const UNCONFIRMED_ROSTER_WORKS = Object.freeze(
  Object.keys(WORKS).filter((work) => !REVIEWED_WORKS.includes(work)),
);
export const UNCONFIRMED_ROSTER_MARK = "roster-ai-made-author-unconfirmed";

/**
 * DR-ILM-38 の「各列の読みの文」（測る前に固定。markdown の先頭に出す。records には入れない：records は ASCII の語だけ）。
 * key は列の名前。言えること・言えないことは DR-ILM-38 の文をそのまま短くしたもの。
 */
export const IDENTITY_COLUMN_READINGS = Object.freeze([
  {
    column: "Ur-all",
    canSay: "作者が結び先を決める手間の大きさ",
    cannotSay: "規則で減らせる量（新しい項目になるものも含む）",
  },
  {
    column: "Ur-rosterTarget",
    canSay: "名簿に正解の結び先があるのに未解決の提案の数",
    cannotSay:
      "実際に規則が効く数（名簿は AI が作り、作者の確認は一部の行だけ）",
  },
  {
    column: "S5-roster",
    canSay: "名簿を作った AI が、場面で指す人が変わる表記として見つけた数",
    cannotSay:
      "作品の実態の数（見つけ方に依存し、少なくても「見つけていない」のか「少ない」のか区別できない）",
  },
  {
    column: "S5_seen",
    canSay: "そのうち今の抽出が提案に出した数（review に実際に現れる数）",
    cannotSay:
      "抽出が拾わない分（seed にならない表記は数えられない。内訳で別に見る）",
  },
  {
    column: "S5 の内訳",
    canSay: "「抽出が拾わない」のか「提案に出る」のか",
    cannotSay: "拾わない理由",
  },
]);
/** m-ja-2 の印の文（markdown 用）。 */
export const UNCONFIRMED_ROSTER_TEXT = "名簿は AI が作り、作者が確認していない";

/** 指標の定義の版の欄が無い records（旧）。新しい版と混ぜて集計しない。 */
export const LEGACY_METRIC_DEFINITION = "legacy";

/** run の指標の定義の版。欄が無ければ旧（"legacy"）。 */
export function metricDefinitionOf(run) {
  return run?.metrics?.definitionVersion ?? LEGACY_METRIC_DEFINITION;
}

function assertSingleVersion(versions, measure, current) {
  if (versions.size > 1)
    throw new Error(
      `[precheck] METRIC_DEFINITION_VERSIONS_MIXED versions=${[...versions].sort().join(",")} current=${current} measure=${measure}`,
    );
  return [...versions][0] ?? null;
}

/**
 * 集計に入る全 run の定義の版を 1 つに定める。版が混ざったら止める（旧 records を新しい版と混ぜて
 * 比べない。数字の意味が違う：bindCheck・wrongTargetInBulk・保存済みの未 review の前の回の定義）。
 * run が無ければ null。
 */
export function assertSingleMetricDefinition(cells) {
  const versions = new Set();
  for (const cell of cells)
    for (const run of cell.runs ?? []) versions.add(metricDefinitionOf(run));
  return assertSingleVersion(versions, "A", METRIC_DEFINITION_VERSION);
}

/**
 * 測定 B の定義の版（cell の結果の metricDefinitionVersion。欄が無ければ "legacy"）。B1・B2 を合わせて 1 つに定め、
 * 混ざったら止める（aliasButtons・別名の数え方が版で違う）。測定 A の版とは別に数える。
 */
export function assertSingleBMetricDefinition(results) {
  const versions = new Set(
    results.map((r) => r.metricDefinitionVersion ?? LEGACY_METRIC_DEFINITION),
  );
  return assertSingleVersion(versions, "B", B_METRIC_DEFINITION_VERSION);
}

// ---- 測定 A ------------------------------------------------------------------

/**
 * 保存済みの未 review の提案の件数（run.storedUnreviewed）の状態：measured／persist-skipped／
 * persist-failed／read-failed／absent（欄の無い過去の records）。measured 以外は 0 件ではなく「未計測」。
 */
export function storedUnreviewedState(run) {
  const stored = run?.storedUnreviewed;
  return stored?.status === "measured"
    ? "measured"
    : (stored?.reason ?? "absent");
}

/**
 * 保存済みの未 review の提案の件数を、表の列（件数だけ。数値か null）に平らにする。
 * 未計測（保存しない段・保存の失敗・読みの失敗）と欄の無い過去の records は null（0 とは別。理由は
 * storedUnreviewedState が持つ）。storedProjectionMismatch は同じ段の projection の件数と食い違えば 1。
 */
export function flattenStoredUnreviewed(stored) {
  if (stored?.status !== "measured")
    return {
      storedUnreviewedTotal: null,
      storedUnreviewedCurrentRun: null,
      storedUnreviewedPriorRuns: null,
      storedUnreviewedPriorRunsEntity: null,
      storedUnreviewedPriorRunsRelation: null,
      storedUnreviewedPriorRunsBaseDetail: null,
      storedUnreviewedPriorRunsPhase: null,
      storedUnreviewedNotAdoptedRuns: null,
      storedUnreviewedVisibleToAuthor: null,
      storedUnreviewedNotVisibleToAuthor: null,
      storedFailedStageRuns: null,
      storedUntrackedRuns: null,
      storedFolderUnknownRuns: null,
      storedListTruncated: null,
      storedProjectionMismatch: null,
    };
  const prior = stored.unreviewed.priorRunsByKind;
  const check = stored.projectionCheck;
  return {
    storedUnreviewedTotal: stored.unreviewed.total,
    storedUnreviewedCurrentRun: stored.unreviewed.currentRun,
    storedUnreviewedPriorRuns: stored.unreviewed.priorRuns,
    storedUnreviewedPriorRunsEntity: prior["codex.entity.bind"] ?? 0,
    storedUnreviewedPriorRunsRelation: prior["codex.relation.create"] ?? 0,
    storedUnreviewedPriorRunsBaseDetail: prior["codex.detail.base.set"] ?? 0,
    storedUnreviewedPriorRunsPhase: prior["codex.phase.bind"] ?? 0,
    // 採用しなかった run（失敗した段の run・道具が控えていない run）の分。前の回に数えない。欄の無い過去の records は null。
    storedUnreviewedNotAdoptedRuns: stored.unreviewed.notAdoptedRuns ?? null,
    // 製品の restore が作者に出す run の分と、それ以外（合計は storedUnreviewedTotal）。
    storedUnreviewedVisibleToAuthor: stored.unreviewed.visibleToAuthor ?? null,
    storedUnreviewedNotVisibleToAuthor:
      stored.unreviewed.notVisibleToAuthor ?? null,
    storedFailedStageRuns: stored.failedStageRunCount ?? null,
    storedUntrackedRuns: stored.untrackedRunCount ?? null,
    // folder の識別子が読めなかった run（0 のはず）。製品の restore は folder 不明の run をどの folder にも当てるが、
    // 写し（planProductVisibleRuns）は独立の folder として数えるので、あれば作者に見える分が製品とずれる（多く出る側）。
    storedFolderUnknownRuns: stored.folderUnknownRunCount ?? null,
    // 製品の列挙が上限（100）に達した（件数が過少の可能性）。1 ＝ 達した。
    storedListTruncated:
      stored.listTruncated === undefined ? null : stored.listTruncated ? 1 : 0,
    storedProjectionMismatch: check?.compared ? (check.ok ? 0 : 1) : null,
  };
}

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
    // 関係の呼び名の分類を持たない旧 records は 0 でなく null（0 件だったのではなく、分けて数えていない）。
    relational: c.relational ?? null,
    relationalUnresolved: m.relational
      ? (m.relational.byBinding?.unresolved ?? 0)
      : null,
    relationalBindExisting: m.relational
      ? (m.relational.byBinding?.["bind-existing"] ?? 0)
      : null,
    relationalCreateNew: m.relational
      ? (m.relational.byBinding?.["create-new"] ?? 0)
      : null,
    // 関係の呼び名の unresolved のうち部分一致の候補があるもの（作者に unresolved の提案として出る。操作の下限には入れない。a-defs/3 から）。
    relationalUnresolvedPartial:
      m.relational?.unresolvedWithPartialCandidate ?? null,
    bindCheck: c.bindCheck,
    unresolvedCandidateIn: c.unresolvedCandidateIn,
    unresolvedCandidateOut: c.unresolvedCandidateOut,
    typeNeeded: c.typeNeeded,
    bulk: c.bulk,
    // 一括承認の結び付けを別分類にする前の旧 records（版なし）は、bulkBind・bulkTotal を 0／bulk の値にせず null にする
    // （bind-existing の一括の分は bindCheck に入っていて、分けて数えていない）。
    bulkBind: c.bulkBind ?? null,
    bulkTotal: m.bulkApprovable?.bulkTotal ?? null,
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
    // 旧 records（版なし）は一括の結び先違いを数えていない。0 でなく null。
    wrongTargetInBulk: m.mismatch.wrongTargetInBulk ?? null,
    // wrongTargetInBulk の内訳（版 a-defs/2 から。旧 records は null）。
    wrongTargetInBulkEntity: m.mismatch.wrongTargetInBulkEntity ?? null,
    bulkBindOnAmbiguous: m.mismatch.bulkBindOnAmbiguous ?? null,
    bulkBindOnAmbiguousOutOfSet: m.mismatch.bulkBindOnAmbiguousOutOfSet ?? null,
    // 一括 1 回で誤った Entry ができる件数（版 a-defs/3 から。旧 records は null）：名簿の外・結び先が 1 つに定まらない表記・
    // 既知の実体への一括の create-new の合計と内訳。操作の下限（bulkTotal）には名簿の外の行を含めないため、この列で表に出す。
    bulkCreateWrongEntry: m.mismatch.bulkCreateWrongEntry?.total ?? null,
    bulkCreateOutsideRoster:
      m.mismatch.bulkCreateWrongEntry?.outsideRoster ?? null,
    bulkCreateNotInRoster: m.mismatch.bulkCreateWrongEntry?.notInRoster ?? null,
    bulkCreateRelational: m.mismatch.bulkCreateWrongEntry?.relational ?? null,
    bulkCreateAmbiguous: m.mismatch.bulkCreateWrongEntry?.ambiguous ?? null,
    bulkCreateKnownEntity: m.mismatch.bulkCreateWrongEntry?.knownEntity ?? null,
    // DR-ILM-38 の列（版 a-defs/4 から。旧 records は null）。件数だけ。Ur：bindingKind が unresolved の提案（全体／名簿に
    // 結び先がある分）。S5：名簿の場面で指す人が変わる表記（重複を除く）／そのうち提案に出たもの／内訳（seed に出ない・seed に
    // 出るが提案に出ない・提案に出る。候補画面の候補に出る数と、seed にも候補にもならない数は別に。未計測は null）。
    urAll: m.identityColumns?.ur?.all ?? null,
    urRosterTarget: m.identityColumns?.ur?.rosterTarget ?? null,
    s5Roster: m.identityColumns?.s5?.roster ?? null,
    s5Seen: m.identityColumns?.s5?.seen ?? null,
    s5NotSeed: m.identityColumns?.s5?.breakdown?.notSeed ?? null,
    s5SeedNotProposed:
      m.identityColumns?.s5?.breakdown?.seedNotProposed ?? null,
    s5Proposed: m.identityColumns?.s5?.breakdown?.proposed ?? null,
    s5InCandidate:
      m.identityColumns?.s5?.breakdown?.candidate?.inCandidate ?? null,
    s5NotSeedInCandidate:
      m.identityColumns?.s5?.breakdown?.candidate?.notSeedInCandidate ?? null,
    s5NeitherSeedNorCandidate:
      m.identityColumns?.s5?.breakdown?.candidate?.neitherSeedNorCandidate ??
      null,
    // 製品が planner の前段で seed を落とした件数（呼び名・候補画面で却下済みの表記）。件数だけ。
    seedDroppedRelational: m.seedDrops?.relationalTerms ?? null,
    seedDroppedFoldedDismissed: m.seedDrops?.foldedDismissed ?? null,
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
    ...flattenStoredUnreviewed(run.storedUnreviewed),
    completed: run.completed ? 1 : 0,
  };
}

export function rangeOf(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return { n: 0, min: null, max: null };
  return { n: nums.length, min: Math.min(...nums), max: Math.max(...nums) };
}

const MATRIX_LEVELS = ["empty", "L0", "L1", "L2", "L3", "L2-1char"];

// ---- DR-ILM-38 の列（名簿の水準 L0〜L3 の matrix cell・F100 ごと。作品間の合計）------------------------------

/** 水準 L0〜L3（L2・F100 に絞らない）。 */
export const IDENTITY_LEVELS = Object.freeze(["L0", "L1", "L2", "L3"]);
/** 水準ごとに値が変わる列（S5-roster は名簿から数えるので水準に依らず、別に持つ）。 */
export const IDENTITY_LEVEL_COLUMNS = Object.freeze([
  "urAll",
  "urRosterTarget",
  "s5Seen",
  "s5NotSeed",
  "s5SeedNotProposed",
  "s5Proposed",
  "s5InCandidate",
  "s5NotSeedInCandidate",
  "s5NeitherSeedNorCandidate",
]);

/** 合計：全ての作品が数値のときだけ足す。1 作品でも欠け・未計測（null）なら、合計と名乗らず null。 */
function totalOf(works, pick) {
  const values = works.map(pick);
  return values.every((v) => Number.isFinite(v))
    ? values.reduce((n, v) => n + v, 0)
    : null;
}

/**
 * DR-ILM-38：Ur・S5 の列を水準ごと・作品ごとに並べ、4 作品の合計と、名簿が未確認の作品（m-ja-2）を除く 3 作品の合計の
 * 両方を出す。期待する作品は WORKS（4 作品）と byWork の作品の和：その水準の cell が欠けた作品があれば、その合計は
 * 作品数を名乗らず null にして、欠けた作品を missingWorks に出す。§8 の 1 の判定には触れない（completed を並べるだけ）。
 */
export function buildIdentityColumns(byWork) {
  const expectedAll = [
    ...new Set([...Object.keys(WORKS), ...Object.keys(byWork)]),
  ];
  const expectedConfirmed = expectedAll.filter(
    (work) => !UNCONFIRMED_ROSTER_WORKS.includes(work),
  );
  const markOf = (work) =>
    UNCONFIRMED_ROSTER_WORKS.includes(work) ? UNCONFIRMED_ROSTER_MARK : null;
  // S5-roster：名簿から数えた値で、水準に依らない。同じ作品の cell で値が違えば止める。
  const s5PerWork = {};
  for (const [work, w] of Object.entries(byWork)) {
    const values = new Set(
      MATRIX_LEVELS.map((level) => w.matrix[level]?.s5Roster).filter((v) =>
        Number.isFinite(v),
      ),
    );
    if (values.size > 1)
      throw new Error(`[artifact] S5_ROSTER_VARIES_BY_LEVEL work=${work}`);
    s5PerWork[work] = values.size === 1 ? [...values][0] : null;
  }
  const missingOf = (works, pick) =>
    works.filter((work) => !Number.isFinite(pick(work)));
  const totals = (works, pickFor) => {
    const columns = {};
    for (const key of IDENTITY_LEVEL_COLUMNS)
      columns[key] = totalOf(works, (work) => pickFor(work, key));
    return {
      works: [...works],
      workCount: works.length,
      missingWorks: missingOf(works, (work) => pickFor(work, "urAll")),
      columns,
    };
  };
  const levels = {};
  for (const level of IDENTITY_LEVELS) {
    const cellOf = (work) => byWork[work]?.matrix?.[level] ?? null;
    const perWork = {};
    for (const [work] of Object.entries(byWork)) {
      const cell = cellOf(work);
      perWork[work] = {
        rosterMark: markOf(work),
        completed: cell?.completed ?? null,
        s5Roster: cell?.s5Roster ?? null,
        ...Object.fromEntries(
          IDENTITY_LEVEL_COLUMNS.map((key) => [key, cell?.[key] ?? null]),
        ),
      };
    }
    const pickFor = (work, key) => cellOf(work)?.[key];
    levels[level] = {
      perWork,
      totalAll: totals(expectedAll, pickFor),
      totalWithoutUnconfirmedRoster: totals(expectedConfirmed, pickFor),
    };
  }
  const s5Total = (works) => ({
    works: [...works],
    workCount: works.length,
    missingWorks: missingOf(works, (work) => s5PerWork[work]),
    value: totalOf(works, (work) => s5PerWork[work]),
  });
  return {
    unconfirmedRosterMark: UNCONFIRMED_ROSTER_MARK,
    unconfirmedRosterWorks: [...UNCONFIRMED_ROSTER_WORKS],
    levels,
    s5Roster: {
      perWork: s5PerWork,
      totalAll: s5Total(expectedAll),
      totalWithoutUnconfirmedRoster: s5Total(expectedConfirmed),
    },
  };
}

/**
 * cells：run-measure-a の採用済みの cell の JSON。rowsByCell：cell id → [{ label, rows }]。
 * 作品ごとの表（matrix・決定性・累積・単独）と、決定性・累積の一致の検査、作品間の範囲。
 */
export function buildMeasureA({ cells, rowsByCell }) {
  // 指標の定義の版が混ざった入力（旧 records と新しい records）は集計しない。
  const definitionVersion = assertSingleMetricDefinition(cells);
  const byWork = {};
  for (const cell of cells) {
    const w = (byWork[cell.work] ??= {
      matrix: {},
      cumulative: [],
      solo: [],
      determinism: null,
      checks: {},
      // 保存済みの未 review の件数の状態（段ごと）。measured 以外は件数が null（未計測）。
      storedStates: {},
    });
    const runs = cell.runs ?? [];
    for (const run of runs)
      w.storedStates[
        cell.kind === "cumulative" || cell.kind === "solo"
          ? `${cell.kind}-${run.label}`
          : (cell.level ?? "empty") +
            (cell.kind === "determinism" ? "-determinism" : "")
      ] = storedUnreviewedState(run);
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
  return {
    definitionVersion,
    byWork,
    ranges,
    identityColumns: buildIdentityColumns(byWork),
  };
}

// ---- 測定 B ------------------------------------------------------------------

const B_METRIC_COLUMNS = [
  "candidateCount",
  "slots",
  "judged",
  "droppedInWindow",
  "beyondWindow",
  "aliasButtons",
  "aliasProposed",
  "aliasButtonsSuppressedRelational",
  "aliasMatchRoster",
  "aliasMismatchRoster",
  "aliasOnUnlisted",
  "aliasOnAmbiguousInSet",
  "aliasOnAmbiguousOutOfSet",
  "honorificCandidates",
  "honorificWithAlias",
  "relationalCandidates",
  "relationalWithAlias",
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
  assertSingleBMetricDefinition(results);
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
  assertSingleBMetricDefinition(results);
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
      // DB に保存済みの未 review の提案の件数（保存つきの段だけ。未計測は件数 null と state で区別する）。
      star8Stored:
        w.cumulative.length > 0
          ? w.cumulative.map((r) => ({
              label: r.label,
              state: w.storedStates?.[`cumulative-${r.label}`] ?? "absent",
              total: r.storedUnreviewedTotal,
              currentRun: r.storedUnreviewedCurrentRun,
              priorRuns: r.storedUnreviewedPriorRuns,
              notAdoptedRuns: r.storedUnreviewedNotAdoptedRuns,
              visibleToAuthor: r.storedUnreviewedVisibleToAuthor,
              notVisibleToAuthor: r.storedUnreviewedNotVisibleToAuthor,
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
      materials: ["remainingInLatestSameSurface", "storedUnreviewedPriorRuns"],
      cannotSay: [
        "no-run-to-run-carry-over-in-product",
        "seed-stability-not-reauthoring-load",
        "stored-count-is-unmeasured-without-persist",
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
    metricDefinitionVersion: measureA?.definitionVersion ?? null,
    measureA: measureA ?? null,
    // B1 と B2 を合わせても版は 1 つ（混ざったら止める）。測定 A の版とは別。
    measureB: {
      definitionVersion: assertSingleBMetricDefinition([...b1, ...b2]),
      b1: buildMeasureB1(b1),
      b2: buildMeasureB2(b2),
    },
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

/** 保存済みの未 review の件数の表示。未計測（null）は 0 と区別して「未計測」と書く。 */
function storedText(value) {
  return value === null || value === undefined ? "未計測" : String(value);
}

/**
 * 保存済みの未 review の読みの注記（件数と語だけ）。打ち切り・件数の不一致・採用しなかった run・未計測の理由。
 * state：storedUnreviewedState の語（measured 以外は 0 件でなく未計測）。
 */
export function storedNotes(r, state) {
  const notes = [];
  if (state === "absent") notes.push("欄なし");
  else if (state !== undefined && state !== "measured")
    notes.push(`未計測(${state})`);
  if (r.storedListTruncated === 1)
    notes.push("列挙が上限に達した(過少の可能性)");
  if (r.storedProjectionMismatch === 1)
    notes.push("保存と projection の件数が不一致");
  if ((r.storedFailedStageRuns ?? 0) > 0)
    notes.push(`失敗した段の run ${r.storedFailedStageRuns}`);
  if ((r.storedUntrackedRuns ?? 0) > 0)
    notes.push(`控えに無い run ${r.storedUntrackedRuns}`);
  if ((r.storedFolderUnknownRuns ?? 0) > 0)
    notes.push(
      `folder 不明の run ${r.storedFolderUnknownRuns}(製品はどの folder にも当てるが、写しは独立の folder として数える。作者に見える分が製品とずれる)`,
    );
  return notes.length > 0 ? notes.join("・") : "-";
}

function rangeText(range) {
  if (!range || range.n === 0) return "-";
  return range.min === range.max
    ? String(range.min)
    : `${range.min}–${range.max}`;
}

const dash = (value) =>
  value === null || value === undefined ? "-" : String(value);

/** DR-ILM-38 の列（読みの文を先頭に、水準ごとの表）。件数と定数の文だけ。null は「-」（0 と区別する）。 */
export function renderIdentityColumns(columns) {
  const lines = [];
  lines.push(
    "## Ur・S5 の列の読み（DR-ILM-38。測る前に固定。件数を並べるだけで、作る／作らない／保留の結論は出さない）",
    "",
    "| 列 | 言えること | 言えないこと |",
    "|---|---|---|",
  );
  for (const r of IDENTITY_COLUMN_READINGS)
    lines.push(`| ${r.column} | ${r.canSay} | ${r.cannotSay} |`);
  lines.push(
    "",
    `- 合計は「全作品」と「名簿が未確認の作品（${columns.unconfirmedRosterWorks.join("・")}）を除く」の両方を並べる。${columns.unconfirmedRosterWorks.join("・")} には「${UNCONFIRMED_ROSTER_TEXT}」の印を付ける。§8 の 1（作者の確認が未了の作品は判断不能）の判定は変えない。`,
    "- 全作品の合計は、その水準の cell が全作品に揃っているときだけ出す（欠けた作品があれば「-」と書き、欠けた作品を添える）。",
    "- S5-roster は名簿から数えるので水準に依らない（作品ごと。同じ表記が複数の実体に載っていれば 1 件）。",
    "- S5 の内訳の「候補画面の候補に出る」は、inventory の既定の閾値の候補（作品単位）で、水準に依らない。登録済みの Entry や却下で絞った後の、その水準の候補画面とは一致しない。候補が未計測の作品があれば、候補の合計は「-」。",
    "",
  );
  for (const [level, l] of Object.entries(columns.levels)) {
    lines.push(`### 名簿の水準 ${level}（F100）`, "");
    lines.push(
      "| 作品 | 名簿の印 | 完了 | Ur-all | Ur-rosterTarget | S5-roster | S5_seen | seed に出ない | seed に出るが提案に出ない | 提案に出る | 候補画面の候補に出る | うち seed にならない | seed にも候補にもならない |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const [work, r] of Object.entries(l.perWork))
      lines.push(
        `| ${work} | ${r.rosterMark ? UNCONFIRMED_ROSTER_TEXT : "-"} | ${dash(r.completed)} | ${dash(r.urAll)} | ${dash(r.urRosterTarget)} | ${dash(r.s5Roster)} | ${dash(r.s5Seen)} | ${dash(r.s5NotSeed)} | ${dash(r.s5SeedNotProposed)} | ${dash(r.s5Proposed)} | ${dash(r.s5InCandidate)} | ${dash(r.s5NotSeedInCandidate)} | ${dash(r.s5NeitherSeedNorCandidate)} |`,
      );
    for (const [label, key, s5Key] of [
      ["合計（全作品）", "totalAll", "totalAll"],
      [
        `合計（${columns.unconfirmedRosterWorks.join("・")} を除く）`,
        "totalWithoutUnconfirmedRoster",
        "totalWithoutUnconfirmedRoster",
      ],
    ]) {
      const t = l[key];
      const c = t.columns;
      const note =
        t.missingWorks.length > 0
          ? `（欠け: ${t.missingWorks.join("・")}）`
          : "";
      lines.push(
        `| ${label}（${t.workCount} 作品）${note} | - | - | ${dash(c.urAll)} | ${dash(c.urRosterTarget)} | ${dash(columns.s5Roster[s5Key].value)} | ${dash(c.s5Seen)} | ${dash(c.s5NotSeed)} | ${dash(c.s5SeedNotProposed)} | ${dash(c.s5Proposed)} | ${dash(c.s5InCandidate)} | ${dash(c.s5NotSeedInCandidate)} | ${dash(c.s5NeitherSeedNorCandidate)} |`,
      );
    }
    lines.push("");
  }
  return lines;
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
  lines.push("- 測定 A と B は別表。合算も優劣づけもしない。");
  lines.push(
    `- 指標の定義の版: 測定 A ${records.measureA?.definitionVersion ?? "-"}／測定 B ${records.measureB?.definitionVersion ?? "-"}（${LEGACY_METRIC_DEFINITION} は版の欄が無い旧 records。A・B それぞれ、版が混ざった入力は集計しない）`,
  );
  lines.push("");
  if (records.measureA?.identityColumns)
    lines.push(...renderIdentityColumns(records.measureA.identityColumns));
  if (records.measureA) {
    lines.push("## 測定 A（構造抽出。AI なし）", "");
    lines.push(
      "作品 × 段（F100）。提案の分類は件数。範囲は作品間の最小〜最大（平均しない）。",
      "",
    );
    lines.push(
      "| 作品 | 段 | 場面数 | 提案 | 名簿に無い | 関係の呼び名 | 関係の呼び名の unresolved(部分一致の候補あり。下限に入れない) | 結び付け確認（1 件ずつ） | 解決(候補内) | 解決(候補外) | 型を決める | 手で見る create | 一括承認(create) | 一括承認(結び付け) | 承認の下限 | 表記を残す下限 | seed を落とした数(呼び名/却下) | 一括の結び先違いの危険(結び先が定まらない表記への一括 含む) | 一括 1 回で誤った Entry ができる件数(うち名簿の外・結び先が定まらない表記) | 保存済みの未 review | うち作者に見える run | 読みの注記 |",
    );
    lines.push(
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const [work, w] of Object.entries(records.measureA.byWork))
      for (const level of MATRIX_LEVELS) {
        const r = w.matrix[level];
        if (!r) continue;
        lines.push(
          `| ${work} | ${level} | ${r.sceneCount} | ${r.proposals} | ${r.notInRoster} | ${r.relational ?? "-"} | ${r.relationalUnresolved ?? "-"}(${r.relationalUnresolvedPartial ?? "-"}) | ${r.bindCheck} | ${r.unresolvedCandidateIn} | ${r.unresolvedCandidateOut} | ${r.typeNeeded} | ${r.manualCreate} | ${r.bulk} | ${r.bulkBind ?? "-"} | ${r.opsApprovalSurface} | ${r.opsKeepSurfaceSurface} | ${r.seedDroppedRelational ?? "-"}/${r.seedDroppedFoldedDismissed ?? "-"} | ${r.wrongTargetInBulk ?? "-"}(${r.bulkBindOnAmbiguous ?? "-"}) | ${r.bulkCreateWrongEntry ?? "-"}(${r.bulkCreateOutsideRoster ?? "-"}) | ${storedText(r.storedUnreviewedTotal)} | ${storedText(r.storedUnreviewedVisibleToAuthor)} | ${storedNotes(r, w.storedStates?.[level])} |`,
        );
      }
    lines.push("", "作品間の範囲（段ごと）。", "");
    lines.push(
      "| 段 | 提案 | 結び付け確認（1 件ずつ） | 解決(候補内) | 解決(候補外) | 一括承認(create+結び付け) | 承認の下限 | 一括 1 回で誤った Entry ができる件数 |",
    );
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const [level, r] of Object.entries(records.measureA.ranges))
      lines.push(
        `| ${level} | ${rangeText(r.proposals)} | ${rangeText(r.bindCheck)} | ${rangeText(r.unresolvedCandidateIn)} | ${rangeText(r.unresolvedCandidateOut)} | ${rangeText(r.bulkTotal)} | ${rangeText(r.opsApprovalSurface)} | ${rangeText(r.bulkCreateWrongEntry)} |`,
      );
    lines.push("", "累積の列（L2・同じ workspace。場面数ごと）。", "");
    lines.push(
      "| 作品 | 段 | 場面数 | 提案 | 未 review | 最新に同じ表記で残る | 保存済みの未 review（全体） | うち前の回の run | うち採用しなかった run | うち作者に見える run | うち作者に見えない | 読みの注記 |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [work, w] of Object.entries(records.measureA.byWork))
      w.cumulative.forEach((r, i) => {
        const p = w.carryOver?.perRun?.[i];
        lines.push(
          `| ${work} | ${r.label} | ${r.sceneCount} | ${r.proposals} | ${p?.unreviewed ?? "-"} | ${p?.remainingInLatestSameSurface ?? "-"} | ${storedText(r.storedUnreviewedTotal)} | ${storedText(r.storedUnreviewedPriorRuns)} | ${storedText(r.storedUnreviewedNotAdoptedRuns)} | ${storedText(r.storedUnreviewedVisibleToAuthor)} | ${storedText(r.storedUnreviewedNotVisibleToAuthor)} | ${storedNotes(r, w.storedStates?.[`cumulative-${r.label}`])} |`,
        );
      });
    lines.push("");
  }
  lines.push("## 測定 B（候補画面。AI 判定）", "");
  lines.push(
    "作品 × 段。3 回の最小〜最大。N は段ごとに候補の集合が違うので、段をまたいで比べない。敬称の形（別名に入れない）と関係の呼び名（登録しない別の種類）は別枠で、名簿どおり・結び残しに含めない。",
    "",
  );
  lines.push(
    "| 作品 | 段 | N | 成功/要求 | 別名ボタン | 名簿どおり | 名簿と違う | 結び残し(null) | 結び残し(窓の外) | 結び残し(窓内で判定なし) | 敬称の形(別枠) | 関係の呼び名(別枠) | 自己一致 | 判断不能 |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of records.measureB.b1) {
    const m = r.metricRanges;
    lines.push(
      `| ${r.work} | ${r.level} | ${r.candidates?.visibleCount ?? "-"} | ${r.successCount}/${r.requestCount} | ${rangeText(m.aliasButtons)} | ${rangeText(m.aliasMatchRoster)} | ${rangeText(m.aliasMismatchRoster)} | ${rangeText(m.missedBindNullAlias)} | ${rangeText(m.missedBindBeyondWindow)} | ${rangeText(m.missedBindDropped)} | ${rangeText(m.honorificCandidates)} | ${rangeText(m.relationalCandidates)} | ${r.selfAgreement ? `${r.selfAgreement.aliasAgree}/${r.selfAgreement.keysCompared}` : "-"} | ${r.undeterminable ? "はい" : "いいえ"} |`,
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
