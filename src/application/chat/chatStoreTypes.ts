import type {
  ChatContextPreparationInput,
  ChatContextPreparationSnapshot,
} from "./chatContextPreparation";
import type { ContextWindowUsage } from "@/features/ai-context/contextWindowUsage";
import type { RecallPromoteSuggestion } from "@/features/chat/chatRecallPromote";
import type { ChatScope } from "@/features/chat/chatScope";
import type {
  ChatMessage,
  ChatSession,
  MessageRole,
} from "@/features/chat/chatTypes";
import type { ChatContextPlan } from "@/features/chat/context/types";
import type { ContextPlanningPurpose } from "@/features/chat/context/prepareTurn";
import type { LayerBreakdown } from "@/features/chat/contextBuilder";
import type {
  AgentLoopProgress,
  AgentToolDefinition,
  AskUserContent,
  AskUserSpec,
} from "@/features/chat/agent/agentTypes";
import type { AiProvider } from "@/features/chat/types";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";
import type { CodexContextEntry } from "@/features/codex/api";

/**
 * 回答待ちのユーザー質問。renderable なデータのみを store state に置き、
 * 実際の resolve クロージャは module-local (_resolveUserQuestion) に退避する
 * （_streamCleanup / _flushPendingDelta と同じ流儀。シリアライズ不可な関数を
 * Zustand state に入れない）。
 */
export interface PendingUserQuestion {
  /** ask 発行時の activeSessionId（セッション未確立時は null）。回答適用時の整合性チェックに使う。 */
  sessionId: string | null;
  toolCallId: string;
  spec: AskUserSpec;
  /** dismiss / abort 時に LLM へ返す制御メッセージ（ask 時の言語で確定）。 */
  dismissNote: string;
}

export type ChatPromptPreviewResult =
  | {
      status: "ready";
      prompt: string;
      layers: LayerBreakdown[];
      totalTokens: number;
      contextWindowUsage: ContextWindowUsage | null;
      /** プレビューに描画する「これから送る入力メッセージ」。空文字なら非表示。 */
      userMessage: string;
    }
  | {
      /** Exact prompt construction failed; live-estimate cache must not escape here. */
      status: "unavailable";
      prompt: "";
      layers: [];
      totalTokens: 0;
      contextWindowUsage: null;
      userMessage: string;
    };

export function unavailablePromptPreview(
  userMessage: string,
): Extract<ChatPromptPreviewResult, { status: "unavailable" }> {
  return {
    status: "unavailable",
    prompt: "",
    layers: [],
    totalTokens: 0,
    contextWindowUsage: null,
    userMessage,
  };
}

export type ChatContextTurnSeed = Pick<
  ChatContextPreparationInput,
  | "projectId"
  | "effectiveSceneId"
  | "activeSceneId"
  | "activeProjectId"
  | "chatScope"
  | "scopeAnchorId"
  | "threadFocus"
  | "inputPinnedEntryIds"
  | "excludedAutoEntryIds"
  | "sessionStableCodexIds"
  | "sessionStableContextInitialized"
  | "includeBodies"
  | "includeMapBoard"
  | "mapBoardId"
>;

export interface ChatState {
  // Session management
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoadingSessions: boolean;
  isLoadingMessages: boolean;

