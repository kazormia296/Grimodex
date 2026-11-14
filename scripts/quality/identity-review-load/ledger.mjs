// 同定の review の負荷の測定 B：費用の台帳と停止の gate（事前登録 §9）。
// 手本：未 merge の枝 claude/ir-chat-pilot-gold の scripts/quality/ir-chat-pilot/gold/ledger.mjs
// （commit aa67168f。`git show aa67168f:scripts/quality/ir-chat-pilot/gold/ledger.mjs` で読む。
// 枝は取り込まない。lock・JSONL 追記の形だけを参考に、新規に書いた）。
//
// - 単価は src/features/chat/modelPricing.ts の PRICING 表から読む（複製しない）。
// - 台帳は 1 行 1 要求の JSONL（0600）。本文・key は載せない（件数・token・USD・理由コードだけ）。
// - 乾いた実行（dry-run）は台帳に書かない。見積りだけを返す。
// - 上限・停止線は凍結の値で、緩めない（§9）。
// - 停止（STOP 行）は台帳に追記し、次に createGate が読み込んだときも停止のまま始める（解除は人が行う）。
// - ai_usage の token の 2 倍超の線は、試走の実測の比（実測 token ÷ 見積り）で較正した値に対する 2 倍。
//   試走の行が無ければ B1／B2 は始めない（preflight が拒否する）。
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import process from "node:process";
import path from "node:path";
import { Buffer } from "node:buffer";

/** 手本の commit（記録用）。 */
export const LEDGER_SOURCE_COMMIT = "aa67168f";

/** §9・§15：全体 $15、段の上限（試走 $1／B1 $8／B2 $4／予備 $2）。 */
export const TOTAL_CAP_USD = 15;
export const STAGE_CAPS_USD = Object.freeze({
  trial: 1,
  B1: 8,
  B2: 4,
  reserve: 2,
});
/** 累計がこの割合に達したら、残りの外挿が上限を超えるか調べる。 */
export const EXTRAPOLATION_THRESHOLD = 0.8;
/** 停止線の値（§9）。 */
export const STOP_LINES = Object.freeze({
  rateLimitStreak: 2,
  failureStreak: 5,
  earlyWindow: 5,
  earlyFailures: 3,
  tokenOverFactor: 2,
});
/** 試走の実測で較正する段（比の元になる段）と、較正が要る段。 */
export const CALIBRATION_STAGE = "trial";
export const CALIBRATED_STAGES = Object.freeze(["B1", "B2"]);

const PRICING_SOURCE = path.resolve(
  import.meta.dirname,
  "../../../src/features/chat/modelPricing.ts",
);

/**
 * modelPricing.ts の PRICING 表から、モデルの単価（USD / 100 万 token）を読む。
 * 表のキーは小文字・provider prefix なし。未定義なら例外（推測の単価で送らない）。
 */
export function readModelPricing(modelId, source = PRICING_SOURCE) {
  const text = readFileSync(source, "utf8");
  const start = text.indexOf("const PRICING");
  if (start < 0) throw new Error("[ledger] PRICING_TABLE_NOT_FOUND");
  const key = modelId.toLowerCase();
  const pattern = new RegExp(
    `"${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"\\s*:\\s*\\{\\s*inputPerMillion:\\s*([0-9.]+)\\s*,\\s*outputPerMillion:\\s*([0-9.]+)\\s*\\}`,
    "u",
  );
  const match = pattern.exec(text.slice(start));
  if (!match) throw new Error("[ledger] MODEL_PRICE_UNDEFINED");
  return {
    inputPerMillion: Number(match[1]),
    outputPerMillion: Number(match[2]),
  };
}

/** usage（input_tokens・output_tokens）から USD。cache の項は judgeCandidates が使わないので持たない。 */
export function usdOf(pricing, usage) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return (
    (input * pricing.inputPerMillion + output * pricing.outputPerMillion) / 1e6
  );
}

/**
 * 要求の本文の文字数から token を見積もる。tokenizer を持たないので暫定の比で見積もる
 * （ASCII 0.3 token／字、ASCII 以外 1.0 token／字。保守値とは呼ばない。ID を含む試走の実測で較正するまで暫定）。
 * 見積りは費用の上限の確認と、ai_usage の実測との比較（2 倍超で停止）に使う。
 */
export function estimateInputTokens({ promptChars, promptNonAsciiChars }) {
  const ascii = Math.max(0, promptChars - promptNonAsciiChars);
  return Math.ceil(ascii * 0.3 + promptNonAsciiChars * 1.0);
}

/** 出力の見積り（§9：約 4〜6k token／50 候補）。候補 1 件あたりの token で比例させ、下限を置く。 */
export function estimateOutputTokens(
  judgedSlots,
  { perCandidate = 120, floor = 800 } = {},
) {
  return Math.max(floor, Math.ceil(judgedSlots * perCandidate));
}

