// 同定の review の負荷の測定 B：費用の台帳と停止の gate（事前登録 §9）。
// 手本：未 merge の枝 claude/ir-chat-pilot-gold の scripts/quality/ir-chat-pilot/gold/ledger.mjs
// （commit aa67168f。`git show aa67168f:scripts/quality/ir-chat-pilot/gold/ledger.mjs` で読む。
// 枝は取り込まない。lock・JSONL 追記の形だけを参考に、新規に書いた）。
//
// - 単価は src/features/chat/modelPricing.ts の PRICING 表から読む（複製しない）。
// - 台帳は 1 行 1 要求の JSONL（0600）。本文・key は載せない（件数・token・USD・理由コードだけ）。
// - 乾いた実行（dry-run）は台帳を使わない（preflight も呼ばない。planCost の見積りだけ）。
// - 送る前に preflight が「予約」（別 file `<台帳>.reservations` の RESERVE 行。台帳は 1 行 1 要求のまま）を lock の中で原子的に書き、送信の後の afterRequest が実費の行
//   （reservation_id 付き）で精算する（release は送らなかったときの取り消し）。予約は未精算の間、累計と段の費用に足して上限と
//   比べる（並行の launcher の送信が重なっても上限を超えない・最後の 1 回の超過を抑える。F3a の m3）。送信の後に精算されなかった
//   予約（process が落ちた）は残り、累計に数える（届いたか分からない送信を 0 円と見ない）。
// - 届いたか分からない失敗（network・timeout・judge の例外・usage の行が無い応答）は、usage が無ければ最悪値
//   （maxPlausibleUsd＝入力は TOKENS_OVER の線、出力は native の既定の max_tokens〔32,000。thinking の token を含む〕の費用）で
//   課金する（charge: "estimate"）。実費を下回らないように。予約（hold）も同じ最悪値（F5 の M-a。judgeCandidates は
//   requestMaxOutputTokens を渡さないので、claude-sonnet-5-5 の出力は 32,000 まで課金されうる）。TOKENS_OVER の線（tokenLimits）は変えない。
// - 上限・停止線は凍結の値で、緩めない（§9）。
// - 停止（STOP 行）は台帳に追記し、次に createGate が読み込んだときも停止のまま始める（解除は人が行う）。
// - ai_usage の token の 2 倍超の線は、試走の実測の比（実測 token ÷ 見積り）で較正した値に対する 2 倍。
//   試走の行が無ければ B1／B2 は始めない（preflight が拒否する）。
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
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
/**
 * 要求が相手に届いたか（課金されたか）分からない失敗の種類。usage の行が読めなければ、最大の見積りで課金する
 * （afterRequest。応答が返ったのに usage を読めなかった場合〔outcome.responded〕も同じ）。
 * 429・5xx・認証・接続前（network-unsent）・送らなかった・4xx の応答は含めない（応答が返らなかったと言える。課金は 0）。
 */
export const MAY_HAVE_BEEN_BILLED_FAILURE_KINDS = Object.freeze([
  "network",
  "ipc-timeout",
  "watchdog-timeout",
  "judge-error",
  "no-valid-result",
  "empty-map",
  "other",
]);
/**
 * judgeCandidates が出力の上限（requestMaxOutputTokens）を渡さないとき、native が request に書く max_tokens（F5 の M-a）。
 * claude-sonnet-5-5 は thinking を常に有効にする世代で、thinking の token も出力として課金されるので、32,000 まで使われうる
 * （grimodex-ai の effective_request_max_output_tokens。試験が製品の source とこの値の一致を確かめる）。
 * 予約・届いたか分からない失敗の課金は、出力をこの値として計算する。
 */
export const NATIVE_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
/** lock が残っていて、これより古いなら、奪わずに止める（人が確かめて消す。F5 の m-e）。 */
export const LOCK_STALE_MS = 60_000;
export const LOCK_WAIT_MS = 120_000;

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
    // 最悪値の予約が理由の拒否は、止まった理由（hold が見積りより大きく、出力を worstCaseOutputTokens とした最悪値）が
    // message で分かるようにする（F5 の M-a）。detail は数値だけ（結果の出力検査に、原稿の英単語に当たる語を足さない）。
    super(
      detail.worstCaseOutputTokens !== undefined
        ? `[budget] ${code} hold=${Number(detail.hold).toFixed(4)} estimate=${Number(detail.estimate).toFixed(4)} worstCaseOutputTokens=${detail.worstCaseOutputTokens}`
        : `[budget] ${code}`,
    );
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

