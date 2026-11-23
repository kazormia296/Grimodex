// 測定 B（候補画面の AI 判定）の中身（事前登録 §6・§9）。純粋な制御と指標。
// 候補の本文・表記は page の中に持ち、ここへは hash・件数・場面 index だけが来る。
// api（page に束縛した薄い層。試験では fake）：
//   prepare({rescan}) / estimate() / gate() / judge() / apply(decisions) /
//   usageRowCount() / usageRowsSince(n) / sleep(ms)
// 乾いた実行（dryMeasure）は api.judge を呼ばない。送信する経路は sendOne だけで、
// run-measure-b.mjs が明示の許可（--confirm-send）を確かめたうえでだけ呼ぶ。
import { RETRYABLE_FAILURE_KINDS } from "./lib.mjs";
import {
  BudgetStop,
  estimateInputTokens,
  estimateOutputTokens,
  planCost,
} from "./ledger.mjs";
import { codexTypeOf, lookupRoster } from "./measure-a-metrics.mjs";

/** candidateJudgment.ts の MAX_CANDIDATES／MAX_ENTRIES（page 側の写しと同じ値。突き合わせは assertEstimateMatches）。 */
export const MAX_CANDIDATES = 50;
export const MAX_ENTRIES = 200;
export const CODEX_JUDGMENT = "codex_judgment";
export const REPEATS_B1 = 3;
/**
 * 測定 B の指標の定義の版。cell の結果（run-measure-b）に載せ、aggregate は版が混ざった入力を止める
 * （旧 records は版なし＝"legacy"）。測定 A の版（measure-a-metrics.mjs の METRIC_DEFINITION_VERSION）とは別に数える
 * （A と B は別の表で、合算も比較もしない）。定義を変えたら上げる。
 *   "legacy"   版の欄が無い records（aliasButtons に関係の呼び名への別名ボタンを含み、B2 の模擬作者は呼び名への別名決定を数える）。
 *   "b-defs/2" aliasButtons は製品の画面と同じく関係の呼び名を除き（除いた分は aliasButtonsSuppressedRelational）、
 *              AI が別名を勧めた数を aliasProposed に併記し、B2 の模擬作者は呼び名への別名決定を「反映できなかった」に数える。
 */
export const B_METRIC_DEFINITION_VERSION = "b-defs/2";

// ---- 名簿の準備 -------------------------------------------------------------

/**
 * B 用の名簿：実体数が limit（Entry の窓＝先頭 200）を超えるなら、出場面数の少ない順に切って limit にする。
 * 出場面数は entity.sceneCount（あれば）、無ければ evidence の distinct な場面の数。切った数を返す。
 */
export function truncateRosterForB(roster, limit = MAX_ENTRIES) {
  const sceneCountOf = (entity) =>
    Number.isFinite(entity.sceneCount)
      ? entity.sceneCount
      : new Set((entity.evidence ?? []).map((ev) => ev.scene)).size;
  if (roster.entities.length <= limit)
    return {
      roster,
      cutEntities: [],
      cut: 0,
      entityCount: roster.entities.length,
    };
  const keep = new Set(
    [...roster.entities]
      .sort(
        (a, b) =>
          sceneCountOf(b) - sceneCountOf(a) ||
          String(a.id).localeCompare(String(b.id)),
      )
      .slice(0, limit)
      .map((entity) => entity.id),
  );
  return {
    roster: {
      ...roster,
      entities: roster.entities.filter((entity) => keep.has(entity.id)),
    },
    cutEntities: roster.entities.filter((entity) => !keep.has(entity.id)),
    cut: roster.entities.length - limit,
    entityCount: limit,
  };
}

// ---- 検査 -------------------------------------------------------------------

/** 要求の本文の写し（page 側の bEstimate）が、候補・Entry の窓と一致していること。 */
export function assertEstimateMatches(prepared, estimate) {
  const expectedSlots = Math.min(prepared.visibleCount, MAX_CANDIDATES);
  const expectedEntries = Math.min(prepared.entryCount, MAX_ENTRIES);
  if (estimate.judgedSlots !== expectedSlots)
    throw new Error(
      `[artifact] ESTIMATE_SLOTS_DIFFER judged=${estimate.judgedSlots} expected=${expectedSlots}`,
    );
  if (estimate.entrySlots !== expectedEntries)
    throw new Error(
      `[artifact] ESTIMATE_ENTRIES_DIFFER entries=${estimate.entrySlots} expected=${expectedEntries}`,
    );
}

/** 送信の前の状態（policy・license・言語）。空の Map を返す経路があるので、送る前に止める。 */
export function assertAiGate(gate) {
  if (gate.policyBlocked)
    throw new Error(
      "[precheck] AI_POLICY_OFF analysis policy blocks the judgment",
    );
  if (gate.licenseRestricted)
    throw new Error(
      "[precheck] LICENSE_RESTRICTED license restricts the judgment",
    );
  if (gate.language !== "ja")
    throw new Error(
      "[precheck] LANGUAGE_NOT_JA candidate judgment needs a ja project",
    );
}

/**
 * F2：送る前の guard（役割の上書き・名簿の hidden・宛先）。判定できないときは止める（fail-closed）。
 * page が返すのは真偽と件数だけ（原稿・表記・設定の値は返さない）。
 */
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * R4：役割の上書き（aiModel.role.*・aiModel.roleProviders）が空・既定で、製品が送信時に使う
 * resolveRoleSendOverride("codex_judgment") の 4 欄（model・provider・apiVariant・endpointId）が全部 null であること。
 * 返り値は records に残す形（件数と真偽だけ）。
 */
