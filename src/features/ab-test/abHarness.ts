/**
 * A/B 比較ハーネス (③)。
 *
 * 同一の基底プロンプトに対し **N 構成 (スロット)** を走らせ、結果を横並びで
 * 比較できるようにする純粋なディスパッチ層。surface ごとの実 LLM 呼び出しは
 * `dispatch` コールバックで注入する (chat=非ストリーミング / inline=streaming)。
 * これにより:
 *  - ライブ ChatPanel の単一ストリーム描画を一切いじらずに chat A/B を実現できる
 *  - 分岐ロジック (promptVariant 合成・並列実行・結果整形) を単体テストできる
 *
 * 各スロットは独立した自由構成 (AbConfig) を持つ:
 *  - 1 枠目 (基準) は `{}` = 設定の既定 (provider / model 未指定)
 *  - 2 枠目以降は provider / model / promptVariant を各々自由に上書きできる
 */

export type AbSurface = "chat" | "inline";

/**
 * A/B の 1 スロット構成。すべて undefined なら「設定の既定どおり」を意味する。
 */
export interface AbConfig {
  /**
   * プロバイダ override (chat のみ)。空 / undefined なら設定の既定プロバイダ。
   * 値は FE の `AiProvider` 文字列 ("openrouter" / "sakana" 等) と一致させる。
   */
  provider?: string | null;
  /** モデル override。空 / undefined なら設定の既定モデル。 */
  model?: string | null;
  /**
   * OpenAI 互換: この枠だけ別エンドポイントへ向ける override (endpoint id)。
   * provider が "openai-compatible" のときだけ意味を持ち、送信先 base_url / API キーを
   * 切り替える。それ以外の provider では無視される (backend 側で drop)。
   * 空 / undefined なら設定の active エンドポイント。
   */
  endpointId?: string | null;
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

/** A/B にかける基底リクエスト。messages は全構成で共有される。 */
export interface AbRequest {
  /** 基底プロンプト (system / user)。全構成で共通。 */
  messages: AbMessage[];
  /** 表示・記録用にプロンプト要旨を保持する (任意)。 */
  promptSummary?: string;
}

export type AbRunResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export interface AbDispatchContext {
  readonly operationId: string;
  /** Project authority captured with the workspace before any slot runs. */
  readonly projectId: string | null;
  /** One immutable ledger authority shared by every fresh A/B slot. */
  readonly expectedWorkspacePath: string;
  readonly slotIndex: number;
  readonly configFingerprint: string;
}

/**
 * surface 別の実行アダプタ。messages と config を受け取り 1 構成を走らせる。
 * - chat  : 非ストリーミング send_chat_message を 1 回 (provider / model override 付き)
 * - inline : streamInlineAiText を 1 回 (model override 付き)
 * 例外は内部で握り潰さず { ok:false } で返すこと (1 枠の失敗が全体を倒さない)。
 */
export type AbDispatcher = (
  messages: AbMessage[],
  config: AbConfig,
  context: AbDispatchContext,
) => Promise<AbRunResult>;

/** 1 スロットの実行結果 (構成・最終 messages・結果)。 */
export interface AbSlotResult {
  config: AbConfig;
  result: AbRunResult;
  /** この構成に実際に渡した最終 messages (promptVariant 合成後)。表示/記録用。 */
  messages: AbMessage[];
  /** Exact cache authority for this project/workspace/request/config tuple. */
  reuseIdentity: string | null;
}

export interface AbReuseEntry {
  readonly result: AbRunResult;
  readonly identity: string;
  readonly sourceExecutionId?: string | null;
}

/**
 * promptVariant を基底 messages に合成する。
 * 追記指示があれば user ロールのメッセージとして末尾に足す。空なら無変更。
 * 元配列は破壊しない (各構成で同じ基底を共有するため)。
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
   * では複数同時に走らせると chunk が混線するため必ず逐次にする。
   */
  parallel?: boolean;
  /**
   * スロットごとに再生成せず既存結果を流用する (configs と同じ index で対応)。
   * **ok な結果が渡された index だけ**流用し、それ以外のスロットのみ実行する。
   * null / 失敗結果 / 未指定の index は従来どおり実行する。
   * 構成が変わっていないスロット (基準枠や未編集枠) の無駄な生成/課金を避ける。
   */
  reuse?: (AbReuseEntry | null | undefined)[];
  /** Project-scoped audit identity shared by every slot in this comparison. */
  audit: {
    /** null is an intentional workspace-scoped A/B execution. */
    projectId: string | null;
    pathId: "ab_chat" | "ab_inline";
    operationId?: string;
    /** Immutable workspace authority captured before evaluating reuse. */
    expectedWorkspacePath: string;
    /** Exact canonical non-secret AI settings snapshot; null disables reuse. */
    settingsAuthority: string | null;
  };
}