export class BudgetStop extends Error {
  constructor(code, detail = {}) {
    super(`[budget] ${code}`);
    this.name = "BudgetStop";
    this.code = code;
    this.detail = detail;
  }
}

const sleepSync = (ms) =>
  globalThis.Atomics.wait(
    new Int32Array(new globalThis.SharedArrayBuffer(4)),
    0,
    0,
    ms,
  );

function withLock(lockFile, fn) {
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      try {
        writeSync(fd, Buffer.from(String(process.pid)));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > 60_000)
          unlinkSync(lockFile);
      } catch {
        // 競合して消えた。
      }
      if (Date.now() - started > 120_000)
        throw new Error("[ledger] LOCK_TIMEOUT", { cause: error });
      sleepSync(20 + Math.floor(Math.random() * 40));
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {
      // 既に無い。
    }
  }
}

/** STOP 行の detail は数値・ASCII の識別子だけ残す（本文・表記を載せない）。 */
function safeDetail(detail) {
  const out = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (typeof value === "number" || typeof value === "boolean")
      out[key] = value;
    else if (typeof value === "string")
      out[key] = value.replace(/[^A-Za-z0-9_.:/+=\- ]/gu, "_").slice(0, 80);
  }
  return out;
}

/**
 * 台帳と停止の gate。
 * - preflight（送信の前）：見積りと累計を検査し、超えるなら BudgetStop。dry-run は preflight だけ（記録しない）。
 * - afterRequest（送信の後）：結果を台帳に追記し、停止線に当たれば stop を立てる。
 * 呼び出し側は、BudgetStop を捕まえたら以後の要求を送らず、止めた時点で報告する（超過分は後で足さない）。
 */