export function assertRoleOverridesDefault(result) {
  const ok =
    result !== null &&
    typeof result === "object" &&
    result.checked === true &&
    isCount(result.roleKeysChecked) &&
    result.roleKeysChecked >= 7 &&
    isCount(result.nonDefaultRoleKeys) &&
    typeof result.roleProvidersNonDefault === "boolean" &&
    typeof result.sendOverrideClear === "boolean";
  if (!ok)
    throw new Error(
      "[precheck] ROLE_OVERRIDE_UNDECIDABLE the role override check returned an unexpected shape",
    );
  if (
    result.nonDefaultRoleKeys !== 0 ||
    result.roleProvidersNonDefault ||
    !result.sendOverrideClear
  )
    throw new Error(
      `[precheck] ROLE_OVERRIDE_NOT_DEFAULT nonDefaultRoleKeys=${result.nonDefaultRoleKeys} roleProvidersNonDefault=${result.roleProvidersNonDefault ? 1 : 0} sendOverrideClear=${result.sendOverrideClear ? 1 : 0}`,
    );
  return {
    roleKeysChecked: result.roleKeysChecked,
    nonDefaultRoleKeys: 0,
    roleProvidersNonDefault: false,
    sendOverrideClear: true,
  };
}

/**
 * 名簿に hidden が 0 件であること。page は、送る Entry（project の全 Entry）を製品の hidden 判定
 * （listCodexIdsHiddenFromAi。DB に無い id・不明な mode も hidden に数える）に掛けた件数を返す。
 * 調べた数が Entry の数と違う、期待の数（登録した数）と違う、判定が返らない形なら止める。
 */
export function assertRosterNotHidden(
  result,
  { expectedEntryCount = null } = {},
) {
  const ok =
    result !== null &&
    typeof result === "object" &&
    result.checked === true &&
    isCount(result.entryCount) &&
    isCount(result.checkedCount) &&
    isCount(result.hiddenCount);
  if (!ok)
    throw new Error(
      "[precheck] ROSTER_HIDDEN_UNDECIDABLE the hidden check returned an unexpected shape",
    );
  if (result.checkedCount !== result.entryCount)
    throw new Error(
      `[precheck] ROSTER_HIDDEN_UNDECIDABLE checked=${result.checkedCount} entries=${result.entryCount}`,
    );
  if (expectedEntryCount !== null && result.entryCount !== expectedEntryCount)
    throw new Error(
      `[precheck] ROSTER_HIDDEN_UNDECIDABLE entries=${result.entryCount} expected=${expectedEntryCount}`,
    );
  if (result.hiddenCount !== 0)
    throw new Error(
      `[precheck] ROSTER_HAS_HIDDEN hidden=${result.hiddenCount} of ${result.entryCount}`,
    );
  return {
    entryCount: result.entryCount,
    checkedCount: result.checkedCount,
    hiddenCount: 0,
  };
}

/** 直近の宛先の標本がこれより古ければ、観測できていないとして止める（ms）。送信の直前に同期で 1 回 tick するので、通常は 0 に近い。 */
export const EGRESS_OBSERVATION_MAX_AGE_MS = 5_000;

/**
 * 宛先の観測（createEgressSampler の observation()）が、「許可リスト以外が無い」と言える証拠を備えているか（F3a の B1）。
 * 違反が無いだけでは足りない：標本が 1 回も成り立たない・直近の tick が失敗・socket を 1 つも見ていない・直近の tick が古い、
 * のどれでも「何も見ていない」ので通さない。止める理由の code を返す（通すなら null）。
 */
export function assessEgressObservation(observation) {
  if (
    observation === null ||
    typeof observation !== "object" ||
    !Array.isArray(observation.violations)
  )
    return "EGRESS_UNDECIDABLE";
  if (observation.violations.length > 0) return "EGRESS_NOT_ALLOWED";
  if (
    !(Number.isInteger(observation.sampleCount) && observation.sampleCount >= 1)
  )
    return "EGRESS_UNOBSERVED";
  if (observation.lastTickOk !== true) return "EGRESS_SAMPLE_FAILED";
  if (
    !(
      Number.isInteger(observation.lastSocketCount) &&
      observation.lastSocketCount >= 1
    )
  )
    return "EGRESS_NO_SOCKETS";
  // unix socket だけでは、TCP の宛先が見えている証拠にならない：直近の tick で、子孫の fd が /proc/net/tcp・tcp6 の行に
  // 1 つ以上一致していること（F5 の m-c）。
  if (
    !(
      Number.isInteger(observation.lastTcpSocketCount) &&
      observation.lastTcpSocketCount >= 1
    )
  )
    return "EGRESS_NO_TCP_SOCKETS";
  if (
    !(
      Number.isFinite(observation.ageMs) &&
      observation.ageMs >= 0 &&
      observation.ageMs <= EGRESS_OBSERVATION_MAX_AGE_MS
    )
  )
    return "EGRESS_STALE";
  return null;
}

/**
 * 送る前の条件（宛先の観測・役割の上書き・名簿の hidden）を 1 度に確かめる。例外は投げず、
 * { ok:true, record } か { ok:false, code } を返す。判定が返らない・形が違うのも ok:false（止める側）。
 * 宛先は assessEgressObservation（違反が無いだけでなく、観測できている証拠が要る）。
 */
export async function evaluateSendPreconditions({
  roleDefaults,
  rosterHidden,
  egressObservation,
  expectedEntryCount = null,
}) {
  let observation;
  try {
    observation = egressObservation();
  } catch {
    return { ok: false, code: "EGRESS_UNDECIDABLE" };
  }
  const egressCode = assessEgressObservation(observation);
  if (egressCode) return { ok: false, code: egressCode };
  const record = {
    egress: {
      disallowedDestinationCount: 0,
      sampleCount: observation.sampleCount,
      lastSocketCount: observation.lastSocketCount,
      lastTcpSocketCount: observation.lastTcpSocketCount,
    },
  };
  for (const [name, code, run, assertFn] of [
    [
      "role",
      "ROLE_OVERRIDE_UNDECIDABLE",
      roleDefaults,
      (value) => assertRoleOverridesDefault(value),
    ],
    [
      "hidden",
      "ROSTER_HIDDEN_UNDECIDABLE",
      rosterHidden,
      (value) => assertRosterNotHidden(value, { expectedEntryCount }),
    ],
  ]) {
    let raw;
    try {
      raw = await run();
    } catch {
      return { ok: false, code }; // page の関数が無い・throw（設定・DB が読めない）は判定できない。
    }
    try {
      record[name] = assertFn(raw);
    } catch (error) {
      return {
        ok: false,
        code:
          /\[precheck\] ([A-Z_]+)/u.exec(String(error?.message))?.[1] ?? code,
      };
    }
  }
  return { ok: true, record };
}

