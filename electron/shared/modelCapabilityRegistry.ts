/**
 * モデル能力の registry の「写し」（snapshot）の形式・変換・検証（PR-C1）。
 * 設計の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §3.3（T1・T2・T4・T9）と §4。
 *
 * この module は外部通信を持たない純粋な関数群で、次の 2 か所から同じ版を使う。
 *   - Electron main（実行時の取得・cache・同梱の写しの読み込み）
 *   - CI の Node script（`node scripts/*.mjs` から `.ts` を直接 import する。Node 22.18 以降は
 *     型の除去が既定で有効。install なしで動く）
 *
 * そのため次の制約を守る（試験が確かめる）。
 *   - 他の module を import しない（NodeNext の `.js` 指定と Node の `.ts` 指定が両立しないため、
 *     1 ファイルで完結させる）。Node／Electron／renderer の API も使わない。
 *     使うのは ECMAScript の組み込みと、どの実行環境にもある `TextEncoder` だけ。
 *   - 構文は型の除去で消えるものだけ（enum・namespace・parameter property は使わない）。
 *   - 現在時刻は呼び出し側が `nowMs`／`generatedAt` で渡す（ここでは Date.now() を呼ばない）。
 *
 * 失敗は列挙した code で返し、応答の本文（文字列）を error・findings に含めない。
 * findings に載せる文字列は、検証を通った provider 名と model の key だけ。
 */

// ---------------------------------------------------------------------------
// 写しの形式（§4.2）
// ---------------------------------------------------------------------------

/** 知っている写しの版。これ以外の版は採用せず、同梱の写しへ戻る（§4.5）。 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** 写しの取得元の区分。 */
export const SNAPSHOT_SOURCES = ["models.dev", "grimodex"] as const;
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

/**
 * 写しに入れる provider（`src/features/chat/types.ts` の `AI_PROVIDERS` の部分集合）。
 * 部分集合であることは src 側の試験が確かめる（この module は何も import できない）。
 */
export const SNAPSHOT_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "sakana",
] as const;
export type SnapshotProvider = (typeof SNAPSHOT_PROVIDERS)[number];

/**
 * models.dev の provider id から Grimodex の provider への明示の対応表（Q13）。
 * 表に無い provider は捨てる。確実に同じ API を指すものだけを入れる。
 *   - anthropic／openai／openrouter：models.dev の同名の provider が各社の API そのもの。
 *   - sakana：models.dev の `api` が https://api.sakana.ai/v1 で、Grimodex の接続先と同じ。
 * 入れないもの：`ollama-cloud`（ローカルの Ollama とは別の API）、`lmstudio`、
 * `openai-compatible`・`ai-novelist`・`cli`（対応する provider が無い）。
 */
export const MODELS_DEV_PROVIDER_MAP: ReadonlyMap<string, SnapshotProvider> =
  new Map<string, SnapshotProvider>([
    ["anthropic", "anthropic"],
    ["openai", "openai"],
    ["openrouter", "openrouter"],
    ["sakana", "sakana"],
  ]);

/**
 * 1 つの model の能力。field が無いことは「返さない」で、下の層へ落とす。
 * `false` は明示された非対応だけ（親文書 §3）。
 */
export interface ModelEntry {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly toolCall?: boolean;
  readonly reasoning?: boolean;
}

export interface Snapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  /** ISO 8601 の UTC で秒まで（`YYYY-MM-DDTHH:MM:SSZ`）。 */
  readonly generatedAt: string;
  readonly source: SnapshotSource;
  /** key は `<provider>/<model id>`。prototype を持たない object。 */
  readonly models: Readonly<Record<string, ModelEntry>>;
}

// ---------------------------------------------------------------------------
// policy（閾値）
// ---------------------------------------------------------------------------

/**
 * 閾値の 1 つの定数群。CI と実行時で同じ値を使い、別の値を持たせない（§4.5）。
 *
 * 全ての数値は暫定（2026-11-19）。実測後にユーザー確認する。根拠は 2026-11-19 の models.dev の
 * 実測（全体 6,736,604 byte、324 provider、9,981 model、深さ 11）と、対応 4 provider の
 * chat 系 model（約 450 件）の分布、`modelLimits.ts` の表（context 8,000〜1,050,000、
 * 出力 4,096〜128,000）。
 */
export interface SnapshotPolicy {
  // --- 写し（Grimodex の形式）の規模 ---
  readonly maxSnapshotBytes: number;
  readonly maxSnapshotDepth: number;
  readonly maxModels: number;
  readonly maxKeyLength: number;
  // --- 値の範囲 ---
  readonly minContextWindow: number;
  readonly maxContextWindow: number;
  readonly minMaxOutputTokens: number;
  readonly maxMaxOutputTokens: number;
  // --- 割合・時計 ---
  readonly maxInvalidRatio: number;
  readonly maxFutureSkewMs: number;
  // --- 前回との比較 ---
  readonly minCountRatio: number;
  readonly minProviderBaseline: number;
  readonly contextChangeFactor: number;
  readonly maxFindings: number;
  // --- models.dev の応答（raw）の規模（直接取得と写しで別の上限。T4） ---
  readonly maxRawBytes: number;
  readonly maxRawDepth: number;
  readonly maxRawProviders: number;
  readonly maxRawModelsPerProvider: number;
}

