/**
 * A/B 比較ハーネス (③)。
 *
 * 同一の基底プロンプトに対し 2 構成 (A / B) を**並列**に走らせ、結果を横並びで
 * 比較できるようにする純粋なディスパッチ層。surface ごとの実 LLM 呼び出しは
 * `dispatch` コールバックで注入する (chat=非ストリーミング / inline=streaming)。
 * これにより:
 *  - ライブ ChatPanel の単一ストリーム描画を一切いじらずに chat A/B を実現できる
 *  - 分岐ロジック (promptVariant 合成・並列実行・結果整形) を単体テストできる
 *
 * A/B 軸は 2 種類を 1 構造で表現する:
 *  - モデル A/B  : config.model だけを A/B で変える (promptVariant は両方同値/空)
 *  - プロンプト A/B: config.promptVariant だけを A/B で変える (model は両方同値/空)
 */

export type AbSurface = "chat" | "inline";

/** A/B の片側 1 構成。両方 undefined なら「設定の既定どおり」を意味する。 */
export interface AbConfig {
  /** モデル override。空 / undefined なら設定の既定モデル。 */
  model?: string | null;
  /**
   * プロンプト追記指示 (自由テキスト)。空 / undefined なら追記なし。
   * v1 ではこの文字列を user メッセージとして末尾に足すだけで自己完結する
   * (prompt-library テーブルへの依存なし)。
   */
  promptVariant?: string | null;
}

export interface AbMessage {
  role: string;
  content: string;
}

/** A/B にかける基底リクエスト。messages は両構成で共有される。 */
export interface AbRequest {
  /** 基底プロンプト (system / user)。両構成で共通。 */
  messages: AbMessage[];
  /** 表示・記録用にプロンプト要旨を保持する (任意)。 */
  promptSummary?: string;
}

export type AbRunResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * surface 別の実行アダプタ。messages と config を受け取り 1 構成を走らせる。
 * - chat  : 非ストリーミング send_chat_message を 1 回 (model override 付き)
 * - inline : streamInlineAiText を 1 回 (model override 付き)
 * 例外は内部で握り潰さず { ok:false } で返すこと (片側失敗が全体を倒さない)。
 */
export type AbDispatcher = (
  messages: AbMessage[],
  config: AbConfig,
) => Promise<AbRunResult>;

export interface AbComparisonResult {
  a: AbRunResult;
  b: AbRunResult;
  /** 各構成に実際に渡した最終 messages (promptVariant 合成後)。表示/記録用。 */
  messagesA: AbMessage[];
  messagesB: AbMessage[];
}

/**
 * promptVariant を基底 messages に合成する。
 * 追記指示があれば user ロールのメッセージとして末尾に足す。空なら無変更。
 * 元配列は破壊しない (A/B で同じ基底を共有するため)。
 */
export function applyPromptVariant(
  messages: AbMessage[],
  variant?: string | null,
): AbMessage[] {
  const trimmed = variant?.trim();
  if (!trimmed) return messages.slice();
  return [...messages, { role: "user", content: trimmed }];
}

export interface RunAbOptions {
  /**
   * 並列実行するか。既定 true (chat の非ストリーミングは独立した応答なので
   * 安全に並走できる)。**false にすると逐次実行**: inline-ai のように
   * グローバルな `inline-ai:stream-*` イベント / 共有 abort flag を使う surface
   * では 2 本同時に走らせると chunk が混線するため必ず逐次にする。
   */
  parallel?: boolean;
}

/**
 * A/B 2 構成を実行する。`dispatch` は両側で同一の関数を使う
 * (surface の差は dispatch の中身で吸収済み)。既定は Promise.all で並走、
 * `parallel:false` で逐次。いずれも片側失敗は他方を倒さない ({ ok:false })。
 */
export async function runAbComparison(
  request: AbRequest,
  configA: AbConfig,
  configB: AbConfig,
  dispatch: AbDispatcher,
  options?: RunAbOptions,
): Promise<AbComparisonResult> {
  const messagesA = applyPromptVariant(request.messages, configA.promptVariant);
  const messagesB = applyPromptVariant(request.messages, configB.promptVariant);

  const parallel = options?.parallel ?? true;
  let a: AbRunResult;
  let b: AbRunResult;
  if (parallel) {
    [a, b] = await Promise.all([
      safeDispatch(dispatch, messagesA, configA),
      safeDispatch(dispatch, messagesB, configB),
    ]);
  } else {
    // 逐次: 共有ストリームイベントの混線を避ける (A を完了してから B)。
    a = await safeDispatch(dispatch, messagesA, configA);
    b = await safeDispatch(dispatch, messagesB, configB);
  }

  return { a, b, messagesA, messagesB };
}

/** dispatch が throw しても { ok:false } に正規化する (Promise.all を倒さない)。 */
async function safeDispatch(
  dispatch: AbDispatcher,
  messages: AbMessage[],
  config: AbConfig,
): Promise<AbRunResult> {
  try {
    return await dispatch(messages, config);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