/** B の Entry は先頭 200 の窓に収まること（窓の外は 0）。 */
export function assertEntriesWithinWindow(prepared) {
  if (prepared.entryCount > MAX_ENTRIES)
    throw new Error(
      `[precheck] ENTRIES_OVER_WINDOW entries=${prepared.entryCount} window=${MAX_ENTRIES}`,
    );
}

/**
 * 終了時：ai_usage の surface と ai_audit_events の path_id が「空、または codex_judgment だけ」であること
 * （要約・題名・保守・Agent など他の AI 経路が起動していないことの確認）。要求を 1 件も送っていなければ
 * 両方が空。全要求が行を残さずに失敗した cell（401／429 など。recordAiUsage の前に throw する）も空になるので
 * 許す。送信の成功数と行数の一致は別に検査する（checkUsageCoversSuccesses）。
 * 例外は投げずに結果を返す（結果を records に残してから cell を不採用にする）。
 */
export function checkOnlyCodexJudgment({
  usageSurfaces,
  auditPathIds,
  requestsSent,
}) {
  const usage = [...new Set(usageSurfaces)].sort();
  const audit = [...new Set(auditPathIds)].sort();
  const ok = (set) =>
    requestsSent > 0
      ? set.length === 0 || (set.length === 1 && set[0] === CODEX_JUDGMENT)
      : set.length === 0;
  return {
    ok: ok(usage) && ok(audit),
    usageSurfaceCount: usage.length,
    auditPathCount: audit.length,
  };
}

/** 例外版（試験・単独の検査用）。 */
export function assertOnlyCodexJudgment(input) {
  const result = checkOnlyCodexJudgment(input);
  if (!result.ok)
    throw new Error(
      `[artifact] AI_SURFACE_SET usageSurfaces=${result.usageSurfaceCount} auditPaths=${result.auditPathCount} requests=${input.requestsSent}`,
    );
  return {
    usageSurfaceCount: result.usageSurfaceCount,
    auditPathCount: result.auditPathCount,
  };
}

/** 成功した要求の数以上の usage の行があること（成功した要求は、必ず行を 1 つ以上残す）。 */
export function checkUsageCoversSuccesses({ usageRows, successfulRequests }) {
  return usageRows >= successfulRequests;
}

// ---- ai_usage の読み ----------------------------------------------------------

async function pollUsageRows(api, before, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let rows;
  for (;;) {
    rows = await api.usageRowsSince(before);
    if (rows.length > 0 || Date.now() >= deadline) break;
    await api.sleep(intervalMs);
  }
  return rows;
}

/** 行の token の合計（null は 0 として足す）。課金の元になるので全件を足す。 */
function sumRows(rows) {
  return rows.reduce(
    (acc, row) => ({
      input_tokens: acc.input_tokens + (Number(row.tokens_in) || 0),
      output_tokens: acc.output_tokens + (Number(row.tokens_out) || 0),
    }),
    { input_tokens: 0, output_tokens: 0 },
  );
}

/**
 * 1 要求の後の ai_usage の行を読む。judgeCandidates は recordAiUsage を待たないので、行が増えるまで
 * poll する（上限つき）。行なし・tokens が null・tokens が 0・別の surface は、別の失敗理由として返す。
 * 成功＝全行の surface が codex_judgment で tokens_in・tokens_out がどちらも正。課金は全行の合算
 * （失敗の理由の返り値にも usage の合算を付け、台帳が課金できるようにする）。
 */
export async function readUsageForRequest(
  api,
  before,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
) {
  const rows = await pollUsageRows(api, before, { timeoutMs, intervalMs });
  if (rows.length === 0) return { ok: false, kind: "no-usage-row" };
  const usage = sumRows(rows);
  const rowCount = rows.length;
  if (rows.some((row) => row.surface !== CODEX_JUDGMENT))
    return { ok: false, kind: "wrong-surface", usage, rowCount };
  if (rows.some((row) => row.tokens_in === null || row.tokens_out === null))
    return { ok: false, kind: "tokens-null", usage, rowCount };
  if (rows.some((row) => !(row.tokens_in > 0 && row.tokens_out > 0)))
    return { ok: false, kind: "tokens-zero", usage, rowCount };
  return { ok: true, usage, model: rows[0].model, rowCount };
}

/** 通信の前に終わる失敗（課金されない）。これ以外の失敗は、行が残っていないか読む。 */
export const NO_COMMUNICATION_KINDS = Object.freeze([
  "not-armed",
  "policy-or-license",
  "no-candidates",
  "license",
  "role-override",
  "hidden-roster",
]);

/**
 * 失敗した要求の後の行（API は応答して課金済みで、parse の前に recordAiUsage が走る経路がある）。
 * 行があれば、全行の合算 usage と、別の surface の有無を返す。無ければ null。
 */
export async function readUsageAfterFailure(
  api,
  before,
  { timeoutMs = 2_000, intervalMs = 100 } = {},
) {
  const rows = await pollUsageRows(api, before, { timeoutMs, intervalMs });
  if (rows.length === 0) return null;
  return {
    usage: sumRows(rows),
    wrongSurface: rows.some((row) => row.surface !== CODEX_JUDGMENT),
    rowCount: rows.length,
  };
}

// ---- 1 要求（送信する経路はここだけ） -------------------------------------------

/**
 * 1 要求。preflight→送信→ai_usage→台帳の順。主 arm は再送しない。通信の失敗（429／5xx／接続）に限り
 * 1 回再送し、別列（retried）に数える。BudgetStop は呼び出し側へ投げる（超過分は後で足さない）。
 * 返り値：{ ok, failureKind, httpStatus, usage, judgments, attempts, retried, durationMs }
 */