/**
 * lock（`wx` で作る file）の中で fn を実行する。lock には自分の token を書き、解放は自分の token のときだけ消す。
 * 古い lock（LOCK_STALE_MS 超）は奪わずに止める（stat→unlink の間に他の process が作り直した lock を消す競合を作らない。
 * 臨界区間は数 ms なので、古い lock は落ちた process の残り。人が確かめて消す。F5 の m-e）。待つ上限は LOCK_WAIT_MS。
 * 再入できない：fn の中で withLock を呼ばない（lock の中で読む関数と、lock を取って読む関数を分ける）。
 */
export function withLock(
  lockFile,
  fn,
  { staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS } = {},
) {
  const started = Date.now();
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      try {
        writeSync(fd, Buffer.from(token));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age;
      try {
        age = Date.now() - statSync(lockFile).mtimeMs;
      } catch {
        // 競合して消えた。取り直す。
        continue;
      }
      if (age > staleMs)
        throw new Error("[precheck] LEDGER_LOCK_STALE", { cause: error });
      if (Date.now() - started > waitMs)
        throw new Error("[ledger] LOCK_TIMEOUT", { cause: error });
      sleepSync(20 + Math.floor(Math.random() * 40));
    }
  }
  try {
    return fn();
  } finally {
    try {
      // 自分の lock のときだけ消す（他の process の lock を消さない）。
      if (readFileSync(lockFile, "utf8") === token) unlinkSync(lockFile);
    } catch {
      // 既に無い。
    }
  }
}

/** dir が自分の所有の 0700（symlink でない）であること。満たさなければ止める（chmod で直さない。F5 の m-j）。 */
export function assertPrivateDirectory(dir) {
  let info;
  try {
    info = lstatSync(dir);
  } catch {
    throw new Error(
      "[precheck] LEDGER_DIR_NOT_PRIVATE the ledger directory cannot be read",
    );
  }
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "[precheck] LEDGER_DIR_NOT_PRIVATE the ledger directory must be an own 0700 directory",
    );
}