export const SNAPSHOT_POLICY: SnapshotPolicy = Object.freeze({
  /** 写しの本文の上限 byte 数。対応 4 provider・約 460 件で数十 KB。約 20 倍の余裕。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxSnapshotBytes: 1_048_576,
  /** 写しの JSON の入れ子の上限（root → models → 1 件 = 3）。1 段の余裕。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxSnapshotDepth: 4,
  /** 写しの model 件数の上限（対応 provider の entry だけに当てる。全体の規模は byte 数で守る）。現在は対応 4 provider で約 440 件。約 10 倍。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxModels: 5_000,
  /** key（`<provider>/<id>`）の長さの上限。実測の最大は 67 文字（id は 56）。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxKeyLength: 96,
  /** contextWindow の下限。対応 provider の chat 系の最小は 4,095。暫定（2026-11-19）、実測後にユーザー確認。 */
  minContextWindow: 1_024,
  /** contextWindow の上限。対応 provider の最大は 2,000,000（全体では 10,000,000 の実在の model と 99,999,999 の未設定値の記号がある）。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxContextWindow: 10_000_000,
  /** maxOutputTokens の下限。対応 provider の chat 系の最小は 2,048。暫定（2026-11-19）、実測後にユーザー確認。 */
  minMaxOutputTokens: 256,
  /** maxOutputTokens の上限。対応 provider の最大は 2,000,000。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxMaxOutputTokens: 4_000_000,
  /** 不正で捨てた model の割合の上限。超えたらファイル全体を捨てる。分母は対応 provider の chat 系だけ。実測の不正は 0 件。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxInvalidRatio: 0.05,
  /** generatedAt が現在より未来でもよい幅（時計の許容差）。超える写しは拒否する（以後の正当な写しを古いとして締め出す攻撃への備え）。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxFutureSkewMs: 86_400_000,
  /** 件数が前回のこの割合を下回ったらファイル全体を捨てる。親文書 §6 の草稿（前回の半分）をそのまま使う。暫定（2026-11-19）、実測後にユーザー確認。 */
  minCountRatio: 0.5,
  /** provider 単位の急減を見る下限の件数（前回の件数がこれ以上の provider だけ）。小さい provider の揺れを拾わない。暫定（2026-11-19）、実測後にユーザー確認。 */
  minProviderBaseline: 10,
  /** contextWindow がこの倍率以上に増減した model を findings に出す（捨てはしない）。暫定（2026-11-19）、実測後にユーザー確認。 */
  contextChangeFactor: 4,
  /** findings の最大件数（PR 本文の肥大を防ぐ）。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxFindings: 100,
  /** models.dev の応答の byte 数の上限。実測 6,736,604 byte の約 2.5 倍。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxRawBytes: 16_777_216,
  /** models.dev の応答の入れ子の上限。実測の最大は 10（primitive まで数えて 11）。約 2 倍。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxRawDepth: 24,
  /** models.dev の provider 数の上限。実測 324。約 3 倍。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxRawProviders: 1_000,
  /** 対応 provider 1 つあたりの model 数の上限。実測の最大は 382（openrouter）。暫定（2026-11-19）、実測後にユーザー確認。 */
  maxRawModelsPerProvider: 5_000,
});

// ---------------------------------------------------------------------------
// 失敗の code と findings
// ---------------------------------------------------------------------------

/**
 * 失敗の code。種別（`SNAPSHOT_FAILURE_CATEGORY`）は schema／範囲／規模／古さ／急減。
 * host の失敗は取得層（PR-C2）の code で、この module は出さない。
 */
export const SNAPSHOT_FAILURE_CODES = [
  "syntax",
  "schema",
  "unsupported-schema-version",
  "duplicate-key",
  "forbidden-key",
  "too-large",
  "too-deep",
  "too-many-models",
  "too-many-invalid",
  "empty",
  "future-generated-at",
  "stale",
  "generated-at-conflict",
  "shrunk",
] as const;
export type SnapshotFailureCode = (typeof SNAPSHOT_FAILURE_CODES)[number];

export type SnapshotFailureCategory =
  | "schema"
  | "range"
  | "size"
  | "freshness"
  | "shrink";

export const SNAPSHOT_FAILURE_CATEGORY: Readonly<
  Record<SnapshotFailureCode, SnapshotFailureCategory>
> = Object.freeze({
  syntax: "schema",
  schema: "schema",
  "unsupported-schema-version": "schema",
  "duplicate-key": "schema",
  "forbidden-key": "schema",
  "too-large": "size",
  "too-deep": "size",
  "too-many-models": "size",
  "too-many-invalid": "range",
  empty: "range",
  "future-generated-at": "freshness",
  stale: "freshness",
  "generated-at-conflict": "freshness",
  shrunk: "shrink",
});

