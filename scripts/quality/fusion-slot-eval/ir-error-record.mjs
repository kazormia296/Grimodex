// IR 評価の renderer が失敗を記録するときの純関数（node 依存なし。vite 経由で renderer にも載る）。
// 事前登録 §7：記録に本文・題名・抜粋・LLM の応答の本文を書かない。
// 返すのは error の種別・code・伏せた message と、待ちの経過だけ。

/** 原因の鎖で記録する cause の段数（error 自身に加えて）。 */
export const MAX_CAUSE_DEPTH = 3;
const MESSAGE_MAX = 240;
const NAME_MAX = 64;
const CODE_PATTERN = /^[A-Z0-9_]{3,64}$/u;
// drizzle の "Failed query: <sql>\nparams: <値>" は params に本文を含みうる（英語の作品は ASCII のまま残る）。
const PARAMS_PATTERN = /\bparams\s*:/iu;

// drizzle の "Failed query: <sql>" の SQL は code が組み立てた文（値は params に分かれる）。
// 識別子の引用符を残すため、この印より後ろは引用部の伏せ対象にしない。
const SQL_MARKER = /Failed query:/iu;
// 引用された断片（V8 の JSON.parse の `"Once upon ..." is not valid JSON`、serde の
// `invalid type: string "..."` など）は、英語の作品では本文が ASCII のまま残る。
const DOUBLE_QUOTED = /"[^"]*(?:"|$)/gu;
const SINGLE_QUOTED = /(?<![A-Za-z0-9])'(?:[^']*'(?![A-Za-z0-9])|[^']*$)/gu;

function maskQuoted(text) {
  return text.replace(DOUBLE_QUOTED, '"<q>"').replace(SINGLE_QUOTED, "'<q>'");
}

/**
 * 診断用の message：params 以降を切り捨て、引用部（"..."、'...'）を "<q>" に伏せ
 * （"Failed query:" の SQL は除く）、ASCII 以外を "?"、識別子らしい長い英数字列を
 * "<long>"、240 字で切る。原因の分類にだけ使う。
 * @param {string} message
 * @returns {string}
 */
export function sanitizeMessage(message) {
  const text = String(message);
  const cut = text.search(PARAMS_PATTERN);
  const head = (cut >= 0 ? text.slice(0, cut) : text).trimEnd();
  const sql = head.search(SQL_MARKER);
  const masked =
    sql >= 0
      ? maskQuoted(head.slice(0, sql)) + head.slice(sql)
      : maskQuoted(head);
  return masked
    .replace(/[^\x20-\x7e]+/gu, "?")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "<long>")
    .slice(0, MESSAGE_MAX);
}

/** getter が投げても記録を止めない。 */
function safeGet(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function safeText(value) {
  try {
    return String(value);
  } catch {
    return "";
  }
}

function sanitizeName(value) {
  if (typeof value !== "string" || value === "") return null;
  return sanitizeMessage(value).slice(0, NAME_MAX);
}

/**
 * error 1 つの記録：name、constructor の名前、code（/^[A-Z0-9_]{3,64}$/ の文字列だけ）、message。
 * @param {unknown} error
 */
export function describeError(error) {
  const isObject =
    (typeof error === "object" && error !== null) ||
    typeof error === "function";
  if (!isObject) {
    return {
      name: null,
      constructorName: null,
      code: null,
      message: sanitizeMessage(safeText(error)),
    };
  }
  const code = safeGet(() => error.code);
  const message = safeGet(() => error.message);
  return {
    name: sanitizeName(safeGet(() => error.name)),
    constructorName: sanitizeName(safeGet(() => error.constructor?.name)),
    code: typeof code === "string" && CODE_PATTERN.test(code) ? code : null,
    message: sanitizeMessage(
      typeof message === "string" ? message : safeText(error),
    ),
  };
}

/**
 * error と cause の鎖（cause は最大 MAX_CAUSE_DEPTH 段）。循環は止める。
 * @param {unknown} error
 * @returns {{ chain: ReturnType<typeof describeError>[], truncated: boolean }}
 */
export function describeErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  let truncated = false;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    chain.push({ depth, ...describeError(current) });
    const isObject = typeof current === "object" && current !== null;
    if (isObject) seen.add(current);
    const next = isObject ? safeGet(() => current.cause) : undefined;
    if (next === undefined || next === null) break;
    if (typeof next === "object" && seen.has(next)) break;
    if (depth === MAX_CAUSE_DEPTH) {
      truncated = true;
      break;
    }
    current = next;
  }
  return { chain, truncated };
}

/**
 * 接続が空くまでの上限付きの待ち。probe は軽い読み（Ready のときは即座に返る）。
 * 「連続 requiredConsecutive 回が fastMs 以内に成功」を Ready とする（一度の成功は、
 * 次の 250 ms 周期の build が握り直す前の隙間かもしれない）。
 * 時計・sleep は差し替えられる（試験用）。probe は同時に 1 つだけ飛ばす。
 *
 * @param {{
 *   probe: () => Promise<unknown>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   describeFailure?: (error: unknown) => string,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   fastMs?: number,
 *   requiredConsecutive?: number,
 * }} input
 */
export async function waitUntilConnectionReady(input) {
  const now = input.now ?? (() => performance.now());
  const sleep =
    input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const describeFailure = input.describeFailure ?? (() => "probe-failed");
  const timeoutMs = input.timeoutMs ?? 120_000;
  const pollMs = input.pollMs ?? 1000;
  const fastMs = input.fastMs ?? 1000;
  const required = input.requiredConsecutive ?? 2;
  const started = now();
  let polls = 0;
  let consecutive = 0;
  let lastState = null;
  let inFlight = null;
  let probeStarted = 0;
  const finish = (ready) => ({
    ready,
    timedOut: !ready,
    waitedMs: now() - started,
    polls,
    lastState,
  });
  for (;;) {
    if (now() - started >= timeoutMs) return finish(false);
    if (!inFlight) {
      polls++;
      probeStarted = now();
      inFlight = Promise.resolve()
        .then(() => input.probe())
        .then(
          () => ({ ok: true, latencyMs: now() - probeStarted }),
          (error) => ({
            ok: false,
            latencyMs: now() - probeStarted,
            failure: describeFailure(error),
          }),
        );
    }
    const outcome = await Promise.race([
      inFlight,
      sleep(pollMs).then(() => null),
    ]);
    if (outcome === null) {
      // probe が pollMs を超えて待っている：接続を握られている。
      consecutive = 0;
      lastState = { phase: "busy", pendingMs: now() - probeStarted };
      continue;
    }
    inFlight = null;
    if (outcome.ok && outcome.latencyMs <= fastMs) {
      consecutive++;
      lastState = { phase: "idle", latencyMs: outcome.latencyMs };
      if (consecutive >= required) return finish(true);
    } else {
      consecutive = 0;
      lastState = outcome.ok
        ? { phase: "slow", latencyMs: outcome.latencyMs }
        : {
            phase: "probe-failed",
            latencyMs: outcome.latencyMs,
            failure: outcome.failure,
          };
    }
    await sleep(pollMs);
  }
}