/** file が（あれば）自分の所有の通常 file で group・other の権限が無いこと。chmod で直さない。 */
function assertPrivateFileIfExists(file) {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    return;
  }
  if (
    !info.isFile() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "[precheck] LEDGER_FILE_NOT_PRIVATE a reservation file must be an own regular file with mode 0600",
    );
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
  worstCaseOutputTokens = NATIVE_DEFAULT_MAX_OUTPUT_TOKENS,
  lockOptions = {},
  now = () => new Date().toISOString(),
}) {
  const lockedRun = (fn) => withLock(lockFile, fn, lockOptions);
  const lockFile = file ? `${file}.lock` : null;
  const reservationFile = file ? `${file}.reservations` : null;
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // 既存の dir は chmod しない：自分の所有の 0700 でなければ止める（F5 の m-j）。
    assertPrivateDirectory(path.dirname(file));
    assertPrivateFileIfExists(reservationFile);
    if (!existsSync(file)) {
      appendFileSync(file, "", { mode: 0o600 });
    }
    chmodSync(file, 0o600);
  }
  const state = {
    total: 0,
    byStage: {},
    reserved: 0, // 未精算の予約の合計 USD（loadFromFile。file が無いときは process 内）
    unsettled: [], // 未精算の予約の一覧（id・stage・usd。loadFromFile。落ちた process の残りを前検査が見つける）
    reservedByStage: {},
    pendingReservation: null, // この gate が今持つ予約（preflight で取り、afterRequest／release で閉じる）
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
  // loadFromFile は lock の中で呼ぶ（追記の途中の行を読まない。lock の外から読むときは loadWithLock。F5 の m-e）。
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
    const reservations = new Map();
    const settled = new Set();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.type === "STOP") {
        stopped ??= { code: row.code, detail: row.detail ?? {} };
        continue;
      }
      if (row.reservation_id) settled.add(row.reservation_id);
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
    // 予約は別の file（1 行 1 要求の台帳に混ぜない）。RESERVE と RELEASE の行。精算は台帳の行の reservation_id。
    if (existsSync(reservationFile))
      for (const line of readFileSync(reservationFile, "utf8").split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (row.type === "RESERVE")
          reservations.set(row.id, { usd: row.usd, stage: row.stage });
        else if (row.type === "RELEASE") settled.add(row.id);
      }
    state.total = total;
    state.byStage = byStage;
    state.reserved = 0;
    state.reservedByStage = {};
    state.unsettled = [];
    for (const [id, r] of reservations) {
      if (settled.has(id)) continue;
      state.unsettled.push({ id, stage: r.stage, usd: r.usd });
      state.reserved += r.usd;
      state.reservedByStage[r.stage] =
        (state.reservedByStage[r.stage] ?? 0) + r.usd;
    }
    state.billedRequests = billed;
    state.trial =
      trialN > 0
        ? { n: trialN, maxIn, maxOut, maxInTokens, maxOutTokens }
        : null;
    if (stopped && !state.stopped) state.stopped = stopped;
  }
  /** lock を取って読む（lock の外から呼ぶ。lock の中では loadFromFile を呼ぶ）。 */
  const loadWithLock = () => {
    if (file) lockedRun(loadFromFile);
  };
  loadWithLock();

  const persistStop = (code, detail) => {
    if (!file) return;
    lockedRun(() =>
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

  /**
   * 1 要求の token の上限の線（§9：試走の実測の 2 倍超で停止する線。afterRequest の TOKENS_OVER と同じ式）。
   * 試走（較正の元の段）は見積りの 2 倍。較正が要る段は、試走の実測の比で較正した見積りの 2 倍と、試走の実測 token の
   * 2 倍の小さい方。
   */
  function tokenLimits(stage, estInputTokens, estOutputTokens) {
    const calibrated =
      stage !== CALIBRATION_STAGE && state.trial
        ? state.trial
        : {
            maxIn: 1,
            maxOut: 1,
            maxInTokens: Infinity,
            maxOutTokens: Infinity,
          };
    return {
      inputLimit: Math.min(
        STOP_LINES.tokenOverFactor * estInputTokens * calibrated.maxIn,
        STOP_LINES.tokenOverFactor * calibrated.maxInTokens,
      ),
      // 出力の線は、試走の比・実測の最大値では補正せず、見積り（候補 1 件 120 token。下限 800）の 2 倍にする。
      // 作者の決定（2026-11-23 22:35。DR-ILM-49）：測定 B の最初の 1 要求（g-ja-2 の L0）が、試走の最大値から作る出力の線
      // （2,397 token）を約 3％ 超えて止まった。試走は L2 の 2 作品だけで、L2 は候補 1 件あたり約 55 token、L0 は約 113 token。
      // 見積りの式は L0 では合っている（実測は見積りの 0.94 倍）。閾値の緩和（現在の約 2.2 倍）で、入力の線・試走の段・最悪値の予約
      // （出力 32,000）は変えない。
      outputLimit: STOP_LINES.tokenOverFactor * estOutputTokens,
    };
  }
  /**
   * 1 要求のかかりうる最悪の USD（予約と、届いたか分からない失敗の課金に使う。見積り以上）。入力は停止線（TOKENS_OVER の
   * 線。実際の入力は max_tokens で縛られないので、線を超えた分は送信の後に停止線が止める）、出力は停止線と
   * worstCaseOutputTokens（native の既定の max_tokens。thinking を含む）の大きい方（F5 の M-a）。
   * tokenLimits（TOKENS_OVER の判定）は変えない。
   */
  function maxPlausibleUsd(stage, estInputTokens, estOutputTokens) {
    const { inputLimit, outputLimit } = tokenLimits(
      stage,
      estInputTokens,
      estOutputTokens,
    );
    return Math.max(
      usdOf(pricing, {
        input_tokens: estInputTokens,
        output_tokens: estOutputTokens,
      }),
      usdOf(pricing, {
        input_tokens: inputLimit,
        output_tokens: Math.max(outputLimit, worstCaseOutputTokens),
      }),
    );
  }
  /**
   * 送信の前に予約する額：見積りと、試走の実測の比で較正した見積り（較正が要る段だけ。最大の比）と、最悪値
   * （maxPlausibleUsd）の大きい方。見積りより小さくしない（上限の判定を緩めない）。最悪値で予約するので、並行の
   * launcher の予約を足しても、出力が max_tokens まで使われた要求の合計が上限を超えない（F5 の M-a）。
   */
  function reservationUsd(stage, estInputTokens, estOutputTokens) {
    const estimate = usdOf(pricing, {
      input_tokens: estInputTokens,
      output_tokens: estOutputTokens,
    });
    const calibrated =
      CALIBRATED_STAGES.includes(stage) && state.trial
        ? usdOf(pricing, {
            input_tokens: estInputTokens * state.trial.maxIn,
            output_tokens: estOutputTokens * state.trial.maxOut,
          })
        : 0;
    return Math.max(
      estimate,
      calibrated,
      maxPlausibleUsd(stage, estInputTokens, estOutputTokens),
    );
  }
  /** lock の中で呼ぶ。この gate の予約を台帳に書く（file が無ければ process 内だけ）。 */
  function writeReservation(stage, usd) {
    const id = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (file)
      appendFileSync(
        reservationFile,
        `${JSON.stringify({ type: "RESERVE", id, ts: now(), stage, usd: Number(usd.toFixed(6)) })}\n`,
        { mode: 0o600 },
      );
    state.reserved += usd;
    state.reservedByStage[stage] = (state.reservedByStage[stage] ?? 0) + usd;
    state.pendingReservation = { id, usd, stage };
  }
  /** この gate の予約を、送らなかったものとして閉じる（RELEASE 行）。精算（afterRequest）の前の取り消しにだけ使う。 */
  function releasePending() {
    const reservation = state.pendingReservation;
    if (!reservation) return;
    state.pendingReservation = null;
    if (file) {
      lockedRun(() => {
        appendFileSync(
          reservationFile,
          `${JSON.stringify({ type: "RELEASE", id: reservation.id, ts: now() })}\n`,
          { mode: 0o600 },
        );
        loadFromFile();
      });
    } else {
      state.reserved = Math.max(0, state.reserved - reservation.usd);
      state.reservedByStage[reservation.stage] = Math.max(
        0,
        (state.reservedByStage[reservation.stage] ?? 0) - reservation.usd,
      );
    }
  }

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
    /** 1 要求の最悪の USD（予約と、届いたか分からない失敗の課金と同じ式）。 */
    maxPlausibleUsd,
    /**
     * 未精算の予約（gate を作った時点で台帳に残っているもの）。1 件でもあれば、届いたか分からない送信が人に確かめられて
     * いないので、前検査が止める（人が確かめて `<台帳>.reservations` の該当行の後ろに RELEASE 行を足す）。
     * 予約した process が動いているかは見ない（pid は PID namespace や再利用で当てにならない。本測定は 1 launcher の想定で、
     * 別の launcher が送信の途中の間は、その予約があるので前検査が止まる。fail-closed）。
     */
    unsettledReservations() {
      return state.unsettled.map((r) => ({ ...r }));
    },
    /** 見積り USD。 */
    estimateUsd(estInputTokens, estOutputTokens) {
      return usdOf(pricing, {
        input_tokens: estInputTokens,
        output_tokens: estOutputTokens,
      });
    },
    /**
     * 送信の前の検査と予約。remainingAfterThis は、この要求の後に予定している要求の数（外挿に使う）。
     * 超えるなら送らずに BudgetStop。通れば、最大の見積り（maxPlausibleUsd）の予約を lock の中で台帳に書く
     * （並行の launcher の予約も累計に足して上限と比べる）。予約は afterRequest が精算し、送らなかったら release する。
     */
    preflight({
      stage,
      estInputTokens,
      estOutputTokens,
      remainingAfterThis = 0,
    }) {
      // 前の予約が精算されないまま次の preflight に来た（送っていない）：取り消してから取り直す。
      releasePending();
      const decide = () => {
        loadFromFile();
        if (state.stopped) return { kind: "stopped" };
        if (!(stage in stageCapsUsd))
          return { kind: "refuse", code: "UNKNOWN_STAGE", detail: { stage } };
        if (requireTrial && CALIBRATED_STAGES.includes(stage) && !state.trial)
          return { kind: "refuse", code: "TRIAL_REQUIRED", detail: { stage } };
        const estimate = usdOf(pricing, {
          input_tokens: estInputTokens,
          output_tokens: estOutputTokens,
        });
        const hold = reservationUsd(stage, estInputTokens, estOutputTokens);
        // 予約が最悪値（見積りより大きい）で取られていることを、止まった理由として detail と message に残す（F5 の M-a）。
        // 数値だけ（出力 token の仮定）。語の文字列は、結果の出力検査で原稿の英単語に当たりうるので載せない。
        const holdBasis =
          hold > estimate
            ? { worstCaseOutputTokens: worstCaseOutputTokens }
            : {};
        if (state.total + state.reserved + hold > totalCapUsd)
          return {
            kind: "refuse",
            code: "TOTAL_CAP_WOULD_EXCEED",
            detail: {
              total: state.total,
              reserved: state.reserved,
              estimate,
              hold,
              cap: totalCapUsd,
              ...holdBasis,
            },
          };
        const stageSpent =
          (state.byStage[stage] ?? 0) + (state.reservedByStage[stage] ?? 0);
        if (stageSpent + hold > stageCapsUsd[stage])
          return {
            kind: "refuse",
            code: "STAGE_CAP_WOULD_EXCEED",
            detail: {
              stage,
              stageTotal: stageSpent,
              estimate,
              hold,
              cap: stageCapsUsd[stage],
              ...holdBasis,
            },
          };
        if (extrapolationExceeds(remainingAfterThis + 1))
          return {
            kind: "stop",
            code: "EXTRAPOLATION_EXCEEDS_CAP",
            detail: {
              total: state.total,
              remaining: remainingAfterThis + 1,
            },
          };
        writeReservation(stage, hold);
        return { kind: "ok", estimate };
      };
      const decision = file ? lockedRun(decide) : decide();
      if (decision.kind === "stopped")
        throw new BudgetStop(state.stopped.code, state.stopped.detail);
      if (decision.kind === "refuse") refuse(decision.code, decision.detail);
      if (decision.kind === "stop") stop(decision.code, decision.detail);
      return decision.estimate;
    },
    /** 予約を取ったが、要求を送らずに終わった（送る直前の guard が止めた）ときに、予約を取り消す。 */
    release() {
      releasePending();
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
      // 届いたか分からない失敗（usage が読めない）は、最大の見積りで課金する（実費を下回らないように。F3a の M2）。
      // 応答が返らなかったと言える失敗（429・5xx・認証・接続前・送らなかった・4xx の応答）は 0。
      const clientErrorResponse =
        Number.isInteger(outcome.httpStatus) &&
        outcome.httpStatus >= 400 &&
        outcome.httpStatus < 500;
      const chargeEstimate =
        !billed &&
        !outcome.ok &&
        !clientErrorResponse &&
        (outcome.responded === true ||
          MAY_HAVE_BEEN_BILLED_FAILURE_KINDS.includes(outcome.failureKind));
      const usd = billed
        ? usdOf(pricing, usage)
        : chargeEstimate
          ? maxPlausibleUsd(stage, estInputTokens, estOutputTokens)
          : 0;
      const reservation = state.pendingReservation;
      state.pendingReservation = null;
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
        charge: billed ? "measured" : chargeEstimate ? "estimate" : "none",
        reservation_id: reservation?.id ?? null,
        note: String(note)
          .replace(/[^A-Za-z0-9_.:/+=\- ]/gu, "_")
          .slice(0, 80),
      };
      const append = () =>
        appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      if (file) {
        // 追記と読み直しを同じ lock の中で行う（他の launcher の行も含めた累計に取り直す。追記の途中の行を読まない）。
        lockedRun(() => {
          append();
          loadFromFile();
        });
      } else {
        state.total += row.usd;
        state.byStage[stage] = (state.byStage[stage] ?? 0) + row.usd;
        if (billed) state.billedRequests++;
        if (reservation) {
          state.reserved = Math.max(0, state.reserved - reservation.usd);
          state.reservedByStage[reservation.stage] = Math.max(
            0,
            (state.reservedByStage[reservation.stage] ?? 0) - reservation.usd,
          );
        }
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
      // IPC の timeout：native の送信は続きうる（F2 の R7）。同じ body の 2 回目を出さないため、以後の送信を止める。
      if (outcome.failureKind === "ipc-timeout")
        stop("IPC_TIMEOUT_REQUEST_MAY_BE_IN_FLIGHT", {});
      // 届いたか分からない失敗（F3a の M2）：最初の 1 回で止める（連続 5 回を待たない）。課金は最大の見積り。
      if (outcome.failureKind === "network")
        stop("NETWORK_REQUEST_MAY_BE_IN_FLIGHT", {});
      if (outcome.failureKind === "watchdog-timeout")
        stop("WATCHDOG_TIMEOUT_REQUEST_MAY_BE_IN_FLIGHT", {});
      if (outcome.failureKind === "judge-error")
        stop("JUDGE_ERROR_REQUEST_MAY_BE_IN_FLIGHT", {});
      // page 側の送信直前の guard（renderer の bJudge）が送らずに返した失敗。node 側の guard と同じく、次の回へ進めず停止する。
      if (outcome.failureKind === "role-override")
        stop("ROLE_OVERRIDE_NOT_DEFAULT", {});
      if (outcome.failureKind === "hidden-roster")
        stop("ROSTER_HAS_HIDDEN", {});
      if (outcome.failureKind === "other")
        stop("UNCLASSIFIED_FAILURE", {
          httpStatus: outcome.httpStatus ?? null,
        });
      if (
        outcome.responded === true &&
        [
          "no-usage-row",
          "tokens-null",
          "tokens-zero",
          "usage-read-error",
        ].includes(outcome.failureKind)
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
        const { inputLimit, outputLimit } = tokenLimits(
          stage,
          estInputTokens,
          estOutputTokens,
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