export type SnapshotFindingCode =
  | "ignored-provider"
  | "ignored-provider-model"
  | "ignored-non-chat-model"
  | "no-usable-field-dropped"
  | "invalid-model-dropped"
  | "unknown-limit-omitted"
  | "unknown-field-dropped"
  | "models-added"
  | "models-removed"
  | "model-count-dropped"
  | "provider-count-dropped"
  | "model-retention-dropped"
  | "provider-retention-dropped"
  | "provider-removed"
  | "context-changed"
  | "capability-changed"
  | "field-removed"
  | "findings-truncated";

/** 件数・数値・検証済みの key だけを持つ。応答の本文は入れない。 */
export interface SnapshotFinding {
  readonly code: SnapshotFindingCode;
  readonly count?: number;
  readonly key?: string;
  readonly field?: keyof ModelEntry;
  readonly from?: number | boolean;
  readonly to?: number | boolean;
}

export interface SnapshotFailure {
  readonly ok: false;
  readonly code: SnapshotFailureCode;
  readonly findings: readonly SnapshotFinding[];
}

export type NormalizeResult =
  | {
      readonly ok: true;
      readonly snapshot: Snapshot;
      readonly findings: readonly SnapshotFinding[];
    }
  | SnapshotFailure;

export type ParseSnapshotResult =
  | {
      readonly ok: true;
      readonly snapshot: Snapshot;
      /**
       * `canonicalize(snapshot)` の SHA-256（小文字の hex）。
       * 「捨てた後の正規形」の digest で、入力の本文の digest ではない。未知の field・無視した
       * provider・不正で捨てた model・空白や key の順序の違いは digest に影響しないため、本文の
       * 改ざんの検出には使えない（同じ内容かどうかの照合にだけ使う）。T9 が本文の bytes の改ざん
       * 検出を要るなら、取得層（PR-C2）で raw の bytes の digest を別に取る。
       */
      readonly digest: string;
      readonly findings: readonly SnapshotFinding[];
    }
  | SnapshotFailure;

export type CompareResult =
  | { readonly ok: true; readonly findings: readonly SnapshotFinding[] }
  | SnapshotFailure;

export type ParseRawResult =
  | { readonly ok: true; readonly value: unknown }
  | SnapshotFailure;

// ---------------------------------------------------------------------------
// 内部の道具
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const PROVIDER_SET: ReadonlySet<string> = new Set(SNAPSHOT_PROVIDERS);
/**
 * id の形。2026-11-19 の実測（対応 4 provider の chat 系 437 件）の全てが通る最小限の形に絞る。
 * 小文字・数字・`.`・`-` の token が最大 1 つの `/` で 2 つまで、末尾に最大 1 つの `:tag`、先頭だけ
 * `~`（OpenRouter の別名）。`//`・`@`・`_`・大文字・空白は通さない（URL や文の形になる id を弾く）。
 * 暫定（2026-11-19）、実測後にユーザー確認。
 */
const ID_PATTERN =
  /^~?[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*)?(?::[a-z0-9.-]+)?$/;
const GENERATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ENTRY_FIELDS: ReadonlySet<string> = new Set([
  "contextWindow",
  "maxOutputTokens",
  "toolCall",
  "reasoning",
]);
const ROOT_FIELDS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "generatedAt",
  "source",
  "models",
]);