export function createGate({
  file,
  model,
  pricing = readModelPricing(model),
  totalCapUsd = TOTAL_CAP_USD,
  stageCapsUsd = STAGE_CAPS_USD,
  requireTrial = true,
  now = () => new Date().toISOString(),
}) {
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) {
      appendFileSync(file, "", { mode: 0o600 });
    }
    chmodSync(file, 0o600);
  }
  const lockFile = file ? `${file}.lock` : null;
  const state = {
    total: 0,
    byStage: {},
    trial: null, // 試走の実測の比（loadFromFile）
    requests: 0, // 結果を受けた要求（成功・失敗とも）
    billedRequests: 0, // token が記録された要求
    consecutiveFailures: 0,
    consecutiveRateLimits: 0,
    window: [], // 最初の earlyWindow 件の成否
    stopped: null,
  };
  // 台帳が単一の真実。累計・段の費用・試走の較正・STOP は、読み込みのたびにファイルから取り直す
  // （並列の launcher の累計も見える。連続失敗・窓の成否は process 内）。
  function loadFromFile() {
    if (!file || !existsSync(file)) return;
    let total = 0;
    let billed = 0;
    const byStage = {};
    let stopped = null;
    let trialN = 0;
    let maxIn = 0;
    let maxOut = 0;
    let maxInTokens = 0;
    let maxOutTokens = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.type === "STOP") {
        stopped ??= { code: row.code, detail: row.detail ?? {} };
        continue;
      }
      total += row.usd;
      byStage[row.stage] = (byStage[row.stage] ?? 0) + row.usd;
      if (row.billed) billed++;
      if (
        row.stage === CALIBRATION_STAGE &&
        row.billed &&
        row.est_input_tokens > 0 &&
        row.est_output_tokens > 0
      ) {
        trialN++;
        maxIn = Math.max(maxIn, row.input_tokens / row.est_input_tokens);
        maxOut = Math.max(maxOut, row.output_tokens / row.est_output_tokens);
        maxInTokens = Math.max(maxInTokens, row.input_tokens);
        maxOutTokens = Math.max(maxOutTokens, row.output_tokens);
      }
    }
    state.total = total;
    state.byStage = byStage;
    state.billedRequests = billed;
    state.trial =
      trialN > 0
        ? { n: trialN, maxIn, maxOut, maxInTokens, maxOutTokens }
        : null;
    if (stopped && !state.stopped) state.stopped = stopped;
  }
  loadFromFile();

  const persistStop = (code, detail) => {
    if (!file) return;
    withLock(lockFile, () =>
      appendFileSync(
        file,
        `${JSON.stringify({ type: "STOP", ts: now(), code, detail: safeDetail(detail) })}\n`,
        { mode: 0o600 },
      ),
    );
  };
  const stop = (code, detail) => {
    if (!state.stopped) {
      state.stopped = { code, detail };
      persistStop(code, detail);
    }
    throw new BudgetStop(code, detail);
  };
  // 送らないだけ（以後の要求は止めない）。見積りが上限を超える要求の拒否に使う。
  const refuse = (code, detail) => {
    throw new BudgetStop(code, detail);
  };

  function extrapolationExceeds(remainingRequests) {
    if (state.total < EXTRAPOLATION_THRESHOLD * totalCapUsd) return false;
    if (state.billedRequests === 0) return false;
    const average = state.total / state.billedRequests;
    return state.total + average * remainingRequests > totalCapUsd;
  }

  return {
    pricing,
    state,
    /**
     * 外から止める（送信の後の異常・cell の不採用など）。STOP 行を台帳に追記し、以後の preflight は
     * 送らずに BudgetStop を投げる。投げずに返す。解除は人が STOP 行を消す。
     */
    halt(code, detail = {}) {
      if (!state.stopped) {
        state.stopped = { code, detail };
        persistStop(code, detail);
      }
      return state.stopped;
    },
    /** 見積り USD。 */
    estimateUsd(estInputTokens, estOutputTokens) {
      return usdOf(pricing, {
        input_tokens: estInputTokens,
        output_tokens: estOutputTokens,
      });
    },
    /**
     * 送信の前の検査。remainingAfterThis は、この要求の後に予定している要求の数（外挿に使う）。
     * 超えるなら送らずに BudgetStop。
     */
    preflight({
      stage,
      estInputTokens,
      estOutputTokens,
      remainingAfterThis = 0,
    }) {
      loadFromFile();
      if (state.stopped)
        throw new BudgetStop(state.stopped.code, state.stopped.detail);
      if (!(stage in stageCapsUsd)) refuse("UNKNOWN_STAGE", { stage });
      if (requireTrial && CALIBRATED_STAGES.includes(stage) && !state.trial)
        refuse("TRIAL_REQUIRED", { stage });
      const estimate = usdOf(pricing, {
        input_tokens: estInputTokens,
        output_tokens: estOutputTokens,
      });
      if (state.total + estimate > totalCapUsd)
        refuse("TOTAL_CAP_WOULD_EXCEED", {
          total: state.total,
          estimate,
          cap: totalCapUsd,
        });
      if ((state.byStage[stage] ?? 0) + estimate > stageCapsUsd[stage])
        refuse("STAGE_CAP_WOULD_EXCEED", {
          stage,
          stageTotal: state.byStage[stage] ?? 0,
          estimate,
          cap: stageCapsUsd[stage],
        });
      if (extrapolationExceeds(remainingAfterThis + 1))
        stop("EXTRAPOLATION_EXCEEDS_CAP", {
          total: state.total,
          remaining: remainingAfterThis + 1,
        });
      return estimate;
    },
    /**
     * 送信の後。outcome：{ ok, failureKind?, httpStatus?, usage?: {input_tokens, output_tokens} }。
     * 台帳に 1 行追記し、停止線に当たれば BudgetStop（その要求の記録は済んでいる）。
     */
    afterRequest({
      stage,
      outcome,
      estInputTokens,
      estOutputTokens,
      remainingAfterThis = 0,
      note = "",
    }) {
      const usage = outcome.usage ?? null;
      const billed =
        usage !== null &&
        Number.isFinite(usage.input_tokens) &&
        Number.isFinite(usage.output_tokens) &&
        (usage.input_tokens > 0 || usage.output_tokens > 0);
      const usd = billed ? usdOf(pricing, usage) : 0;
      const row = {
        ts: now(),
        stage,
        model,
        ok: Boolean(outcome.ok),
        failure_kind: outcome.ok ? null : (outcome.failureKind ?? "other"),
        http_status: outcome.httpStatus ?? null,
        billed,
        input_tokens: usage?.input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
        est_input_tokens: estInputTokens,
        est_output_tokens: estOutputTokens,
        usd: Number(usd.toFixed(6)),
        note: String(note)
          .replace(/[^A-Za-z0-9_.:/+=\- ]/gu, "_")
          .slice(0, 80),
      };
      const append = () =>
        appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      if (file) {
        withLock(lockFile, append);
        loadFromFile(); // 他の launcher の行も含めた累計に取り直す
      } else {
        state.total += row.usd;
        state.byStage[stage] = (state.byStage[stage] ?? 0) + row.usd;
        if (billed) state.billedRequests++;
      }
      state.requests++;
      if (state.window.length < STOP_LINES.earlyWindow)
        state.window.push(Boolean(outcome.ok));
      if (outcome.ok) {
        state.consecutiveFailures = 0;
        state.consecutiveRateLimits = 0;
      } else {
        state.consecutiveFailures++;
        state.consecutiveRateLimits =
          outcome.failureKind === "rate-limit"
            ? state.consecutiveRateLimits + 1
            : 0;
      }
      // 停止線（先に当たったものを理由にする）。
      if (outcome.failureKind === "auth")
        stop("AUTH_401_403", { httpStatus: outcome.httpStatus ?? null });
      if (outcome.failureKind === "wrong-surface")
        stop("AI_SURFACE_UNEXPECTED", {});
      if (outcome.failureKind === "other")
        stop("UNCLASSIFIED_FAILURE", {
          httpStatus: outcome.httpStatus ?? null,
        });
      if (
        outcome.responded === true &&
        ["no-usage-row", "tokens-null", "tokens-zero"].includes(
          outcome.failureKind,
        )
      )
        stop("USAGE_NOT_RECORDED", { kind: outcome.failureKind });
      if (state.consecutiveRateLimits >= STOP_LINES.rateLimitStreak)
        stop("RATE_LIMIT_STREAK", { streak: state.consecutiveRateLimits });
      if (state.consecutiveFailures >= STOP_LINES.failureStreak)
        stop("FAILURE_STREAK", { streak: state.consecutiveFailures });
      if (
        state.window.length === STOP_LINES.earlyWindow &&
        state.window.filter((ok) => !ok).length >= STOP_LINES.earlyFailures &&
        state.requests === STOP_LINES.earlyWindow
      )
        stop("EARLY_FAILURES", {
          failures: state.window.filter((ok) => !ok).length,
        });
      if (billed) {
        // §9：試走の実測値の 2 倍超。(1) 試走の実測の比で較正した見積りの 2 倍（要求が試走より小さいときに
        // 効く）と、(2) 試走の実測 token そのものの 2 倍（試走より大きい要求で §9 より緩くならない）の
        // 先に当たった方で止める。試走自身は見積りの 2 倍。
        const calibrated =
          stage !== CALIBRATION_STAGE && state.trial
            ? state.trial
            : {
                maxIn: 1,
                maxOut: 1,
                maxInTokens: Infinity,
                maxOutTokens: Infinity,
              };
        const inputLimit = Math.min(
          STOP_LINES.tokenOverFactor * estInputTokens * calibrated.maxIn,
          STOP_LINES.tokenOverFactor * calibrated.maxInTokens,
        );
        const outputLimit = Math.min(
          STOP_LINES.tokenOverFactor * estOutputTokens * calibrated.maxOut,
          STOP_LINES.tokenOverFactor * calibrated.maxOutTokens,
        );
        if (
          usage.input_tokens > inputLimit ||
          usage.output_tokens > outputLimit
        )
          stop("TOKENS_OVER_TRIAL_MEASURED", {
            inputRatio: Number((usage.input_tokens / inputLimit).toFixed(2)),
            outputRatio: Number((usage.output_tokens / outputLimit).toFixed(2)),
          });
      }
      if (state.total >= totalCapUsd)
        stop("TOTAL_CAP_REACHED", { total: state.total });
      if ((state.byStage[stage] ?? 0) >= stageCapsUsd[stage])
        stop("STAGE_CAP_REACHED", {
          stage,
          stageTotal: state.byStage[stage],
        });
      if (extrapolationExceeds(remainingAfterThis))
        stop("EXTRAPOLATION_EXCEEDS_CAP", {
          total: state.total,
          remaining: remainingAfterThis,
        });
      return row;
    },
  };
}