export async function sendOne({
  api,
  gate,
  stage,
  estimate,
  remainingAfterThis = 0,
  note = "",
  usagePoll,
}) {
  const estInputTokens = estimateInputTokens(estimate);
  const estOutputTokens = estimateOutputTokens(estimate.judgedSlots);
  let attempts = 0;
  let retried = false;
  for (;;) {
    gate.preflight({
      stage,
      estInputTokens,
      estOutputTokens,
      remainingAfterThis,
    });
    let before;
    try {
      before = await api.usageRowCount();
    } catch (error) {
      gate.release?.(); // まだ送っていない（行の数が読めなかった）。予約を取り消してから投げる。
      throw error;
    }
    attempts++;
    let res;
    try {
      res = await api.judge();
    } catch (error) {
      if (error instanceof BudgetStop) {
        // 送る直前の guard が止めた（要求は出ていない）。preflight の予約を取り消してから止める。
        gate.release?.();
        throw error;
      }
      // judge が例外を投げた（page の crash・evaluate の失敗など）。要求が出たか不明のため、行を残して最大の見積りで課金し、
      // 停止線を立てる（台帳の行が残らない窓を作らない。F3a の M2）。例外の文面は載せない。
      res = { ok: false, kind: "judge-error", httpStatus: null, durationMs: 0 };
    }
    let outcome;
    let judgments = null;
    let model = null;
    if (res.ok) {
      // usage の行の読みが throw しても（DB が読めないなど）、応答は返って課金されている。行を残さずに予約だけが残る窓を
      // 作らない：応答が返ったのに usage が読めない失敗として台帳に行を残し（最悪値の課金）、停止線を立てる（F5 の m-a）。
      let usage;
      try {
        usage = await readUsageForRequest(api, before, usagePoll);
      } catch {
        usage = { ok: false, kind: "usage-read-error" };
      }
      if (usage.ok) {
        outcome = { ok: true, usage: usage.usage, responded: true };
        judgments = res.judgments;
        model = usage.model;
      } else {
        // 応答は課金されている。行から読めた token は台帳に載せる（読めない理由は停止線が見る）。
        outcome = {
          ok: false,
          failureKind: usage.kind,
          usage: usage.usage,
          responded: true,
        };
      }
    } else {
      outcome = {
        ok: false,
        failureKind: res.kind,
        httpStatus: res.httpStatus ?? null,
      };
      if (!NO_COMMUNICATION_KINDS.includes(res.kind)) {
        // 送信の後に例外を投げる経路（有効結果なしなど）は、課金済みで行が残る。台帳が実費を見るため読む。
        const failedPoll = {
          ...(usagePoll?.timeoutMs !== undefined
            ? { timeoutMs: Math.min(usagePoll.timeoutMs, 2_000) }
            : {}),
          ...(usagePoll?.intervalMs !== undefined
            ? { intervalMs: usagePoll.intervalMs }
            : {}),
          ...(usagePoll?.failureTimeoutMs !== undefined
            ? { timeoutMs: usagePoll.failureTimeoutMs }
            : {}),
        };
        // 読みが throw したら（DB が読めない）、行が残っているか分からない：応答が返ったのに usage が読めない失敗
        // （usage-read-error）として、最悪値の課金と停止線にする。429・5xx でも再送に進まない（再送の分類は kind を見る。
        // F5 の m-a）。
        let after;
        try {
          after = await readUsageAfterFailure(api, before, failedPoll);
        } catch {
          outcome.failureKind = "usage-read-error";
          outcome.responded = true;
          after = null;
        }
        if (after) {
          outcome.usage = after.usage;
          if (after.wrongSurface) outcome.failureKind = "wrong-surface";
        }
      }
    }
    try {
      gate.afterRequest({
        stage,
        outcome,
        estInputTokens,
        estOutputTokens,
        remainingAfterThis,
        note: `${note}${retried ? " retry" : ""}`,
      });
    } catch (error) {
      if (error instanceof BudgetStop) error.partial = { outcome, judgments };
      throw error;
    }
    if (
      !outcome.ok &&
      !retried &&
      !res.ok &&
      RETRYABLE_FAILURE_KINDS.includes(outcome.failureKind)
    ) {
      retried = true;
      continue;
    }
    return {
      ok: outcome.ok,
      failureKind: outcome.ok ? null : outcome.failureKind,
      httpStatus: outcome.httpStatus ?? null,
      usage: outcome.usage ?? null,
      judgments,
      model,
      attempts,
      retried,
      durationMs: res.durationMs ?? 0,
      estInputTokens,
      estOutputTokens,
    };
  }
}

// ---- 指標 ---------------------------------------------------------------------

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

/** 名簿の型に対して、AI が返した型が合うか（other は item・lore を許す）。 */
export function typeMatches(rosterType, suggestedType) {
  if (rosterType === "character") return suggestedType === "character";
  if (rosterType === "location") return suggestedType === "location";
  return suggestedType === "item" || suggestedType === "lore";
}

/**
 * 1 要求の判定を、名簿との一致で数える（名簿は仮の正解。品質の主張に使わない）。
 * candidates：画面の候補（count 降順。先頭 50 が判定の対象）。judgments：keyHash → { suggestedType, aliasOfId }。
 * 名簿に無い表記（未判定）は、誤りにも名簿どおりにも数えない。
 *
 * 別名ボタン（aliasButtons）は製品の画面（CodexCandidatesReport.tsx）と同じ条件で数える：AI が別名を勧め（aliasOfId が
 * 実在 id）、かつ表記が製品の isRelationalTerm に当たらない。呼び名の判定は製品の一覧（extraction/relationalTerms.ts）で、
 * renderer が候補の行に candidate.relationalTerm（真偽）を付けて渡す（この file に一覧の写しは持たない）。
 * 旗の無い候補は false（呼び名でない）として数える。
 *   aliasProposed                       AI が別名を勧めた数（aliasOfId が null でない。ボタンの有無に依らない）
 *   aliasButtonsSuppressedRelational    別名を勧められたが、呼び名なので製品が別名ボタンを出さない数
 * 名簿との一致の指標（aliasMatchRoster 等）は AI の判定の中身を見るので、ボタンの有無に依らず aliasOfId で数える。
 */