function fail(
  code: SnapshotFailureCode,
  findings: readonly SnapshotFinding[] = [],
): SnapshotFailure {
  return { ok: false, code, findings };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 自前の property だけを読む（継承された property を値として拾わない）。 */
function getOwn(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function pushCount(
  findings: SnapshotFinding[],
  code: SnapshotFindingCode,
  count: number,
): void {
  if (count > 0) findings.push({ code, count });
}

/** `generatedAt` の形式（秒までの UTC）と、実在する日時であること。epoch ms を返す。 */
function parseGeneratedAt(value: unknown): number | null {
  if (typeof value !== "string" || !GENERATED_AT_PATTERN.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // 2026-02-30 のような存在しない日が繰り上がる緩い解釈を、往復で弾く。
  return new Date(ms).toISOString() === value.replace("Z", ".000Z") ? ms : null;
}

/** provider の形（閉じた集合に無い provider を「形は正しい」と見なすための文字種）。 */
const FOREIGN_PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

type KeyClass = "ok" | "foreign-provider" | "invalid";

/**
 * key（`<provider>/<id>`）の分類。provider は閉じた集合で照合し、id は形で限る。
 * 形は正しいが provider が集合に無い key は `foreign-provider`（不正ではなく「無視」）。
 * 配信する写しは全ての版の app で共通なので、後から provider が増えても、古い版の app が
 * 「不正の割合」で写し全体を捨てないようにする。無視する key は保存も表示もしないので、
 * id の形は問わない（新しい provider の id の形は古い版が知らない）。
 */
function classifyKey(key: string, policy: SnapshotPolicy): KeyClass {
  if (key.length === 0 || key.length > policy.maxKeyLength) return "invalid";
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return "invalid";
  const provider = key.slice(0, slash);
  if (!PROVIDER_SET.has(provider)) {
    return FOREIGN_PROVIDER_PATTERN.test(provider)
      ? "foreign-provider"
      : "invalid";
  }
  const id = key.slice(slash + 1);
  return ID_PATTERN.test(id) && !FORBIDDEN_KEYS.has(id) ? "ok" : "invalid";
}

type EntryOutcome =
  | { readonly kind: "ok"; readonly entry: ModelEntry }
  | { readonly kind: "invalid" }
  | { readonly kind: "empty" };

/**
 * 4 つの field の値から 1 件の entry を作る。`undefined` は「返さない」で、それ以外は
 * 型と範囲を満たすこと。maxOutputTokens ≤ contextWindow（両方あるとき）。
 * 変換（normalize）と検証（parse）が同じ判定を通るよう、ここに集める。
 */
function buildEntry(
  contextWindow: unknown,
  maxOutputTokens: unknown,
  toolCall: unknown,
  reasoning: unknown,
  policy: SnapshotPolicy,
): EntryOutcome {
  const entry: {
    contextWindow?: number;
    maxOutputTokens?: number;
    toolCall?: boolean;
    reasoning?: boolean;
  } = {};
  if (contextWindow !== undefined) {
    if (
      !isIntegerInRange(
        contextWindow,
        policy.minContextWindow,
        policy.maxContextWindow,
      )
    ) {
      return { kind: "invalid" };
    }
    entry.contextWindow = contextWindow as number;
  }
  if (maxOutputTokens !== undefined) {
    if (
      !isIntegerInRange(
        maxOutputTokens,
        policy.minMaxOutputTokens,
        policy.maxMaxOutputTokens,
      )
    ) {
      return { kind: "invalid" };
    }
    entry.maxOutputTokens = maxOutputTokens as number;
  }
  if (toolCall !== undefined) {
    if (typeof toolCall !== "boolean") return { kind: "invalid" };
    entry.toolCall = toolCall;
  }
  if (reasoning !== undefined) {
    if (typeof reasoning !== "boolean") return { kind: "invalid" };
    entry.reasoning = reasoning;
  }
  if (
    entry.contextWindow !== undefined &&
    entry.maxOutputTokens !== undefined &&
    entry.maxOutputTokens > entry.contextWindow
  ) {
    return { kind: "invalid" };
  }
  if (Object.keys(entry).length === 0) return { kind: "empty" };
  return { kind: "ok", entry: Object.freeze(entry) };
}

function newModelsObject(): Record<string, ModelEntry> {
  return Object.create(null) as Record<string, ModelEntry>;
}

// ---------------------------------------------------------------------------
// JSON の走査（深さ・重複 key・特殊 key）
// ---------------------------------------------------------------------------

type ScanFailureCode =
  | "syntax"
  | "too-deep"
  | "duplicate-key"
  | "forbidden-key";

interface ScanFrame {
  readonly isObject: boolean;
  expectKey: boolean;
  readonly keys: Set<string> | null;
}

/**
 * `JSON.parse` の前に、本文を 1 度走査する。`JSON.parse` は深い入力で例外を出し、重複 key を
 * 黙って後勝ちにするため、それを parse の前に検出する。文法そのものの検証は `JSON.parse` に任せ、
 * ここでは入れ子の深さ（maxDepth を超えたら即座に止める）と、`strictKeys` のときの
 * 重複 key・特殊 key だけを見る。
 */
function scanJson(
  text: string,
  maxDepth: number,
  strictKeys: boolean,
): ScanFailureCode | null {
  const stack: ScanFrame[] = [];
  const length = text.length;
  let index = 0;
  while (index < length) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      // 文字列。直前の連続する backslash が奇数個の quote は escape された quote。
      let end = -1;
      let from = index + 1;
      while (end < 0) {
        const quote = text.indexOf('"', from);
        if (quote < 0) return "syntax";
        let backslashes = 0;
        let back = quote - 1;
        while (back > index && text.charCodeAt(back) === 0x5c) {
          backslashes += 1;
          back -= 1;
        }
        if (backslashes % 2 === 0) end = quote;
        else from = quote + 1;
      }
      if (strictKeys) {
        const top = stack[stack.length - 1];
        if (top !== undefined && top.isObject && top.expectKey) {
          const body = text.slice(index + 1, end);
          let key = body;
          if (body.includes("\\")) {
            try {
              key = JSON.parse(`"${body}"`) as string;
            } catch {
              return "syntax";
            }
          }
          if (FORBIDDEN_KEYS.has(key)) return "forbidden-key";
          if (top.keys !== null) {
            if (top.keys.has(key)) return "duplicate-key";
            top.keys.add(key);
          }
          top.expectKey = false;
        }
      }
      index = end + 1;
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      if (stack.length + 1 > maxDepth) return "too-deep";
      const isObject = code === 0x7b;
      stack.push({
        isObject,
        expectKey: isObject,
        keys: strictKeys && isObject ? new Set<string>() : null,
      });
    } else if (code === 0x7d || code === 0x5d) {
      if (stack.pop() === undefined) return "syntax";
    } else if (code === 0x2c) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.isObject) top.expectKey = true;
    }
    index += 1;
  }
  return stack.length === 0 ? null : "syntax";
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// 4.1 parseSnapshot：写しの検証
// ---------------------------------------------------------------------------

