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
    return { roster, cut: 0, entityCount: roster.entities.length };
  const keep = new Set(
    [...roster.entities]
      .sort(
        (a, b) =>
          sceneCountOf(b) - sceneCountOf(a) || String(a.id).localeCompare(String(b.id)),
      )
      .slice(0, limit)
      .map((entity) => entity.id),
  );
  return {
    roster: {
      ...roster,
      entities: roster.entities.filter((entity) => keep.has(entity.id)),
    },
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
    throw new Error("[precheck] AI_POLICY_OFF analysis policy blocks the judgment");
  if (gate.licenseRestricted)
    throw new Error("[precheck] LICENSE_RESTRICTED license restricts the judgment");
  if (gate.language !== "ja")
    throw new Error("[precheck] LANGUAGE_NOT_JA candidate judgment needs a ja project");
}

/** B の Entry は先頭 200 の窓に収まること（窓の外は 0）。 */
export function assertEntriesWithinWindow(prepared) {
  if (prepared.entryCount > MAX_ENTRIES)
    throw new Error(
      `[precheck] ENTRIES_OVER_WINDOW entries=${prepared.entryCount} window=${MAX_ENTRIES}`,
    );
}

/**
 * 終了時：ai_usage の surface と ai_audit_events の path_id が codex_judgment だけであること
 * （要約・題名・保守・Agent など他の AI 経路が起動していないことの確認）。
 * 要求を 1 件も送っていなければ両方が空でよい。
 */
export function assertOnlyCodexJudgment({ usageSurfaces, auditPathIds, requestsSent }) {
  const usage = [...new Set(usageSurfaces)].sort();
  const audit = [...new Set(auditPathIds)].sort();
  const ok = (set) =>
    requestsSent > 0
      ? set.length === 1 && set[0] === CODEX_JUDGMENT
      : set.length === 0;
  if (!ok(usage) || !ok(audit))
    throw new Error(
      `[artifact] AI_SURFACE_SET usageSurfaces=${usage.length} auditPaths=${audit.length} requests=${requestsSent}`,
    );
  return { usageSurfaceCount: usage.length, auditPathCount: audit.length };
}

// ---- ai_usage の読み ----------------------------------------------------------

/**
 * 1 要求の後の ai_usage の行を読む。judgeCandidates は recordAiUsage を待たないので、行が増えるまで
 * poll する（上限つき）。行なし・tokens が null・tokens が 0 は、別の失敗理由として返す。
 * 成功＝surface が codex_judgment で tokens_in・tokens_out がどちらも正の行。
 */