export function judgmentMetrics({ index, candidates, judgments }) {
  const m = {
    candidateCount: candidates.length,
    slots: Math.min(candidates.length, MAX_CANDIDATES),
    judged: 0,
    droppedInWindow: 0,
    beyondWindow: Math.max(0, candidates.length - MAX_CANDIDATES),
    aliasButtons: 0,
    aliasProposed: 0,
    aliasButtonsSuppressedRelational: 0,
    aliasMatchRoster: 0,
    aliasMismatchRoster: 0,
    aliasOnAmbiguousInSet: 0,
    aliasOnAmbiguousOutOfSet: 0,
    aliasOnUnlisted: 0,
    missedBindNullAlias: 0,
    missedBindBeyondWindow: 0,
    missedBindDropped: 0,
    listedEntityCandidates: 0,
    ambiguousCandidates: 0,
    unlistedCandidates: 0,
    // 敬称の形（§3：別名に入れない）は、名簿どおり・結び残しの母集団から外して別枠に数える。
    honorificCandidates: 0,
    honorificWithAlias: 0,
    // 関係の呼び名（続柄・二人称・三人称の呼び方）は登録しない別の種類。名簿どおり・結び残しの母集団から外して別枠に数える。
    relationalCandidates: 0,
    relationalWithAlias: 0,
    // B の名簿の窓（200 実体）で切った実体の表記は、未登録（unlisted）と分けて数える。
    cutRosterCandidates: 0,
    aliasOnCutRoster: 0,
    typeChecked: 0,
    typeMismatch: 0,
    aliasOfUnknownId: 0,
  };
  candidates.forEach((candidate, i) => {
    const lookup = lookupRoster(index, candidate.keyHash, [
      candidate.firstSceneIndex,
    ]);
    const inWindow = i < MAX_CANDIDATES;
    const judgment = inWindow ? judgments.get(candidate.keyHash) : undefined;
    const honorific = lookup.kind === "entity" && lookup.honorific === true;
    const cut =
      lookup.kind === "unlisted" && index.cutKeys?.has(candidate.keyHash);
    const relational = lookup.kind === "relational";
    if (honorific) m.honorificCandidates++;
    else if (relational) m.relationalCandidates++;
    else if (lookup.kind === "entity") m.listedEntityCandidates++;
    else if (lookup.kind === "ambiguous") m.ambiguousCandidates++;
    else if (cut) m.cutRosterCandidates++;
    else m.unlistedCandidates++;
    if (inWindow && judgment) m.judged++;
    if (inWindow && !judgment) m.droppedInWindow++;
    if (judgment && judgment.aliasKnown === false) m.aliasOfUnknownId++;
    const alias = judgment?.aliasOfId ?? null;
    if (alias !== null) {
      m.aliasProposed++;
      if (candidate.relationalTerm === true)
        m.aliasButtonsSuppressedRelational++;
      else m.aliasButtons++;
    }
    if (honorific) {
      if (alias !== null) m.honorificWithAlias++;
    } else if (relational) {
      if (alias !== null) m.relationalWithAlias++;
    } else if (lookup.kind === "entity") {
      if (alias === lookup.id) m.aliasMatchRoster++;
      else if (alias !== null) m.aliasMismatchRoster++;
      else if (!inWindow) m.missedBindBeyondWindow++;
      else if (!judgment) m.missedBindDropped++;
      else m.missedBindNullAlias++;
      if (judgment) {
        m.typeChecked++;
        if (
          !typeMatches(
            index.entities.get(lookup.id)?.type,
            judgment.suggestedType,
          )
        )
          m.typeMismatch++;
      }
    } else if (lookup.kind === "ambiguous" && alias !== null) {
      if (lookup.ids.includes(alias)) m.aliasOnAmbiguousInSet++;
      else m.aliasOnAmbiguousOutOfSet++;
    } else if (lookup.kind === "unlisted" && alias !== null) {
      if (cut) m.aliasOnCutRoster++;
      else m.aliasOnUnlisted++;
    }
  });
  return m;
}

/**
 * 登録した表記（名前・別名の keyHash）が、画面の候補にどう現れるか。画面の候補（visible）は既知名の
 * 完全一致を除いた後の集合なので、登録した表記は構成上かならず visible に無い。分けて数える：
 *   excludedByExactMatch  scan の結果（raw。既知名の除外の前）にあり、完全一致で除かれた
 *   notInRaw              raw に無い（出現 2 未満などで、そもそも候補に上がらない）
 *   shownDespiteRegistered 画面の候補に残っている（除外の式の違い。0 でなければ道具の確認）
 * rawKeyHashes が無い（古い prepared）ときは raw の区別をせず total と shown だけ返す。
 */
export function registeredSurfaceSplit(
  registeredKeyHashes,
  { candidates = [], rawKeyHashes = null } = {},
) {
  const shown = new Set(candidates.map((c) => c.keyHash));
  const raw = rawKeyHashes ? new Set(rawKeyHashes) : null;
  const unique = new Set(registeredKeyHashes);
  let excludedByExactMatch = 0;
  let notInRaw = 0;
  let shownDespiteRegistered = 0;
  for (const keyHash of unique) {
    if (shown.has(keyHash)) shownDespiteRegistered++;
    else if (raw === null) continue;
    else if (raw.has(keyHash)) excludedByExactMatch++;
    else notInRaw++;
  }
  return {
    registered: unique.size,
    excludedByExactMatch: raw ? excludedByExactMatch : null,
    notInRaw: raw ? notInRaw : null,
    shownDespiteRegistered,
  };
}

/** 3 回の自己一致（aliasOfId）。2 回以上判定された候補について、全回で同じか。 */
export function selfAgreement(runs) {
  const byKey = new Map();
  for (const run of runs)
    for (const [keyHash, j] of run) {
      if (!byKey.has(keyHash)) byKey.set(keyHash, []);
      byKey.get(keyHash).push(j);
    }
  let compared = 0;
  let aliasAgree = 0;
  let typeAgree = 0;
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    compared++;
    if (
      list.every((j) => (j.aliasOfId ?? null) === (list[0].aliasOfId ?? null))
    )
      aliasAgree++;
    if (list.every((j) => j.suggestedType === list[0].suggestedType))
      typeAgree++;
  }
  return {
    keysCompared: compared,
    aliasAgree,
    typeAgree,
    successfulRuns: runs.length,
  };
}

function toJudgmentMap(judgments) {
  return new Map(judgments.map((j) => [j.keyHash, j]));
}

// ---- B1：画面どおり（作品×段×3 回）------------------------------------------------