/**
 * 写しの本文を検証する。取得した応答・cache の読み出し・同梱の写しのすべてがここを通る。
 * 例外は投げず、失敗は code で返す（`nowMs` が有限の数でないときだけ呼び出し側の誤りとして投げる）。
 *
 * 順序：byte 数 → 走査（深さ・重複 key・特殊 key）→ JSON.parse → schema → model ごとの検証。
 * 1 件の不正はその model だけ捨て、捨てた割合が上限を超えたらファイル全体を捨てる。
 * 未知の field（model 内）は捨てて件数を findings に残す。root の未知の key は schema の違反。
 *
 * 返す `digest` は「捨てた後の正規形」（`canonicalize(snapshot)`）の SHA-256 で、入力の本文の
 * digest ではない。捨てた model・未知の field・無視した provider・空白・key の順序は反映されない
 * ため、本文の改ざんの検出（T9）には使えない。T9 に本文の bytes の検出が要るなら、取得層
 * （PR-C2）で raw の bytes の digest を別に取る。
 */
export function parseSnapshot(
  text: string,
  policy: SnapshotPolicy,
  context: { readonly nowMs: number },
): ParseSnapshotResult {
  if (!Number.isFinite(context.nowMs)) {
    throw new TypeError("nowMs must be a finite number");
  }
  if (typeof text !== "string") return fail("syntax");
  // UTF-8 の byte 数は UTF-16 の長さ以上。巨大な入力は encode する前に落とす。
  if (text.length > policy.maxSnapshotBytes) return fail("too-large");
  if (utf8Length(text) > policy.maxSnapshotBytes) return fail("too-large");
  const scan = scanJson(text, policy.maxSnapshotDepth, true);
  if (scan !== null) return fail(scan);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // V8 の message は本文の断片を含むので、捨てる。
    return fail("syntax");
  }
  if (!isPlainObject(value)) return fail("schema");
  // 版の確認は他の field より先に行う（新しい版は形が違ってよい）。
  const version = getOwn(value, "schemaVersion");
  if (version === undefined) return fail("schema");
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    return fail("schema");
  }
  if (version !== SNAPSHOT_SCHEMA_VERSION) {
    return fail("unsupported-schema-version");
  }
  for (const key of Object.keys(value)) {
    if (!ROOT_FIELDS.has(key)) return fail("schema");
  }
  const generatedAt = getOwn(value, "generatedAt");
  const generatedMs = parseGeneratedAt(generatedAt);
  if (generatedMs === null) return fail("schema");
  if (generatedMs > context.nowMs + policy.maxFutureSkewMs) {
    return fail("future-generated-at");
  }
  const source = getOwn(value, "source");
  if (
    typeof source !== "string" ||
    !(SNAPSHOT_SOURCES as readonly string[]).includes(source)
  ) {
    return fail("schema");
  }
  const rawModels = getOwn(value, "models");
  if (!isPlainObject(rawModels)) return fail("schema");
  const keys = Object.keys(rawModels);

  const models = newModelsObject();
  let invalid = 0;
  let ignoredProviderModels = 0;
  let unknownFields = 0;
  let considered = 0;
  for (const key of keys) {
    const keyClass = classifyKey(key, policy);
    if (keyClass === "foreign-provider") {
      ignoredProviderModels += 1;
      continue;
    }
    // 件数の上限は対応 provider の entry にだけ当てる（無視する entry は全体の byte 数で守る）。
    considered += 1;
    if (considered > policy.maxModels) return fail("too-many-models");
    const entry = rawModels[key];
    if (keyClass === "invalid" || !isPlainObject(entry)) {
      invalid += 1;
      continue;
    }
    const outcome = buildEntry(
      getOwn(entry, "contextWindow"),
      getOwn(entry, "maxOutputTokens"),
      getOwn(entry, "toolCall"),
      getOwn(entry, "reasoning"),
      policy,
    );
    if (outcome.kind !== "ok") {
      invalid += 1;
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(field)) unknownFields += 1;
    }
    models[key] = outcome.entry;
  }
  const findings: SnapshotFinding[] = [];
  pushCount(findings, "ignored-provider-model", ignoredProviderModels);
  pushCount(findings, "invalid-model-dropped", invalid);
  pushCount(findings, "unknown-field-dropped", unknownFields);
  // 分母は対応表の provider の model だけ（対応外の provider の model は「無視」）。
  const candidates = keys.length - ignoredProviderModels;
  if (candidates > 0 && invalid > candidates * policy.maxInvalidRatio) {
    return fail("too-many-invalid", findings);
  }
  if (Object.keys(models).length === 0) return fail("empty", findings);

  const snapshot: Snapshot = Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: generatedAt as string,
    source: source as SnapshotSource,
    models: Object.freeze(models),
  });
  return {
    ok: true,
    snapshot,
    digest: sha256Hex(canonicalize(snapshot)),
    findings,
  };
}