  // Messages & streaming
  messages: ChatMessage[];
  /**
   * 生成中 assistant の本文だけを確定済み messages から分離する。
   * delta publish で messages の配列参照と過去 message の identity を維持する。
   */
  streamingDraft: { messageId: string; content: string } | null;
  isStreaming: boolean;
  error: string | null;
  activeSceneId: string;
  activeProjectId: string | null;
  contextTokenCount: number;
  /**
   * Full request-window usage paired with contextTokenCount. Unlike the legacy
   * counter, this includes Agent tool schemas, message framing, output reserve,
   * and the final safety margin.
   */
  contextWindowUsage: ContextWindowUsage | null;
  /** Context window used by the finalized turn route (null before resolution). */
  contextWindowSize: number | null;
  /** Model paired with contextTokenCount/contextWindowSize. */
  contextModel: string | null;
  /** Provider namespace paired with contextModel. */
  contextProvider: AiProvider | null;
  /** Exact route/settings identity paired with the materialized context. */
  contextRouteAuthorityKey: string | null;
  contextLayers: LayerBreakdown[];
  /** Typed selection plan behind contextLayers and the rendered prompt. */
  contextPlan: ChatContextPlan | null;
  lastSystemPrompt: string;
  /**
   * chat episodic recall が同じ過去発言を閾値回数引いたときの「Codex に昇格
   * しますか？」候補 (柔→硬の橋渡し)。null = 提案なし。UI (ChatPanel) が観測して
   * 既存の抽出ダイアログを促す。自動書き込みはしない (recall-only)。
   */
  chatRecallPromoteSuggestion: RecallPromoteSuggestion | null;
  /**
   * プレビュー専用のプロンプト再構築（store は変更しない）。seed 優先順位:
   * registerInputDraftProvider 経由の入力ドラフト → 直近ユーザー発話 → シーン本文末尾。
   * 返す userMessage はプレビューに表示する「入力中の未送信テキスト」。
   * exact 構築に失敗した場合は live cache へフォールバックせず unavailable を返す。 */
  buildPreviewPrompt: () => Promise<ChatPromptPreviewResult>;
  /**
   * Monotonic counter bumped each time refreshContextLayers completes.
   * Subscribers (e.g. ContextBar's pinnedStickies list) can watch this to
   * pick up pins/unpins triggered from outside ChatPanel (Map / Codex).
   */
  pinsVersion: number;

  /** Phase 4 後続: ContextBar chip 表示用。projectOutline は trim 済みの空でない場合のみ。 */
  projectOutline: string | undefined;
  chapterOutlines: Array<{ title: string; outline: string }>;

  // G15: auto-detected and always-mode entries (excluding pinned)
  // (M10: listCodexEntriesForContext 由来の projection 行。icon/notes を持たない)
  detectedEntries: CodexContextEntry[];
  alwaysEntries: CodexContextEntry[];
  /**
   * codex/snippet スコープのアンカー (= この会話の主題)。ContextBar に固定チップ
   * として表示し、プロンプトの <focus_subject> 注入対象と一致させる。
   * scene/folder/project スコープでは null。refreshContextLayers が両分岐で
   * 必ず再設定するため、スコープ切替時に stale 化しない。
   */
  scopeAnchor:
    | { kind: "codex"; id: string; name: string }
    | { kind: "snippet"; id: string; title: string }
    | null;
  /**
   * Phase 3b: スレッド focus override（**非永続**）。設定すると chatScope を変えずに
   * effectiveSceneId を null へ落とし、当該スレッドの所属シーンを集約した body を
   * <focus_subject> として注入する。`chatScope` / `resolveScopeSessionKey` /
   * chat_sessions は一切触らない＝session 保存先は下地スコープのまま（migration ゼロ）。
   * スコープ/セッション/プロジェクト切替でクリアされる（leak 防止）。
   */
  threadFocusOverride: { threadId: string; title: string } | null;
  setThreadFocusOverride: (
    v: { threadId: string; title: string } | null,
  ) => void;
  clearThreadFocusOverride: () => void;
  /** ユーザーが × で auto 注入から除外したエントリ ID（セッション内のみ保持、
   * セッション切替・新規作成でクリア）。always 再収集のフィルタに使う。 */
  excludedAutoEntryIds: string[];

  // G21: input-typed entries detected by CodexHighlight (in-memory, pre-send)
  inputPinnedEntryIds: string[];
  setInputPinnedEntryIds: (ids: string[]) => void;