/**
 * 候補を作り、同じ候補・同じ名簿に対して repeats 回、独立の要求を送る。
 * 返り値の requests に、要求ごとの結果（成否・token・USD の元・指標）が入る。
 * BudgetStop が起きたら、それまでの結果と stopped（理由コード）を返す。
 */
export async function runB1({
  api,
  gate,
  index,
  registeredKeyHashes = [],
  stage = "B1",
  repeats = REPEATS_B1,
  remainingAfter = 0,
  usagePoll,
}) {
  assertAiGate(await api.gate());
  const prepared = await api.prepare({ rescan: true });
  assertEntriesWithinWindow(prepared);
  const estimate = await api.estimate();
  assertEstimateMatches(prepared, estimate);
  const requests = [];
  let stopped = null;
  for (let i = 0; i < repeats; i++) {
    try {
      const result = await sendOne({
        api,
        gate,
        stage,
        estimate,
        remainingAfterThis: remainingAfter + (repeats - 1 - i),
        note: `b1 r${i + 1}`,
        usagePoll,
      });
      requests.push(buildRequestRecord(result, prepared, index));
    } catch (error) {
      if (!(error instanceof BudgetStop)) throw error;
      stopped = { code: error.code, detail: error.detail };
      if (error.partial) {
        // 停止線に当たった要求自体の結果は残す（記録は台帳に済んでいる）。
        const { outcome, judgments } = error.partial;
        requests.push(
          buildRequestRecord(
            {
              ok: outcome.ok,
              failureKind: outcome.failureKind ?? null,
              httpStatus: outcome.httpStatus ?? null,
              usage: outcome.usage ?? null,
              judgments,
              attempts: 1,
              retried: false,
            },
            prepared,
            index,
          ),
        );
      }
      break;
    }
  }
  const successes = requests.filter((r) => r.ok);
  return {
    candidates: {
      rawCount: prepared.rawCount,
      activeCount: prepared.activeCount,
      visibleCount: prepared.visibleCount,
      dismissedCount: prepared.dismissedCount,
      entryCount: prepared.entryCount,
    },
    estimate,
    registeredSurfaces: registeredSurfaceSplit(registeredKeyHashes, prepared),
    requests: requests.map(({ judgmentMap: _judgmentMap, ...rest }) => rest),
    selfAgreement: selfAgreement(successes.map((r) => r.judgmentMap)),
    failuresByKind: requests.reduce((acc, r) => {
      if (!r.ok) bump(acc, r.failureKind ?? "other");
      return acc;
    }, {}),
    successCount: successes.length,
    stopped,
    // B 側で「判断不能」にする条件（§8-4）：3 回中 2 回以上の失敗、または自己一致を出すのに成功が 2 回未満。
    undeterminable:
      requests.length - successes.length >= 2 || successes.length < 2,
  };
}

function buildRequestRecord(result, prepared, index) {
  const judgmentMap = result.ok ? toJudgmentMap(result.judgments) : new Map();
  return {
    ok: result.ok,
    failureKind: result.failureKind ?? null,
    httpStatus: result.httpStatus ?? null,
    attempts: result.attempts,
    retried: result.retried,
    usage: result.usage ?? null,
    model: result.model ?? null,
    durationMs: result.durationMs ?? 0,
    metrics: result.ok
      ? judgmentMetrics({
          index,
          candidates: prepared.candidates,
          judgments: judgmentMap,
        })
      : null,
    judgmentMap,
  };
}

// ---- B2：模擬作者が名簿どおりに進める（L2 だけ・1 回）-----------------------------------

/**
 * 模擬作者の決定。名簿で既存の実体の表記→別名（登録済みの実体へ）／未登録の実体→受理／
 * 敬称の形・関係の呼び名・場面で指す人が決まらない表記・名簿に無い表記→却下（種類別に数える）。
 * 関係の呼び名（relational）は Codex に登録しないので、別名にも受理にもしない。
 * relationalTerm：製品の isRelationalTerm に当たる表記（renderer が候補の行に付ける）。製品の候補画面は呼び名には
 * 別名ボタンを出さないので、名簿で既存の実体でも別名の決定は作れない（理由 relational-no-alias-button の却下にする）。
 */
export function authorDecision(
  lookup,
  registeredIds,
  rosterTypeOf,
  { relationalTerm = false } = {},
) {
  if (lookup.kind === "unlisted" && lookup.cut === true)
    return { action: "dismiss", reason: "cut-roster" };
  if (lookup.kind === "entity" && !lookup.honorific) {
    if (registeredIds.has(lookup.id)) {
      if (relationalTerm)
        return { action: "dismiss", reason: "relational-no-alias-button" };
      return { action: "alias", targetId: lookup.id, reason: "alias" };
    }
    return {
      action: "accept",
      newId: lookup.id,
      type: codexTypeOf(rosterTypeOf(lookup.id)),
      reason: "accept",
    };
  }
  if (lookup.kind === "entity")
    return { action: "dismiss", reason: "honorific" };
  if (lookup.kind === "ambiguous")
    return { action: "dismiss", reason: "ambiguous" };
  if (lookup.kind === "relational")
    return { action: "dismiss", reason: "relational" };
  return { action: "dismiss", reason: "unlisted" };
}

/**
 * 候補を ceil(N/50) 回の要求で進める。1 回ごとに、判定した先頭 50 件を名簿どおりに決定し、反映して作り直す。
 * 名簿に無い候補は画面を進めるために却下として扱い、却下の件数を別に数える（誤りにも名簿どおりにも数えない）。
 */