export async function readUsageForRequest(
  api,
  before,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  for (;;) {
    rows = await api.usageRowsSince(before);
    if (rows.length > 0 || Date.now() >= deadline) break;
    await api.sleep(intervalMs);
  }
  if (rows.length === 0) return { ok: false, kind: "no-usage-row" };
  const row = rows[0];
  if (row.surface !== CODEX_JUDGMENT) return { ok: false, kind: "wrong-surface" };
  if (row.tokens_in === null || row.tokens_out === null)
    return { ok: false, kind: "tokens-null", rowCount: rows.length };
  if (!(row.tokens_in > 0 && row.tokens_out > 0))
    return { ok: false, kind: "tokens-zero", rowCount: rows.length };
  return {
    ok: true,
    usage: { input_tokens: row.tokens_in, output_tokens: row.tokens_out },
    model: row.model,
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
    gate.preflight({ stage, estInputTokens, estOutputTokens, remainingAfterThis });
    const before = await api.usageRowCount();
    attempts++;
    const res = await api.judge();
    let outcome;
    let judgments = null;
    let model = null;
    if (res.ok) {
      const usage = await readUsageForRequest(api, before, usagePoll);
      if (usage.ok) {
        outcome = { ok: true, usage: usage.usage };
        judgments = res.judgments;
        model = usage.model;
      } else {
        outcome = { ok: false, failureKind: usage.kind };
      }
    } else {
      outcome = { ok: false, failureKind: res.kind, httpStatus: res.httpStatus ?? null };
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
 */
export function judgmentMetrics({ index, candidates, judgments }) {
  const m = {
    candidateCount: candidates.length,
    slots: Math.min(candidates.length, MAX_CANDIDATES),
    judged: 0,
    droppedInWindow: 0,
    beyondWindow: Math.max(0, candidates.length - MAX_CANDIDATES),
    aliasButtons: 0,
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
    typeChecked: 0,
    typeMismatch: 0,
    aliasOfUnknownId: 0,
  };
  candidates.forEach((candidate, i) => {
    const lookup = lookupRoster(index, candidate.keyHash, [candidate.firstSceneIndex]);
    const inWindow = i < MAX_CANDIDATES;
    const judgment = inWindow ? judgments.get(candidate.keyHash) : undefined;
    if (lookup.kind === "entity") m.listedEntityCandidates++;
    else if (lookup.kind === "ambiguous") m.ambiguousCandidates++;
    else m.unlistedCandidates++;
    if (inWindow && judgment) m.judged++;
    if (inWindow && !judgment) m.droppedInWindow++;
    if (judgment && judgment.aliasKnown === false) m.aliasOfUnknownId++;
    const alias = judgment?.aliasOfId ?? null;
    if (alias !== null) m.aliasButtons++;
    if (lookup.kind === "entity") {
      if (alias === lookup.id) m.aliasMatchRoster++;
      else if (alias !== null) m.aliasMismatchRoster++;
      else if (!inWindow) m.missedBindBeyondWindow++;
      else if (!judgment) m.missedBindDropped++;
      else m.missedBindNullAlias++;
      if (judgment) {
        m.typeChecked++;
        if (!typeMatches(index.entities.get(lookup.id)?.type, judgment.suggestedType))
          m.typeMismatch++;
      }
    } else if (lookup.kind === "ambiguous" && alias !== null) {
      if (lookup.ids.includes(alias)) m.aliasOnAmbiguousInSet++;
      else m.aliasOnAmbiguousOutOfSet++;
    } else if (lookup.kind === "unlisted" && alias !== null) {
      m.aliasOnUnlisted++;
    }
  });
  return m;
}

/** 候補に出ない既存名：登録した表記（名前・別名の keyHash）のうち、画面の候補に無いもの。 */
export function registeredNotInCandidates(registeredKeyHashes, candidates) {
  const shown = new Set(candidates.map((c) => c.keyHash));
  let absent = 0;
  for (const keyHash of registeredKeyHashes) if (!shown.has(keyHash)) absent++;
  return absent;
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
    if (list.every((j) => (j.aliasOfId ?? null) === (list[0].aliasOfId ?? null)))
      aliasAgree++;
    if (list.every((j) => j.suggestedType === list[0].suggestedType)) typeAgree++;
  }
  return { keysCompared: compared, aliasAgree, typeAgree, successfulRuns: runs.length };
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
    registeredNotInCandidates: registeredNotInCandidates(
      registeredKeyHashes,
      prepared.candidates,
    ),
    requests: requests.map(({ judgmentMap, ...rest }) => rest),
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
      ? judgmentMetrics({ index, candidates: prepared.candidates, judgments: judgmentMap })
      : null,
    judgmentMap,
  };
}

// ---- B2：模擬作者が名簿どおりに進める（L2 だけ・1 回）-----------------------------------

/**
 * 模擬作者の決定。名簿で既存の実体の表記→別名（登録済みの実体へ）／未登録の実体→受理／
 * 敬称の形・場面で指す人が決まらない表記・名簿に無い表記→却下（種類別に数える）。
 */
export function authorDecision(lookup, registeredIds, rosterTypeOf) {
  if (lookup.kind === "entity" && !lookup.honorific) {
    if (registeredIds.has(lookup.id))
      return { action: "alias", targetId: lookup.id, reason: "alias" };
    return {
      action: "accept",
      newId: lookup.id,
      type: codexTypeOf(rosterTypeOf(lookup.id)),
      reason: "accept",
    };
  }
  if (lookup.kind === "entity") return { action: "dismiss", reason: "honorific" };
  if (lookup.kind === "ambiguous") return { action: "dismiss", reason: "ambiguous" };
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
  usagePoll,
  maxIterations = 200,
}) {
  assertAiGate(await api.gate());
  let prepared = await api.prepare({ rescan: true });
  assertEntriesWithinWindow(prepared);
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
        remainingAfterThis: Math.max(
          0,
          Math.ceil(prepared.visibleCount / MAX_CANDIDATES) - 1,
        ),
        note: `b2 i${n + 1}`,
        usagePoll,
      });
    } catch (error) {
      if (!(error instanceof BudgetStop)) throw error;
      stopped = { code: error.code, detail: error.detail };
      break;
    }
    const record = buildRequestRecord(result, prepared, index);
    iterations.push({ ...(({ judgmentMap, ...rest }) => rest)(record), visibleBefore: prepared.visibleCount });
    if (!result.ok) break; // 判定なしでは進められない（失敗は別に数える。再送は sendOne が 1 回だけ行った）
    const window = prepared.candidates.slice(0, MAX_CANDIDATES);
    const decisions = window.map((candidate) => {
      const lookup = lookupRoster(index, candidate.keyHash, [candidate.firstSceneIndex]);
      const d = authorDecision(lookup, registeredIds, rosterTypeOf);
      if (d.action === "accept") registeredIds.add(d.newId);
      decisionCounts[d.action]++;
      if (d.action === "dismiss") bump(dismissReasons, d.reason);
      return { keyHash: candidate.keyHash, ...d };
    });
    const before = prepared.visibleCount;
    const applied = await api.apply(
      decisions.map(({ reason, ...rest }) => rest),
    );
    prepared = applied;
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
    registeredNotInCandidates: registeredNotInCandidates(
      registeredKeyHashes,
      prepared.candidates ?? [],
    ),
    finalVisibleCount: prepared.visibleCount,
  };
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
    if (
      largest === null ||
      row.request.estInputTokens > largest.estInputTokens
    )
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