  // Session actions
  loadSessions: (
    nodeId?: string | null,
    codexAnchorId?: string | null,
    snippetAnchorId?: string | null,
  ) => Promise<boolean>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createNewSession: (
    projectId: string,
    title: string,
    nodeId?: string,
    codexAnchorId?: string,
    snippetAnchorId?: string,
  ) => Promise<void>;
  /**
   * 現在のシーン/グローバルモードに紐づくセッションを保証する。
   * 既存の activeSessionId があればそれを返し、無ければ DB に作成して
   * activeSessionId / sessions に反映してから id を返す。失敗時は null。
   */
  ensureSession: () => Promise<string | null>;
  deleteSession: (sessionId: string) => Promise<void>;
  /** Persist all admitted Chat work, then atomically clear this Project's history. */
  clearProjectChatHistory: (projectId: string) => Promise<void>;
  persistMessage: (role: MessageRole, content: string) => Promise<void>;
  /**
   * チャット A/B 比較で採用した応答を、現在のチャットセッションの会話履歴へ
   * 1 往復 (user 下書き + assistant 採用応答) として積む。clipboard コピーの
   * 置き換え。セッションが無ければ ensureSession で作成する。成功で true。
   */
  appendAdoptedAbTurn: (input: {
    /** 入力欄に書いていた下書き (user メッセージ本文)。 */
    userDraft: string;
    /** A/B 各構成へ実際に送った完全プロンプト (制作過程開示用スナップショット)。 */
    basePrompt: string;
    /** @scene メンションされたシーン id (user メッセージ metadata 用)。 */
    mentionedSceneIds: string[];
    /** 採用した側の応答本文 (assistant メッセージ本文)。 */
    assistantText: string;
    /** 採用した側の実モデル (未解決なら null)。 */
    model: string | null;
  }) => Promise<boolean>;

  // Agent mode
  agentMode: boolean;
  agentProgress: AgentLoopProgress | null;
  /**
   * run_research サブエージェントの進捗（子ループ実行中のみ非 null）。
   * AgentProgressBar が親の進捗の下にネスト表示する。
   */
  subAgentProgress: AgentLoopProgress | null;
  /**
   * 直近のエージェントターンがツール呼び出し/トークン上限で打ち切られたとき、
   * 「続行」ボタンを出すための状態。新しい予算でターンを再開できる。
   * 新規送信の冒頭でクリアする（ボタンは最新ターンに対してのみ出す）。
   */
  agentContinuation: { sessionId: string | null } | null;
  setAgentMode: (on: boolean) => void;
  /**
   * 「続行」: 上限で打ち切られたターンを新しい予算で再開する。
   * 直前の回答は会話履歴に残っているので、それを踏まえて残作業を継続する。
   */
  continueAgentRun: () => Promise<void>;

  // ask_user（ユーザーへの質問）— 回答待ち状態と解決アクション
  pendingUserQuestion: PendingUserQuestion | null;
  /** UI からの回答適用。session 不一致なら no-op。 */
  resolveUserQuestion: (answer: AskUserContent) => void;
  /** Skip（回答せず棄却）。dismissed sentinel で解決する。 */
  dismissUserQuestion: () => void;
  /** 内部: 全終了経路（Stop / セッション切替 / error）から pending を sentinel
   * 解決し、awaiting 中のループを確実に unblock する単一ファネル。 */
  _cancelPendingUserQuestion: () => void;

  /**
   * Web 検索 (RAG)。🌐 トグル。ON のターンはプロバイダのサーバサイド検索を
   * 注入する: OpenRouter は web plugin (Agent OFF) / server tool (Agent ON)、
   * Anthropic は native web_search。RAG ターンは agentMode に依らず構造化
   * (非ストリーミング) パスに通す (引用パースを1経路に集約)。
   * 対応外プロバイダ (ollama 等) では UI で非活性、送信時も isRagCapableProvider
   * で二重ガードする。
   */
  ragEnabled: boolean;
  setRagEnabled: (on: boolean) => void;

  // Chat scope — Scene / Folder (Chapter or Act) / Project / Codex / Snippet の5軸統一。
  // Globe トグルを置き換え、outline 階層に沿ってどこまで context に含めるかを
  // ユーザーが選択する。scope === "folder" のとき scopeAnchorId は対象 folder id。
  chatScope: ChatScope;
  scopeAnchorId: string | null;
  /**
   * scope を更新する。folder / codex / snippet スコープに切り替えるときは anchorId 必須。
   * scope 軸自体は sticky で、tree active scene の変動では動かない。
   * includeBodies は scope に応じてデフォルトにリセットされる。
   */
  setChatScope: (scope: ChatScope, anchorId?: string | null) => void;

  /**
   * Map overlay: アクティブな Map board 全体を L4 に注入するかどうか。
   * chatScope (scene/folder/project) と直交する独立トグル。
   *
   * `useMapBoardAutoActivate` フックが Map panel の可視状態と activeBoardId に
   * 追従させる: 可視+board 有りで ON、非可視/board 無しで OFF。手動 toggle は
   * 次の panel/board 変更で再同期される。
   */
  includeMapBoard: boolean;
  /** 注入対象の board id。null なら useMapStore.activeBoardId を解決 (送信時)。*/
  mapBoardId: string | null;
  setIncludeMapBoard: (
    on: boolean,
    options?: { source?: "user" | "auto"; boardId?: string | null },
  ) => void;