export async function runB2({
  api,
  gate,
  index,
  rosterTypeOf,
  registeredIds,
  registeredKeyHashes = [],
  stage = "B2",
  remainingAfter = 0,
  usagePoll,
  maxIterations = 200,
}) {
  assertAiGate(await api.gate());
  let prepared = await api.prepare({ rescan: true });
  const firstPrepared = prepared;
  assertEntriesWithinWindow(prepared);
  let applyMissing = 0;
  const initialCount = prepared.visibleCount;
  const plannedIterations = Math.ceil(initialCount / MAX_CANDIDATES);
  const iterations = [];
  const decisionCounts = { alias: 0, accept: 0, dismiss: 0 };
  const dismissReasons = {};
  let stopped = null;
  let noProgress = false;
  for (let n = 0; n < maxIterations && prepared.visibleCount > 0; n++) {
    const estimate = await api.estimate();
    assertEstimateMatches(prepared, estimate);
    let result;
    try {
      result = await sendOne({
        api,
        gate,
        stage,
        estimate,
        remainingAfterThis:
          remainingAfter +
          Math.max(0, Math.ceil(prepared.visibleCount / MAX_CANDIDATES) - 1),
        note: `b2 i${n + 1}`,
        usagePoll,
      });
    } catch (error) {
      if (!(error instanceof BudgetStop)) throw error;
      stopped = { code: error.code, detail: error.detail };
      break;
    }
    const record = buildRequestRecord(result, prepared, index);
    iterations.push({
      ...(({ judgmentMap: _judgmentMap, ...rest }) => rest)(record),
      visibleBefore: prepared.visibleCount,
    });
    if (!result.ok) break; // 判定なしでは進められない（失敗は別に数える。再送は sendOne が 1 回だけ行った）
    const window = prepared.candidates.slice(0, MAX_CANDIDATES);
    const decisions = window.map((candidate) => {
      const found = lookupRoster(index, candidate.keyHash, [
        candidate.firstSceneIndex,
      ]);
      const lookup =
        found.kind === "unlisted" && index.cutKeys?.has(candidate.keyHash)
          ? { ...found, cut: true }
          : found;
      const d = authorDecision(lookup, registeredIds, rosterTypeOf, {
        relationalTerm: candidate.relationalTerm === true,
      });
      if (d.action === "accept") registeredIds.add(d.newId);
      decisionCounts[d.action]++;
      if (d.action === "dismiss") bump(dismissReasons, d.reason);
      return { keyHash: candidate.keyHash, ...d };
    });
    const before = prepared.visibleCount;
    const applied = await api.apply(
      decisions.map(({ reason: _reason, ...rest }) => rest),
    );
    prepared = applied;
    // 反映できなかった決定（対象の実体が見つからないなど）。0 でなければ、その作品の B2 は判断不能。
    applyMissing += applied.counts?.missing ?? 0;
    if (applied.visibleCount >= before) {
      noProgress = true;
      break;
    }
  }
  return {
    initialCandidateCount: initialCount,
    plannedIterations,
    iterations,
    decisionCounts,
    dismissReasons,
    stopped,
    noProgress,
    registeredSurfaces: registeredSurfaceSplit(
      registeredKeyHashes,
      firstPrepared,
    ),
    applyMissing,
    // §6 の「未登録の実体は受理」の経路は、B の名簿が L2 の全 Entry を登録するので通らない（accept は 0 のはず）。
    // 0 でない、反映できなかった決定がある、失敗・停止・進まなかった要求があるときは判断不能。
    undeterminable:
      decisionCounts.accept > 0 ||
      applyMissing > 0 ||
      stopped !== null ||
      noProgress ||
      iterations.some((i) => !i.ok),
    finalVisibleCount: prepared.visibleCount,
  };
}

// ---- 計画の残り（外挿の元）--------------------------------------------------------

/**
 * §9 の「累計 80% で、残りの外挿が上限を超えるなら止める」の「残り」は、cell 内でなく計画の残り全体。
 * cells：この launcher の cell の並び（{work, level}）。cellIndex：いまの cell。この cell の後に予定している
 * 要求の数を返す：後ろの cell の要求（trial 1、B1 は repeats、B2 は作品ごとの上限 b2Upper[work]。
 * 乾いた実行の結果が無ければ fallbackB2Upper）と、この launcher の後に続くモードの要求
 * （trial の後は B1 全作品×全段と B2、B1 の後は B2）。
 */
export function remainingRequestsAfterCell({
  mode,
  cells,
  cellIndex,
  allWorks,
  levels = ["L0", "L1", "L2", "L3"],
  b2Upper = {},
  fallbackB2Upper = 6,
  repeats = REPEATS_B1,
}) {
  const b2Of = (work) => b2Upper[work] ?? fallbackB2Upper;
  const perCell = (cell) =>
    mode === "trial" ? 1 : mode === "b1" ? repeats : b2Of(cell.work);
  let remaining = 0;
  for (let i = cellIndex + 1; i < cells.length; i++)
    remaining += perCell(cells[i]);
  const b1All = allWorks.length * levels.length * repeats;
  const b2All = allWorks.reduce((n, work) => n + b2Of(work), 0);
  if (mode === "trial") remaining += b1All + b2All;
  else if (mode === "b1") remaining += b2All;
  return remaining;
}

// ---- 乾いた実行 -----------------------------------------------------------------

/**
 * 送信の直前まで進め、候補・要求の本文の件数を測る（api.judge は呼ばない）。
 * 要求の本文は page で製品と同じ式で組み、文字数だけを返す。
 */
export async function dryMeasure({ api, repeats = REPEATS_B1 }) {
  const gateState = await api.gate();
  const prepared = await api.prepare({ rescan: true });
  const estimate = await api.estimate();
  assertEstimateMatches(prepared, estimate);
  return {
    gate: {
      policyBlocked: gateState.policyBlocked,
      licenseRestricted: gateState.licenseRestricted,
      language: gateState.language,
    },
    candidates: {
      rawCount: prepared.rawCount,
      activeCount: prepared.activeCount,
      visibleCount: prepared.visibleCount,
      entryCount: prepared.entryCount,
    },
    request: {
      judgedSlots: estimate.judgedSlots,
      entrySlots: estimate.entrySlots,
      entryAliasCount: estimate.entryAliasCount,
      contextChars: estimate.contextChars,
      promptChars: estimate.promptChars,
      promptNonAsciiChars: estimate.promptNonAsciiChars,
      parts: estimate.parts ?? null,
      estInputTokens: estimateInputTokens(estimate),
      estOutputTokens: estimateOutputTokens(estimate.judgedSlots),
    },
    b1Requests: repeats,
    b2Requests: Math.ceil(prepared.visibleCount / MAX_CANDIDATES),
  };
}