// ---------------------------------------------------------------------------
// 4.1 normalizeModelsDev：models.dev → 写しの形式
// ---------------------------------------------------------------------------

/**
 * models.dev の応答の本文（text）を、byte 数・入れ子の深さの上限の内で parse する。
 * 重複 key は後勝ちにする（対応外の provider の重複で全体を捨てないため。対応 provider の値は
 * `normalizeModelsDev` と `parseSnapshot` の検証を通る）。
 */
export function parseModelsDevText(
  text: string,
  policy: SnapshotPolicy,
): ParseRawResult {
  if (typeof text !== "string") return fail("syntax");
  if (text.length > policy.maxRawBytes) return fail("too-large");
  if (utf8Length(text) > policy.maxRawBytes) return fail("too-large");
  const scan = scanJson(text, policy.maxRawDepth, false);
  if (scan !== null) return fail(scan);
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return fail("syntax");
  }
}

/**
 * models.dev の応答（parse 済み）を写しの形式へ変換する。field 名は 2026-11-19 の一次資料の確認に
 * よる：provider の下の `models`（key が model id）、`limit.context`／`limit.output`、
 * `tool_call`、`reasoning`、`type`（chat 以外の embedding・image・video などは対象外）。
 * `limit` の 0 は「不明」で、その field を返さない。文字列の field（name・description・api など）は
 * 一切読まない。対応表に無い provider は捨てる。
 *
 * 捨てた割合の分母は、対応表の provider の chat 系 model だけ（対応外の provider は「無視」）。
 * `source` は写しの取得元の刻印で、意味は呼び出し側が決めて渡す（CI が作る GitHub の写しは
 * "grimodex"、app が models.dev から直接取得した写しは "models.dev"。§7 Q14 の取得元の切替で使う）。
 * 生成した写しは、呼び出し側が `canonicalize` → `parseSnapshot` に通してから採用する。
 */
export function normalizeModelsDev(
  raw: unknown,
  policy: SnapshotPolicy,
  context: { readonly generatedAt: string; readonly source: SnapshotSource },
): NormalizeResult {
  if (parseGeneratedAt(context.generatedAt) === null) return fail("schema");
  if (!(SNAPSHOT_SOURCES as readonly string[]).includes(context.source)) {
    return fail("schema");
  }
  if (!isPlainObject(raw)) return fail("schema");
  const providerKeys = Object.keys(raw);
  if (providerKeys.length > policy.maxRawProviders) return fail("too-large");

  const models = newModelsObject();
  let ignoredProviders = providerKeys.length;
  let ignoredNonChat = 0;
  let noUsableField = 0;
  let invalid = 0;
  let unknownLimit = 0;
  let kept = 0;
  for (const [devId, provider] of MODELS_DEV_PROVIDER_MAP) {
    if (!Object.hasOwn(raw, devId)) continue;
    ignoredProviders -= 1;
    const providerValue = raw[devId];
    if (!isPlainObject(providerValue)) return fail("schema");
    const devModels = getOwn(providerValue, "models");
    if (!isPlainObject(devModels)) return fail("schema");
    const ids = Object.keys(devModels);
    if (ids.length > policy.maxRawModelsPerProvider) return fail("too-large");
    for (const id of ids) {
      const model = devModels[id];
      if (!isPlainObject(model)) {
        invalid += 1;
        continue;
      }
      const type = getOwn(model, "type");
      // 文字列でない type は型違いの不正（分母に入れる）。chat 以外の文字列だけを無視する。
      if (type !== undefined && typeof type !== "string") {
        invalid += 1;
        continue;
      }
      if (type !== undefined && type !== "chat") {
        ignoredNonChat += 1;
        continue;
      }
      const key = `${provider}/${id}`;
      if (classifyKey(key, policy) !== "ok") {
        invalid += 1;
        continue;
      }
      const limit = getOwn(model, "limit");
      if (limit !== undefined && !isPlainObject(limit)) {
        invalid += 1;
        continue;
      }
      let contextWindow =
        limit === undefined ? undefined : getOwn(limit, "context");
      let maxOutputTokens =
        limit === undefined ? undefined : getOwn(limit, "output");
      if (contextWindow === 0) {
        contextWindow = undefined;
        unknownLimit += 1;
      }
      if (maxOutputTokens === 0) {
        maxOutputTokens = undefined;
        unknownLimit += 1;
      }
      const outcome = buildEntry(
        contextWindow,
        maxOutputTokens,
        getOwn(model, "tool_call"),
        getOwn(model, "reasoning"),
        policy,
      );
      if (outcome.kind === "invalid") {
        invalid += 1;
      } else if (outcome.kind === "empty") {
        noUsableField += 1;
      } else {
        models[key] = outcome.entry;
        kept += 1;
      }
    }
  }
  const findings: SnapshotFinding[] = [];
  pushCount(findings, "ignored-provider", ignoredProviders);
  pushCount(findings, "ignored-non-chat-model", ignoredNonChat);
  pushCount(findings, "no-usable-field-dropped", noUsableField);
  pushCount(findings, "invalid-model-dropped", invalid);
  pushCount(findings, "unknown-limit-omitted", unknownLimit);
  const candidates = kept + invalid;
  if (candidates > 0 && invalid > candidates * policy.maxInvalidRatio) {
    return fail("too-many-invalid", findings);
  }
  if (kept > policy.maxModels) return fail("too-many-models", findings);
  if (kept === 0) return fail("empty", findings);
  return {
    ok: true,
    snapshot: Object.freeze({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: context.generatedAt,
      source: context.source,
      models: Object.freeze(models),
    }),
    findings,
  };
}