  /**
   * 本文を context に含めるか。トークン代の暴発を避けるための eco モード相当。
   * scope ごとのデフォルト: scene=true, folder=false, project=（影響なし）。
   * 折りたたみ tier の選択軸として refreshContextLayers が解釈する:
   *   - true & 閾値内 → Tier 1 (body 集約)
   *   - false または body 閾値超過 → Tier 2 (synopsis 集約)
   *   - synopsis 閾値も超過 → Tier 3 (outline only)
   */
  includeBodies: boolean;
  setIncludeBodies: (on: boolean) => void;

  // Existing actions
  sendMessage: (
    content: string,
    commandInstruction?: string,
    options?: {
      overrideAgentMode?: boolean;
      /** Chat 入力で `@シーン名` メンションされた scene ID 一覧。
       * 本メッセージの送信時のみ context へ scene 本文が pin される
       * (per-message surgical override)。folder/project スコープの eco
       * モードでも本文注入の対象になる。 */
      mentionedSceneIds?: string[];
      /** Chat 入力で `@人物名`(codex) メンションされた codex ID 一覧。
       * 作中年表スナップショットの人物プールへ最優先 seed として渡す。 */
      mentionedCodexIds?: string[];
      /** 再生成時に、新回答の永続化成功後だけ置換削除する旧回答ID。 */
      _replaceAssistantMessageId?: string;
      /** 429 リトライの内部カウンタ（外部呼び出しでは指定しない）。
       * 上限は MAX_RATE_LIMIT_RETRIES。 */
      _rateLimitRetry?: number;
      /** Internal UI handshake fired exactly when this draft is accepted. */
      _onAccepted?: () => void;
    },
  ) => Promise<void>;
  buildPromptForCopy: (
    userInput: string,
    options?: {
      mentionedSceneIds?: string[];
      mentionedCodexIds?: string[];
      commandInstruction?: string;
    },
  ) => Promise<string>;
  /** ChatInput の入力中テキスト getter を登録 / 解除(null で解除)。
   * buildPreviewPrompt が seed と表示に使う。 */
  registerInputDraftProvider: (
    provider:
      | (() => {
          markdown: string;
          mentionedSceneIds: string[];
          mentionedCodexIds: string[];
          commandInstruction?: string;
        })
      | null,
  ) => void;
  stopGeneration: () => void;
  deleteMessage: (messageId: string) => Promise<void>;
  editUserMessage: (messageId: string) => {
    content: string;
    /** メッセージ送信時に渡されていた @scene mention の scene id 群。
     * 編集 UI 復元時に TipTap doc 上で chip を再構築するために使う。 */
    mentionedSceneIds?: string[];
  };
  regenerate: (
    assistantMessageId: string,
    options?: { withAgentMode?: boolean },
  ) => Promise<void>;
  refreshContextLayers: (opts?: {
    /** Caller surface. Send/copy/preview must not be rebuilt as a live turn. */
    purpose?: ContextPlanningPurpose;
    /** Exact conversation snapshot for this turn; defaults to current store messages. */
    conversationMessages?: ChatMessage[];
    /** Current composer text used by turn-scoped recall and diagnostics. */
    outgoingUserMessage?: string;
    /** One-turn instruction captured with the same immutable request. */
    commandInstruction?: string;
    /** Fail the caller after clearing stale prompt state when planning fails. */
    strict?: boolean;
    /** Exact provider/tool framing reservation captured by send. */
    inputOverheadTokens?: number;
    /** Preview/copy retain the historic composer/history/scene-tail recall seed. */
    allowSceneRecallSeedFallback?: boolean;
    /** Only completed, authorized sends may advance recall promotion. */
    trackRecallPromote?: boolean;
    isAuthorized?: () => boolean;
    /** @scene mention 由来の一時 pin (per-send-only)。
     * UI 表示用の context bar 更新（プリビュー）には渡さず、sendMessage
     * 内部から folder/project スコープのプロンプト再構築時にだけ使う。 */
    mentionedSceneIds?: string[];
    /** @人物(codex) mention 由来の年表スナップショット人物 seed (per-send-only)。 */
    mentionedCodexIds?: string[];
    /**
     * 一回限りの Agent mode override（サジェストチップ / 再試行ボタン）。
     * 永続トグル get().agentMode と異なる agentMode で送信する経路から渡す。
     * project スコープの集約 tier（push vs pull）判定にこの値が効くため、
     * override 送信で lastSystemPrompt が永続トグル基準で組まれてしまうのを防ぐ。
     * 省略時は get().agentMode にフォールバック。 */
    agentModeOverride?: boolean;
    /** Internal immutable route for an in-flight send. */
    turnRoute?: ResolvedChatTurnRoute;
    /** Send-time privacy decision captured with the immutable route. */
    privacy?: ChatContextPreparationInput["privacy"];
    /** Send-time Web search decision used only for request usage projection. */
    ragActiveOverride?: boolean;
    /** Chat-owned immutable selectors captured before send's first await. */
    preparationSeed?: ChatContextTurnSeed;
    /** Opaque concrete Store snapshot owned by the application composition. */
    preparationSnapshot?: ChatContextPreparationSnapshot;
  }) => Promise<{
    prompt: string;
    totalTokens: number;
    layers: LayerBreakdown[];
    contextPlan: ChatContextPlan;
    cacheSegments?: string[];
    volatileTail?: string;
    fullyInjectedIds: string[];
    contextWindowUsage: ContextWindowUsage | null;
  } | null>;
  clearMessages: () => void;
  clearError: () => void;
  /** Drop all project-scoped chat/session state before another project is bound. */
  resetForProject: (projectId: string) => void;
  /** 「Codex に昇格」候補を却下する (再提案しない)。 */
  dismissChatRecallPromote: (messageId: string) => void;
  setActiveSceneId: (id: string) => void;
  setActiveProjectId: (id: string | null) => void;
  /** Editor Insert 後に in-memory metadata を同期 */
  syncInsertedToEditorMetadata: (messageId: string) => void;
  /** autoリストから特定エントリを即時除去（ピン直後のBug#1修正用） */
  removeEntryFromAuto: (entryId: string) => void;
  /** コンテキストバーの × による auto 注入からの除外。表示配列の除去に
   * 加えて excludedAutoEntryIds に記録する — always エントリは毎ビルドで
   * allEntries から無条件再収集されるため、表示除去だけでは次の refresh で
   * プロンプト・ピルとも復活する。 */
  /** Add a session auto-exclusion and report whether this call created it. */
  excludeEntryFromAuto: (
    entryId: string,
    options?: { refreshContext?: boolean },
  ) => boolean;
  /** auto 除外の解除（pin など、ユーザーがエントリを再び使い始めた経路で呼ぶ） */
  clearAutoExclusion: (entryId: string) => void;
  /** Codex anchor エントリ削除時に codex スコープを scene に戻す */
  onCodexAnchorDeleted: (entryId: string) => void;
  /** Snippet anchor 削除時に snippet スコープを scene に戻す */
  onSnippetAnchorDeleted: (snippetId: string) => void;

  /** C: エディタの「チャットで調べる」が pre-fill するテキスト（consumed-once） */
  pendingLookupText: string | null;
  setPendingLookupText: (text: string | null) => void;

  /** Progressive summarization: session summary stats for ContextBar warning */
  summaryCount: number;
  maxSummaryGeneration: number;

  /** Prefix cache rebuilt indicator (one turn or dismiss) */
  cacheInvalidatedReason: "model" | "instructions" | "budget" | null;
  invalidateContextCache: (reason: "model" | "instructions" | "budget") => void;
  dismissCacheInvalidated: () => void;
  /** Session-scoped Codex IDs present at session start (L4 cache marker) */
  sessionStableCodexIds: string[];
  sessionStableContextInitialized: boolean;
  /** Immutable agent tool snapshot for the active session */
  sessionAgentToolsSnapshot: AgentToolDefinition[] | null;
  /** Start a new session while keeping reference to the current one */
  createLinkedSession: () => Promise<void>;
  _lastCachedModel: string | null;
}