function configFingerprint(config: AbConfig): string {
  const canonical = JSON.stringify([
    config.provider ?? null,
    config.model ?? null,
    config.endpointId ?? null,
    config.promptVariant ?? null,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildAbReuseIdentity(input: {
  readonly projectId: string | null;
  readonly expectedWorkspacePath: string;
  readonly pathId: "ab_chat" | "ab_inline";
  readonly settingsAuthority: string;
  readonly messages: readonly AbMessage[];
  readonly config: AbConfig;
}): string {
  return JSON.stringify({
    version: 1,
    projectId: input.projectId,
    expectedWorkspacePath: input.expectedWorkspacePath,
    pathId: input.pathId,
    settingsAuthority: input.settingsAuthority,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    config: {
      provider: input.config.provider ?? null,
      model: input.config.model ?? null,
      endpointId: input.config.endpointId ?? null,
      promptVariant: input.config.promptVariant ?? null,
    },
  });
}

function canonicalizeSettingsValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeSettingsValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeSettingsValue(entry)]),
    );
  }
  return value;
}

/** Exact, collision-free authority used only in renderer memory. */
export function buildAbSettingsAuthority(settings: unknown): string {
  return JSON.stringify(canonicalizeSettingsValue(settings));
}

/**
 * N 構成を実行する。`dispatch` は全スロットで同一の関数を使う
 * (surface の差は dispatch の中身で吸収済み)。既定は Promise.all で並走、
 * `parallel:false` で逐次。いずれも 1 枠の失敗は他を倒さない ({ ok:false })。
 * 戻り値は configs と同じ並び順の `AbSlotResult[]`。
 */
export async function runAbComparison(
  request: AbRequest,
  configs: AbConfig[],
  dispatch: AbDispatcher,
  options: RunAbOptions,
): Promise<AbSlotResult[]> {
  const { beginAiAuditExecutionInWorkspace, cacheHitAiAuditExecution } =
    await import("@/features/ai-audit/api");
  const parallel = options.parallel ?? true;
  const reuse = options.reuse ?? [];
  const operationId = options.audit.operationId ?? crypto.randomUUID();
  const slots = configs.map((config) => {
    const messages = applyPromptVariant(request.messages, config.promptVariant);
    return {
      config,
      messages,
      configFingerprint: configFingerprint(config),
      reuseIdentity:
        options.audit.settingsAuthority === null
          ? null
          : buildAbReuseIdentity({
              projectId: options.audit.projectId,
              expectedWorkspacePath: options.audit.expectedWorkspacePath,
              pathId: options.audit.pathId,
              settingsAuthority: options.audit.settingsAuthority,
              messages,
              config,
            }),
    };
  });

  const runOne = async (i: number): Promise<AbRunResult> => {
    const candidateReuse = reuse[i];
    const reuseEntry =
      candidateReuse?.result.ok === true &&
      slots[i].reuseIdentity !== null &&
      candidateReuse.identity === slots[i].reuseIdentity
        ? candidateReuse
        : null;
    if (reuseEntry?.result.ok === true) {
      const reused = reuseEntry.result;
      try {
        const slot = slots[i];
        const handle = await beginAiAuditExecutionInWorkspace(
          {
            projectId: options.audit.projectId,
            pathId: options.audit.pathId,
            operationId,
            request: {
              messages: slot.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
              ...(typeof slot.config.provider === "string"
                ? { provider: slot.config.provider }
                : {}),
              ...(typeof slot.config.model === "string"
                ? { model: slot.config.model }
                : {}),
              options: {
                endpointId: slot.config.endpointId ?? null,
                promptVariant: slot.config.promptVariant ?? null,
              },
              auditMetadata: {
                ab: {
                  slotIndex: i,
                  configFingerprint: slot.configFingerprint,
                },
              },
            },
            metadata: {
              slotIndex: i,
              configFingerprint: slot.configFingerprint,
              reused: true,
              sourceExecutionId: reuseEntry.sourceExecutionId ?? null,
              modelDispatched: false,
            },
            captureState:
              reuseEntry.sourceExecutionId == null ? "partial" : "complete",
            limitations:
              reuseEntry.sourceExecutionId == null
                ? ["cache-source-execution-unavailable"]
                : undefined,
          },
          options.audit.expectedWorkspacePath,
        );
        await cacheHitAiAuditExecution(handle, {
          response: reused.ok ? { text: reused.text } : undefined,
          metadata: {
            slotIndex: i,
            configFingerprint: slot.configFingerprint,
            modelDispatched: false,
            sourceExecutionId: reuseEntry.sourceExecutionId ?? null,
          },
        });
        return reused;
      } catch (error) {
        return {
          ok: false,
          error: `AI audit persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return safeDispatch(dispatch, slots[i].messages, slots[i].config, {
      operationId,
      projectId: options.audit.projectId,
      expectedWorkspacePath: options.audit.expectedWorkspacePath,
      slotIndex: i,
      configFingerprint: slots[i].configFingerprint,
    });
  };

  let results: AbRunResult[];
  if (parallel) {
    results = await Promise.all(slots.map((_, i) => runOne(i)));
  } else {
    // 逐次: 共有ストリームイベントの混線を避ける (1 枠ずつ完了させる)。
    results = [];
    for (let i = 0; i < slots.length; i++) {
      results.push(await runOne(i));
    }
  }

  return slots.map((slot, i) => ({
    config: slot.config,
    messages: slot.messages,
    result: results[i],
    reuseIdentity: slot.reuseIdentity,
  }));
}

/** dispatch が throw しても { ok:false } に正規化する (Promise.all を倒さない)。 */
async function safeDispatch(
  dispatch: AbDispatcher,
  messages: AbMessage[],
  config: AbConfig,
  context: AbDispatchContext,
): Promise<AbRunResult> {
  try {
    return await dispatch(messages, config, context);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