/**
 * 乾いた実行の測定の列（作品×段）から、要求の一覧を作って費用を見積もる。
 * rows：[{ work, level, request:{estInputTokens,estOutputTokens}, b1Requests, b2Requests }]。
 * B1 は全段、B2 は L2 だけ。試走は trialRequests 件（最大の B1 の見積りで）。
 */
export function buildDryRunPlan(rows, { pricing, trialRequests = 3 }) {
  const requests = [];
  let largest = null;
  for (const row of rows) {
    if (!row.level || row.level === "empty") continue;
    for (let i = 0; i < row.b1Requests; i++)
      requests.push({
        stage: "B1",
        work: row.work,
        level: row.level,
        estInputTokens: row.request.estInputTokens,
        estOutputTokens: row.request.estOutputTokens,
      });
    if (row.level === "L2")
      for (let i = 0; i < row.b2Requests; i++)
        requests.push({
          stage: "B2",
          work: row.work,
          level: row.level,
          estInputTokens: row.request.estInputTokens,
          estOutputTokens: row.request.estOutputTokens,
        });
    if (largest === null || row.request.estInputTokens > largest.estInputTokens)
      largest = row.request;
  }
  if (largest)
    for (let i = 0; i < trialRequests; i++)
      requests.push({
        stage: "trial",
        work: "-",
        level: "-",
        estInputTokens: largest.estInputTokens,
        estOutputTokens: largest.estOutputTokens,
      });
  return { requests, cost: planCost(requests, { pricing }) };
}

// ---- 乾いた実行の外挿（名簿の規模を仮定した上限の見積り）--------------------------------

/** 内訳（ascii・非 ascii の文字数）から token を見積もる（estimateInputTokens と同じ比）。 */
function tokensOfParts(ascii, nonAscii) {
  return estimateInputTokens({
    promptChars: ascii + nonAscii,
    promptNonAsciiChars: nonAscii,
  });
}

/**
 * 合成の小さな名簿で測った内訳から、本物の名簿の規模（実体数・実体あたりの別名数）を仮定した 1 要求の見積りを作る。
 * 候補の部分は空の名簿の行（候補が最も多い＝上限側）、Entry の部分は実体あたり・別名あたりの測定値に実体数を掛ける。
 * emptyRow・l0Row・l3Row：dryMeasure の行（parts を持つもの）。
 * 戻り値：{ estInputTokens, estOutputTokens, basis } または、内訳が無ければ null。
 */
export function projectRequest({
  emptyRow,
  l0Row,
  l3Row,
  entities,
  aliasesPerEntity,
}) {
  const parts = (row) => row?.request?.parts ?? null;
  const e = parts(emptyRow);
  const z = parts(l0Row);
  const t = parts(l3Row);
  if (!e || !z || !t) return null;
  const sides = (p, key) => ({
    ascii: p[`${key}Chars`] - p[`${key}NonAscii`],
    non: p[`${key}NonAscii`],
  });
  const base = sides(e, "base");
  const cand = sides(e, "candidates");
  const entity0 = sides(z, "entries");
  const entity3 = sides(t, "entries");
  const e0 = Math.max(1, l0Row.request.entrySlots);
  const dAliases = Math.max(
    0,
    l3Row.request.entryAliasCount - l0Row.request.entryAliasCount,
  );
  const perEntity = { ascii: entity0.ascii / e0, non: entity0.non / e0 };
  // 別名あたり：増分が取れなければ、実体あたりの 1/2 を仮置きする。
  const perAlias =
    dAliases > 0
      ? {
          ascii: Math.max(0, entity3.ascii - entity0.ascii) / dAliases,
          non: Math.max(0, entity3.non - entity0.non) / dAliases,
        }
      : { ascii: perEntity.ascii / 2, non: perEntity.non / 2 };
  const ascii =
    base.ascii +
    cand.ascii +
    entities * perEntity.ascii +
    entities * aliasesPerEntity * perAlias.ascii;
  const non =
    base.non +
    cand.non +
    entities * perEntity.non +
    entities * aliasesPerEntity * perAlias.non;
  return {
    estInputTokens: tokensOfParts(ascii, non),
    estOutputTokens: estimateOutputTokens(emptyRow.request.judgedSlots),
    basis: {
      entities,
      aliasesPerEntity,
      candidateSlots: emptyRow.request.judgedSlots,
      aliasCostFallback: dAliases === 0,
    },
  };
}

/**
 * 作品ごとの dryMeasure の行（level は empty・L0〜L3）から、名簿の規模を仮定した要求の一覧と費用を作る。
 * scenario：{ entities, aliasesPerEntityByLevel:{L0..L3} }。B2 の要求数は空の名簿の N から ceil(N/50)。
 */
export function buildProjectedPlan(
  rowsByWork,
  scenario,
  { pricing, trialRequests = 3 },
) {
  const requests = [];
  const perWork = {};
  let largest = null;
  for (const [work, rows] of Object.entries(rowsByWork)) {
    const by = Object.fromEntries(rows.map((r) => [r.level, r]));
    const b2Requests = Math.ceil(
      (by.empty?.candidates.visibleCount ?? 0) / MAX_CANDIDATES,
    );
    perWork[work] = { levels: {}, b2Requests };
    for (const level of ["L0", "L1", "L2", "L3"]) {
      const p = projectRequest({
        emptyRow: by.empty,
        l0Row: by.L0,
        l3Row: by.L3,
        entities: scenario.entities,
        aliasesPerEntity: scenario.aliasesPerEntityByLevel[level],
      });
      if (!p) continue;
      perWork[work].levels[level] = {
        estInputTokens: p.estInputTokens,
        estOutputTokens: p.estOutputTokens,
      };
      for (let i = 0; i < REPEATS_B1; i++)
        requests.push({ stage: "B1", work, level, ...p });
      if (level === "L2")
        for (let i = 0; i < b2Requests; i++)
          requests.push({ stage: "B2", work, level, ...p });
      if (largest === null || p.estInputTokens > largest.estInputTokens)
        largest = p;
    }
  }
  if (largest)
    for (let i = 0; i < trialRequests; i++)
      requests.push({ stage: "trial", work: "-", level: "-", ...largest });
  return { requests, perWork, cost: planCost(requests, { pricing }) };
}