/**
 * 乾いた実行の見積り：要求の一覧（stage・estInputTokens・estOutputTokens）を、上限と照らす。
 * 台帳には書かない。返り値は件数・token・USD と、段ごとの上限との比較。
 */
export function planCost(
  requests,
  { pricing, totalCapUsd = TOTAL_CAP_USD, stageCapsUsd = STAGE_CAPS_USD },
) {
  const byStage = {};
  let total = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const request of requests) {
    const usd = usdOf(pricing, {
      input_tokens: request.estInputTokens,
      output_tokens: request.estOutputTokens,
    });
    total += usd;
    inputTokens += request.estInputTokens;
    outputTokens += request.estOutputTokens;
    const slot = (byStage[request.stage] ??= {
      requests: 0,
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    slot.requests++;
    slot.usd += usd;
    slot.inputTokens += request.estInputTokens;
    slot.outputTokens += request.estOutputTokens;
  }
  const stageCheck = {};
  for (const [stage, slot] of Object.entries(byStage)) {
    stageCheck[stage] = {
      ...slot,
      usd: Number(slot.usd.toFixed(4)),
      capUsd: stageCapsUsd[stage] ?? null,
      withinCap:
        stageCapsUsd[stage] !== undefined && slot.usd <= stageCapsUsd[stage],
    };
  }
  return {
    requests: requests.length,
    inputTokens,
    outputTokens,
    usd: Number(total.toFixed(4)),
    capUsd: totalCapUsd,
    withinCap: total <= totalCapUsd,
    byStage: stageCheck,
  };
}