// ---------------------------------------------------------------------------
// 4.1 canonicalize と digest
// ---------------------------------------------------------------------------

function canonicalEntry(entry: ModelEntry): string {
  const parts: string[] = [];
  // key の整列順（辞書順）で並べる。
  if (entry.contextWindow !== undefined) {
    parts.push(`"contextWindow":${canonicalInteger(entry.contextWindow)}`);
  }
  if (entry.maxOutputTokens !== undefined) {
    parts.push(`"maxOutputTokens":${canonicalInteger(entry.maxOutputTokens)}`);
  }
  if (entry.reasoning !== undefined) {
    parts.push(`"reasoning":${entry.reasoning === true ? "true" : "false"}`);
  }
  if (entry.toolCall !== undefined) {
    parts.push(`"toolCall":${entry.toolCall === true ? "true" : "false"}`);
  }
  return `{${parts.join(",")}}`;
}

function canonicalInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("snapshot numbers must be safe integers");
  }
  return String(value);
}

/**
 * key を整列した決定的な直列化（空白なし、末尾の改行なし）。同じ内容は常に同じ文字列になる。
 * 検証済みの写しだけを渡す（検証していない値は、整数でなければ例外を投げる）。
 */
export function canonicalize(snapshot: Snapshot): string {
  const keys = Object.keys(snapshot.models).sort();
  const models = keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalEntry(snapshot.models[key] as ModelEntry)}`,
    )
    .join(",");
  return (
    `{"generatedAt":${JSON.stringify(snapshot.generatedAt)},` +
    `"models":{${models}},` +
    `"schemaVersion":${canonicalInteger(snapshot.schemaVersion)},` +
    `"source":${JSON.stringify(snapshot.source)}}`
  );
}

// SHA-256（FIPS 180-4）。node:crypto を import できないため、この module 内で持つ。
// 試験が node:crypto の結果と照合する。
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** 文字列を UTF-8 として SHA-256 にかけ、小文字の hex を返す。 */
export function sha256Hex(input: string): string {
  const data = new TextEncoder().encode(input);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = data.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  const hash = Uint32Array.from(SHA256_H0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t += 1)
      w[t] = view.getUint32(offset + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const a = w[t - 15] as number;
      const b = w[t - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0;
    }
    let a = hash[0] as number;
    let b = hash[1] as number;
    let c = hash[2] as number;
    let d = hash[3] as number;
    let e = hash[4] as number;
    let f = hash[5] as number;
    let g = hash[6] as number;
    let h = hash[7] as number;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + s1 + choose + (SHA256_K[t] as number) + (w[t] as number)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    hash[0] = ((hash[0] as number) + a) | 0;
    hash[1] = ((hash[1] as number) + b) | 0;
    hash[2] = ((hash[2] as number) + c) | 0;
    hash[3] = ((hash[3] as number) + d) | 0;
    hash[4] = ((hash[4] as number) + e) | 0;
    hash[5] = ((hash[5] as number) + f) | 0;
    hash[6] = ((hash[6] as number) + g) | 0;
    hash[7] = ((hash[7] as number) + h) | 0;
  }
  let hex = "";
  for (const word of hash) hex += word.toString(16).padStart(8, "0");
  return hex;
}

// ---------------------------------------------------------------------------
// 4.1・4.4 compareSnapshots：前回との比較
// ---------------------------------------------------------------------------

function providerOf(key: string): string {
  return key.slice(0, key.indexOf("/"));
}

function countByProvider(snapshot: Snapshot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of Object.keys(snapshot.models)) {
    const provider = providerOf(key);
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return counts;
}

const COMPARED_FIELDS = [
  "contextWindow",
  "maxOutputTokens",
  "toolCall",
  "reasoning",
] as const;

/**
 * 採用済みの写し（previous）と新しい写し（next）を比べる。どちらも検証済みの写し（key は念のため
 * 再検証し、違反があれば `schema` で拒否する。findings に出る key は検証を通ったものだけ）。
 *   - 古さ：next が previous より古ければ棄却（`stale`。再生への備え）。同時刻は、内容（正規形の
 *     digest）が同じなら通し（自分の cache や同梱の写しを読み直しても落ちない）、違えば
 *     `generated-at-conflict` で棄却する（同じ日時のまま中身を差し替える写しを通さない）。
 *   - 急減（`shrunk`）：件数が previous の `minCountRatio` 未満、または件数の多い provider が同じ
 *     割合で減ったとき。件数が同じでも、previous の key のうち next にも残った割合（保持率）が
 *     `minCountRatio` 未満なら（id の総入れ替え）、全体と provider 単位の両方で棄却する。
 *   - findings（捨てはしない）：追加・削除の件数、previous にあった provider の全消失、
 *     contextWindow の `contextChangeFactor` 倍以上の増減、toolCall／reasoning の反転、
 *     値から field なしへの変化。件数は `maxFindings` で切る。
 * 実行時は「直前に採用した cache」と「同梱の写し」の両方を previous として呼ぶ（§4.4）。
 */
export function compareSnapshots(
  previous: Snapshot,
  next: Snapshot,
  policy: SnapshotPolicy,
): CompareResult {
  const previousKeys = Object.keys(previous.models).sort();
  const nextKeys = Object.keys(next.models).sort();
  for (const key of [...previousKeys, ...nextKeys]) {
    if (classifyKey(key, policy) !== "ok") return fail("schema");
  }
  const previousMs = Date.parse(previous.generatedAt);
  const nextMs = Date.parse(next.generatedAt);
  if (nextMs < previousMs) return fail("stale");
  if (
    nextMs === previousMs &&
    sha256Hex(canonicalize(previous)) !== sha256Hex(canonicalize(next))
  ) {
    return fail("generated-at-conflict");
  }

  const failureFindings: SnapshotFinding[] = [];
  let shrunk = false;
  if (
    previousKeys.length > 0 &&
    nextKeys.length < previousKeys.length * policy.minCountRatio
  ) {
    failureFindings.push({
      code: "model-count-dropped",
      from: previousKeys.length,
      to: nextKeys.length,
    });
    shrunk = true;
  }
  const previousByProvider = countByProvider(previous);
  const nextByProvider = countByProvider(next);
  const retainedByProvider = new Map<string, number>();
  let retained = 0;
  for (const key of previousKeys) {
    if (next.models[key] === undefined) continue;
    retained += 1;
    const provider = providerOf(key);
    retainedByProvider.set(
      provider,
      (retainedByProvider.get(provider) ?? 0) + 1,
    );
  }
  if (
    previousKeys.length > 0 &&
    retained < previousKeys.length * policy.minCountRatio
  ) {
    failureFindings.push({
      code: "model-retention-dropped",
      from: previousKeys.length,
      to: retained,
    });
    shrunk = true;
  }
  const removedProviders: string[] = [];
  for (const provider of [...previousByProvider.keys()].sort()) {
    const before = previousByProvider.get(provider) as number;
    const after = nextByProvider.get(provider) ?? 0;
    const kept = retainedByProvider.get(provider) ?? 0;
    if (after === 0) removedProviders.push(provider);
    if (before < policy.minProviderBaseline) continue;
    if (after < before * policy.minCountRatio) {
      failureFindings.push({
        code: "provider-count-dropped",
        key: provider,
        from: before,
        to: after,
      });
      shrunk = true;
    }
    if (kept < before * policy.minCountRatio) {
      failureFindings.push({
        code: "provider-retention-dropped",
        key: provider,
        from: before,
        to: kept,
      });
      shrunk = true;
    }
  }
  if (shrunk) return fail("shrunk", failureFindings);

  const findings: SnapshotFinding[] = [];
  let total = 0;
  const add = (finding: SnapshotFinding): void => {
    total += 1;
    if (findings.length < policy.maxFindings) findings.push(finding);
  };
  let added = 0;
  for (const key of nextKeys) {
    const before = previous.models[key];
    const after = next.models[key] as ModelEntry;
    if (before === undefined) {
      added += 1;
      continue;
    }
    const from = before.contextWindow;
    const to = after.contextWindow;
    if (
      from !== undefined &&
      to !== undefined &&
      (to >= from * policy.contextChangeFactor ||
        to * policy.contextChangeFactor <= from)
    ) {
      add({ code: "context-changed", key, from, to });
    }
    for (const field of ["toolCall", "reasoning"] as const) {
      const was = before[field];
      const now = after[field];
      if (was !== undefined && now !== undefined && was !== now) {
        add({ code: "capability-changed", key, field, from: was, to: now });
      }
    }
    // 値から「返さない」への変化（下の層へ落ちる）も見えるようにする。
    for (const field of COMPARED_FIELDS) {
      const was = before[field];
      if (was !== undefined && after[field] === undefined) {
        add({ code: "field-removed", key, field, from: was });
      }
    }
  }
  for (const provider of removedProviders) {
    add({
      code: "provider-removed",
      key: provider,
      from: previousByProvider.get(provider) as number,
    });
  }
  if (total > findings.length) {
    findings.push({
      code: "findings-truncated",
      count: total - findings.length,
    });
  }
  pushCount(findings, "models-added", added);
  pushCount(findings, "models-removed", previousKeys.length - retained);
  return { ok: true, findings };
}
