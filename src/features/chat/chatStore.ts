import { create } from "zustand";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import * as chatApi from "./chatApi";
import { debugLog, errorDetail } from "@/lib/debugLog";

// ---------------------------------------------------------------------------
// D-17: Error classification and retry helpers
// ---------------------------------------------------------------------------

function classifyError(
  e: unknown,
): "auth" | "rate_limit" | "network" | "context_length" | "unknown" {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized|authentication|api\.key|invalid\.key/i.test(msg))
    return "auth";
  if (/429|rate.?limit|too.?many.?request/i.test(msg)) return "rate_limit";
  if (/network|connect|timeout|fetch|ECONNREFUSED/i.test(msg)) return "network";
  if (
    /context.length.exceeded|maximum.context|token.limit|too.long|content.too.large/i.test(
      msg,
    )
  )
    return "context_length";
  return "unknown";
}

import {
  buildSystemPrompt,
  buildStorySoFar,
  countTokens,
  allocateLayerBudgets,
  ensureTokenizer,
} from "./contextBuilder";
import type {
  SceneContext,
  ProjectContext,
  CodexContext,
  LayerBreakdown,
  NoteContext,
} from "./contextBuilder";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { fetchProjectContext as fetchProjectContextAtom } from "@/features/project/contextAtoms";
import { runAgentLoop } from "./agent/agentLoop";
import { executeTool } from "./agent/toolExecutors";
import { snapshotAgentTools } from "./agent/toolDefinitions";
import {
  buildAskUserResult,
  dismissedAskUserResult,
  invalidAskUserResult,
  normalizeAskUserSpec,
} from "./agent/askUser";
import {
  getToolTokenBudget,
  buildThinkingParams,
  getEffortForTask,
  resolveModelCapabilities,
} from "./agent/modelLimits";
import { useAiSettingsStore, isRagCapableProvider } from "./store";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { sanitizeCitations, findUnbackedUrls } from "./citationVerify";
import { stripToolProtocol } from "./toolProtocol";
import { isHermesProtocol } from "./toolProtocolParse";
import {
  buildWebSearchConfig,
  parseWebSearchControls,
} from "./webSearchConfig";
import * as cliApi from "./cliApi";
import { resolveAinoveristApiVariant } from "./aiNovelist";

function getChatApiVariant(model: string): string | undefined {
  const { settings, models } = useAiSettingsStore.getState();
  return resolveAinoveristApiVariant(model, models, settings?.modelApiVariant);
}

/**
 * 会話履歴を CLI に渡す単一プロンプトに平坦化する。
 * CLI (claude -p / codex exec / opencode run) は単一プロンプト引数しか
 * 受け付けないため、role タグ付きで連結する。
 */
function flattenMessagesForCli(
  messages: { role: string; content: string }[],
): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}
import type {
  AgentMessagePayload,
  ToolCallRecord,
  AgentLoopProgress,
  AgentToolDefinition,
  AskUserContent,
  AskUserSpec,
  ToolResult,
  WebSearchConfig,
} from "./agent/agentTypes";

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
import {
  useTreeStore,
  getAncestorFolders,
  getAllProjectScenesInOrder,
  getDescendantScenesInOrder,
} from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { loadSceneContent, loadScenesFull, getNode } from "@/features/tree/api";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { prosemirrorToText } from "@/lib/prosemirror";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { listCodexEntries } from "@/features/codex/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import { markStart, markEnd } from "@/lib/perfLog";
import {
  getDescendantsBFS,
  getChildrenFromArray,
  buildChildrenContext,
  computeChildrenTokenBudget,
} from "@/features/codex/childrenBudget";
import type { ChatMessage, ChatSession, MessageRole } from "./chatTypes";
import {
  shouldSummarize,
  selectSummarizationCandidates,
  runSummarization,
  getPreviousSummaryText,
  estimateSummaryTokenCount,
} from "./summarization";
import { computeL5UsedTokens } from "./conversationHistory";
import type { CodexEntry } from "@/features/codex/api";
import {
  listContextDetailsByEntryIds,
  listRawDetailValuesByEntryIds,
} from "@/features/codex/detailApi";
import {
  listPhasesByEntryIds,
  listDetailOverridesByPhaseIds,
} from "@/features/codex/phaseApi";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import { resolveCodexState } from "@/features/codex/phaseResolver";
import type { ResolvedCodexState } from "@/features/codex/phaseResolver";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTabStore } from "@/features/editor/tabStore";
import { getSnippet } from "@/features/snippets/api";
import { listPinnedSnippetEntries, listPinnedStickyEntries } from "./chatApi";
import { useMapStore } from "@/features/map/mapStore";
import {
  listStickies as listMapStickies,
  listUserEdges as listMapUserEdges,
  listFrames as listMapFrames,
  listNodePositions as listMapNodePositions,
  listAiBranches as listMapAiBranches,
  getMapBoard,
} from "@/features/map/mapApi";
import { buildMapContextMarkdown } from "@/features/map/mapToContextPrompt";
import type { ResolvedLabel } from "@/features/map/mapToContextPrompt";
import type {
  PinnedSnippetContext,
  PinnedStickyContext,
} from "./contextBuilder";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { buildPendingBeatsSection } from "@/features/editor/beat/pendingBeatsContext";
import { getPromptCatalog } from "@/prompts/index";
import {
  getSceneForeshadowContext,
  listOpenForeshadowsForContext,
} from "@/features/foreshadow/api";
import { listNodeLabels } from "@/features/labels/labelApi";
import { listCodexRelations } from "@/features/codex/codexRelationApi";
import { expandCodexRelationsBFS } from "@/features/codex/relationExpansion";

// フェーズ解決ヘルパー: エントリ配列に対してフェーズを一括解決する
async function resolveEntriesForContext(
  entries: CodexEntry[],
  effectiveSceneId: string | null,
): Promise<{
  resolved: Map<string, ResolvedCodexState>;
  phases: Map<string, CodexEntryPhase[]>;
}> {
  const resolved = new Map<string, ResolvedCodexState>();
  const phasesMap = new Map<string, CodexEntryPhase[]>();

  if (entries.length === 0) return { resolved, phases: phasesMap };

  const entryIds = entries.map((e) => e.id);

  // フェーズと上書き情報を一括取得
  const allPhases = await listPhasesByEntryIds(entryIds);
  const phaseIds = allPhases.map((p) => p.id);
  const allOverrides = await listDetailOverridesByPhaseIds(phaseIds);

  // phaseId → overrides マップ
  const overridesByPhase = new Map<
    string,
    import("@/features/codex/phaseApi").CodexPhaseDetailOverride[]
  >();
  for (const ov of allOverrides) {
    const arr = overridesByPhase.get(ov.phaseId) ?? [];
    arr.push(ov);
    overridesByPhase.set(ov.phaseId, arr);
  }

  // entryId → phases マップ
  const phasesByEntry = new Map<string, CodexEntryPhase[]>();
  for (const phase of allPhases) {
    const arr = phasesByEntry.get(phase.entryId) ?? [];
    arr.push(phase);
    phasesByEntry.set(phase.entryId, arr);
  }

  // ベースdetailValues取得 (definitionId → value)
  const rawDetails = await listRawDetailValuesByEntryIds(entryIds);
  const detailsByEntry = new Map<string, Map<string, string | null>>();
  for (const row of rawDetails) {
    const m =
      detailsByEntry.get(row.entryId) ?? new Map<string, string | null>();
    m.set(row.definitionId, row.value);
    detailsByEntry.set(row.entryId, m);
  }

  const globalSceneOrder = usePhaseStore.getState().globalSceneOrder;

  for (const entry of entries) {
    const phases = phasesByEntry.get(entry.id) ?? [];
    phasesMap.set(entry.id, phases);

    const phaseDetailsMap = new Map<
      string,
      import("@/features/codex/phaseApi").CodexPhaseDetailOverride[]
    >();
    for (const phase of phases) {
      phaseDetailsMap.set(phase.id, overridesByPhase.get(phase.id) ?? []);
    }

    const baseDetails =
      detailsByEntry.get(entry.id) ?? new Map<string, string | null>();

    resolved.set(
      entry.id,
      resolveCodexState(
        {
          summary: entry.summary ?? null,
          content: entry.content,
          contextMode: entry.contextMode,
        },
        phases,
        phaseDetailsMap,
        baseDetails,
        effectiveSceneId,
        globalSceneOrder,
      ),
    );
  }

  return { resolved, phases: phasesMap };
}

/**
 * codex_entries.aliases (JSON 配列) を string[] に展開する。
 * パース失敗 / 空配列は undefined を返し、L4 注入時に行を生やさない。
 */
function parseAliases(json: string | null | undefined): string[] | undefined {
  if (!json) return undefined;
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.filter((v): v is string => typeof v === "string");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * codex_entries.tags_cache (JSON 配列) を tag 名の string[] に展開する。
 *
 * 実態として 2 種類の形式が観測される:
 *   A) `["tag1", "tag2"]` — 旧スキーマ comment 通りの素の string[]
 *   B) `[{"name":"tag1","color":null}, ...]` — `tagApi.setEntryTags` の実装。
 *      色情報を一覧表示で使うために object 配列を書き込んでいる。
 * どちらの形式でも tag 名だけを抜き出して返す。
 *
 * Spotlight エントリにのみ詰めて注入する想定。auto-detected には含めない
 * （L4 の render 側で `pinnedIds.has()` ゲートにより無害化されるが、
 * 不要なデータ流通を避ける目的でも builder 側で分岐する）。
 */
function parseTags(json: string | null | undefined): string[] | undefined {
  if (!json) return undefined;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const names = arr
      .map((v): string | undefined => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object" && "name" in v) {
          const name = (v as { name: unknown }).name;
          return typeof name === "string" ? name : undefined;
        }
        return undefined;
      })
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined;
  }
}

// G14: Enrich CodexContext array with customDetails (batch query, no N+1)
// PinnedCodexContext extends CodexContext なので、ジェネリックで両方扱える。
async function enrichWithCustomDetails<T extends CodexContext>(
  entries: T[],
  allEntries: CodexEntry[],
): Promise<T[]> {
  if (entries.length === 0) return entries;
  const entryIds = entries.map((e) => e.id);
  const details = await listContextDetailsByEntryIds(entryIds);

  // Group by entryId
  const byEntryId = new Map<
    string,
    Array<{ fieldName: string; value: string }>
  >();
  for (const d of details) {
    if (d.value == null) continue;
    let resolved = d.value;
    // codex_reference: resolve entry ID → name
    if (d.fieldType === "codex_reference") {
      const ref = allEntries.find((e) => e.id === d.value);
      resolved = ref ? ref.name : d.value;
    }
    const arr = byEntryId.get(d.entryId) ?? [];
    arr.push({ fieldName: d.fieldName, value: resolved });
    byEntryId.set(d.entryId, arr);
  }

  return entries.map((entry) => {
    const customDetails = byEntryId.get(entry.id);
    return customDetails?.length ? { ...entry, customDetails } : entry;
  });
}

// Helper: compute childrenContext for pinned/G21 entries based on childrenBudget
function buildChildrenCtxForEntry(
  entry: CodexEntry,
  allEntries: CodexEntry[],
  l4Budget: number,
  excludeIds?: Set<string>,
): string | undefined {
  const preset = entry.childrenBudget ?? "compact";
  if (preset === "none") return undefined;
  const budget = computeChildrenTokenBudget(preset, l4Budget);
  const descendants = getDescendantsBFS(entry.id, allEntries).filter(
    (d) => !excludeIds?.has(d.id),
  );
  return buildChildrenContext(descendants, budget) || undefined;
}

interface ChatState {
  // Session management
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoadingSessions: boolean;
  isLoadingMessages: boolean;

  // Messages & streaming
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  activeSceneId: string;
  activeProjectId: string | null;
  contextTokenCount: number;
  contextLayers: LayerBreakdown[];
  lastSystemPrompt: string;
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
  detectedEntries: CodexEntry[];
  alwaysEntries: CodexEntry[];

  // G21: input-typed entries detected by CodexHighlight (in-memory, pre-send)
  inputPinnedEntryIds: string[];
  setInputPinnedEntryIds: (ids: string[]) => void;

  // Session actions
  loadSessions: (nodeId?: string | null) => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createNewSession: (
    projectId: string,
    title: string,
    nodeId?: string,
  ) => Promise<void>;
  /**
   * 現在のシーン/グローバルモードに紐づくセッションを保証する。
   * 既存の activeSessionId があればそれを返し、無ければ DB に作成して
   * activeSessionId / sessions に反映してから id を返す。失敗時は null。
   */
  ensureSession: () => Promise<string | null>;
  deleteSession: (sessionId: string) => Promise<void>;
  persistMessage: (role: MessageRole, content: string) => Promise<void>;

  // Agent mode
  agentMode: boolean;
  agentProgress: AgentLoopProgress | null;
  setAgentMode: (on: boolean) => void;

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
  /** 進行中ターンが Web 検索を実行中か (UI の「検索中…」表示用、内部 transient)。 */
  ragSearching: boolean;

  // Chat scope — Scene / Folder (Chapter or Act) / Project の3軸統一。
  // Globe トグルを置き換え、outline 階層に沿ってどこまで context に含めるかを
  // ユーザーが選択する。scope === "folder" のとき scopeAnchorId は対象 folder id。
  chatScope: "scene" | "folder" | "project";
  scopeAnchorId: string | null;
  /**
   * scope を更新する。folder スコープに切り替えるときは anchorId 必須。
   * scope 軸自体は sticky で、tree active scene の変動では動かない。
   * includeBodies は scope に応じてデフォルトにリセットされる。
   */
  setChatScope: (
    scope: "scene" | "folder" | "project",
    anchorId?: string | null,
  ) => void;

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
    },
  ) => Promise<void>;
  buildPromptForCopy: (
    userInput: string,
    options?: { mentionedSceneIds?: string[] },
  ) => Promise<string>;
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
    /** @scene mention 由来の一時 pin (per-send-only)。
     * UI 表示用の context bar 更新（プリビュー）には渡さず、sendMessage
     * 内部から folder/project スコープのプロンプト再構築時にだけ使う。 */
    mentionedSceneIds?: string[];
    /**
     * 一回限りの Agent mode override（サジェストチップ / 再試行ボタン）。
     * 永続トグル get().agentMode と異なる agentMode で送信する経路から渡す。
     * project スコープの集約 tier（push vs pull）判定にこの値が効くため、
     * override 送信で lastSystemPrompt が永続トグル基準で組まれてしまうのを防ぐ。
     * 省略時は get().agentMode にフォールバック。 */
    agentModeOverride?: boolean;
  }) => Promise<void>;
  clearMessages: () => void;
  clearError: () => void;
  setActiveSceneId: (id: string) => void;
  setActiveProjectId: (id: string | null) => void;
  /** Editor Insert 後に in-memory metadata を同期 */
  syncInsertedToEditorMetadata: (messageId: string) => void;
  /** G20: stores old message content when editing, to detect removed @mentions */
  _editingOldContent: string | null;
  /** autoリストから特定エントリを即時除去（ピン直後のBug#1修正用） */
  removeEntryFromAuto: (entryId: string) => void;

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
  /** Immutable agent tool snapshot for the active session */
  sessionAgentToolsSnapshot: AgentToolDefinition[] | null;
  /** Start a new session while keeping reference to the current one */
  createLinkedSession: () => Promise<void>;
  _lastCachedModel: string | null;
}

/**
 * user メッセージの `metadata` 文字列 (JSON) から `mentioned_scene_ids`
 * を取り出すヘルパー。regenerate 経路で per-message pin を復元するために
 * 使う。JSON parse 失敗・配列でない・空配列はすべて undefined を返す。
 */
function parseMentionedSceneIdsFromMetadata(
  metadata: string | null | undefined,
): string[] | undefined {
  if (!metadata) return undefined;
  try {
    const obj = JSON.parse(metadata) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const ids = (obj as Record<string, unknown>).mentioned_scene_ids;
      if (Array.isArray(ids)) {
        const filtered = ids.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        return filtered.length > 0 ? filtered : undefined;
      }
    }
  } catch {
    // JSON parse 失敗は単に未指定として扱う
  }
  return undefined;
}

/** L4 append-only: preserve first-appearance order, tie-break by entry_id. */
function stableSortCodexEntries<T extends { id: string }>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const idCmp = a.entry.id.localeCompare(b.entry.id);
      return idCmp !== 0 ? idCmp : a.index - b.index;
    })
    .map(({ entry }) => entry);
}

async function maybeRunSummarization(
  sessionId: string,
  messages: ChatMessage[],
  l5Budget: number,
  lang: string,
  set: (
    partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
  ) => void,
): Promise<ChatMessage[]> {
  await ensureTokenizer();
  let summaries: Awaited<ReturnType<typeof chatApi.listSummaries>> = [];
  try {
    summaries = await chatApi.listSummaries(sessionId);
  } catch {
    return messages;
  }

  const summaryTexts = summaries.map((s) => s.summary);
  const l5Used = computeL5UsedTokens(messages, summaryTexts, l5Budget);
  const maxGen =
    summaries.length > 0 ? Math.max(...summaries.map((s) => s.generation)) : 0;

  set({
    summaryCount: summaries.length,
    maxSummaryGeneration: maxGen,
  });

  if (!shouldSummarize(messages, l5Budget, l5Used)) {
    return messages;
  }

  const candidates = selectSummarizationCandidates(messages, l5Budget);
  if (candidates.length === 0) return messages;

  try {
    const generation = await chatApi.getSummaryGeneration(sessionId);
    const previousSummary = getPreviousSummaryText(summaries);
    const candidateIds = candidates.map((m) => m.id);
    const lastMsgId = candidateIds[candidateIds.length - 1]!;

    const summaryText = await runSummarization(
      candidates,
      chatApi.sendChatMessageWithThinking,
      {
        lang,
        previousSummary,
        generation,
        sourceMsgCount: candidates.length,
        lastMsgId,
      },
    );

    const tokenCount = estimateSummaryTokenCount(summaryText);
    const chatSummary = await chatApi.addSummary(
      sessionId,
      summaryText,
      candidateIds,
      {
        tokenCount,
        generation,
        sourceMsgCount: candidates.length,
        lastMsgId,
      },
    );
    await chatApi.markMessagesSummarized(candidateIds);

    let resultMessages = messages;
    set((s) => {
      const updatedMessages = s.messages.map((m) =>
        candidateIds.includes(m.id) ? { ...m, isSummarized: 1 } : m,
      );
      const summaryMarkerMsg: ChatMessage = {
        id: `summary-${chatSummary.id}`,
        sessionId,
        role: "assistant",
        content: summaryText,
        metadata: JSON.stringify({ summary_id: chatSummary.id }),
        createdAt: chatSummary.createdAt,
        isSummarized: 0,
      };
      const lastCandidateIdx = updatedMessages.reduce(
        (acc, m, idx) => (candidateIds.includes(m.id) ? idx : acc),
        -1,
      );
      resultMessages = [
        ...updatedMessages.slice(0, lastCandidateIdx + 1),
        summaryMarkerMsg,
        ...updatedMessages.slice(lastCandidateIdx + 1),
      ];
      return {
        messages: resultMessages,
        summaryCount: summaries.length + 1,
        maxSummaryGeneration: generation,
      };
    });

    return resultMessages;
  } catch (e) {
    debugLog.error("ChatStore", "summarization", errorDetail(e));
    return messages;
  }
}

/**
 * `@シーン名` メンションで per-message pin される scene の本文をまとめて
 * 読み込むヘルパー。tree store から title を引いてから loadSceneContent
 * で本文を取り、prosemirrorToText で plain text 化する。
 *
 * - currentSceneId と一致する id は除外（buildSystemPrompt 側でも除外しているが、
 *   loadSceneContent の二重呼び出しを避けるためここでも省く）。
 * - 存在しない id・scene 以外の id・読み込み失敗は単に黙って除外する
 *   (一時 pin の性質上、エラーで送信を止めない方が望ましい)。
 */
async function loadMentionedScenes(
  ids: string[] | undefined,
  currentSceneId: string | null,
): Promise<Array<{ id: string; title: string; content: string }>> {
  if (!ids || ids.length === 0) return [];
  const allNodes = useTreeStore.getState().nodes;
  const out: Array<{ id: string; title: string; content: string }> = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (currentSceneId && id === currentSceneId) continue;
    const node = allNodes.find((n) => n.id === id);
    if (!node || node.nodeType !== "scene") continue;
    try {
      const raw = await loadSceneContent(id);
      const text = prosemirrorToText(raw ?? "");
      if (text) {
        out.push({ id, title: node.title, content: text });
      }
    } catch {
      // 取得失敗は除外 (送信を止めない)
    }
  }
  return out;
}

async function fetchSceneContext(
  sceneId: string,
): Promise<SceneContext | null> {
  try {
    const [node, content] = await Promise.all([
      getNode(sceneId),
      loadSceneContent(sceneId),
    ]);
    if (!node) return null;
    return {
      id: node.id,
      title: node.title,
      synopsis: node.synopsis ?? undefined,
      content: prosemirrorToText(content ?? ""),
      contentJson: content ?? "",
      storyTimeLabel: node.storyTimeLabel ?? null,
    };
  } catch {
    return null;
  }
}

// fetchProjectContext は features/project/contextAtoms に切り出して
// Map AI Branch と共有。chatStore 側はラッパーで既存 callsite を維持。
async function fetchProjectContext(
  projectId: string | null,
): Promise<ProjectContext | null> {
  return fetchProjectContextAtom(projectId);
}

type AggregatedPrefacePolicy = "folder" | "project";

function buildChildrenByParentIndex(
  nodes: TreeNodeData[],
): Map<string | null, TreeNodeData[]> {
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const n of nodes) {
    const key = n.parentId;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(n);
    childrenByParent.set(key, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  }
  return childrenByParent;
}

function formatAggregatedFolderSection(folder: TreeNodeData): string {
  const header = `=== ${folder.title} ===`;
  const outline = folder.synopsis?.trim();
  return outline
    ? `${header}\nOutline: ${outline}`
    : `${header}\n(outline 未記入)`;
}

function formatAggregatedSceneSynopsis(
  scene: TreeNodeData,
  activeSceneId: string | null,
  beatSection?: string,
): string {
  const synopsis = scene.synopsis?.trim();
  const isActive = scene.id === activeSceneId;
  const header = `--- ${scene.title}${isActive ? " [current edit]" : ""} ---`;
  const base = synopsis
    ? `${header}\nSynopsis: ${synopsis}`
    : `${header}\n(synopsis 未記入)`;
  const beats = beatSection?.trim();
  return beats ? `${base}\n${beats}` : base;
}

function formatAggregatedSceneWithBody(
  scene: TreeNodeData,
  body: string,
  activeSceneId: string | null,
): string {
  const synopsis = scene.synopsis?.trim();
  const isActive = scene.id === activeSceneId;
  const header = `--- ${scene.title}${isActive ? " [current edit]" : ""} ---`;
  const synopsisLine = synopsis ? `Synopsis: ${synopsis}\n\n` : "";
  return `${header}\n${synopsisLine}${body}`;
}

function formatTopLevelScenesSection(
  scenes: TreeNodeData[],
  activeSceneId: string | null,
): string {
  const header = `=== (top level) ===`;
  const lines = scenes.map((s) => {
    const isActive = s.id === activeSceneId;
    return `- ${s.title}${isActive ? " [current edit]" : ""}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

/** project スコープ: フォルダ見出し + 配下シーンを DFS (sortOrder) で組み立てる。 */
function appendProjectGroupedParts(
  parentId: string | null,
  childrenByParent: Map<string | null, TreeNodeData[]>,
  guard: Set<string>,
  parts: string[],
  mode: "tier1" | "tier2" | "foldersOnly",
  activeSceneId: string | null,
  bodyBySceneId: Map<string, string>,
  beatSectionBySceneId: Map<string, string>,
): void {
  const kids = childrenByParent.get(parentId) ?? [];

  // foldersOnly では nested scene は親 folder の outline で代表されるが、
  // top-level (parentId === null) の scene には親 folder が無く情報が消える。
  // 擬似グループ `=== (top level) ===` で title 行のみ救済する。
  //
  // 仕様 (意図的な簡略化): この救済セクションは同階層のフォルダ群より「前」に
  // 一括で出すため、top-level scene と folder が混在する場合、top-level scene は
  // sortOrder 上の位置ではなく先頭にまとまり reading order から逸脱する。これは
  // foldersOnly (>200 シーンの overflow 時のみの title-only 表示) でしか起きず影響が
  // 小さい一方、sortOrder 位置へのインライン展開は Tier 3 出力構造の変更でリスク>益。
  // よってこの逸脱は許容する (回帰ではなく仕様)。
  if (parentId === null && mode === "foldersOnly") {
    const topLevelScenes = kids.filter((n) => n.nodeType === "scene");
    if (topLevelScenes.length > 0) {
      parts.push(formatTopLevelScenesSection(topLevelScenes, activeSceneId));
    }
  }

  for (const n of kids) {
    if (n.nodeType === "scene") {
      if (mode === "foldersOnly") continue;
      if (mode === "tier1") {
        parts.push(
          formatAggregatedSceneWithBody(
            n,
            (bodyBySceneId.get(n.id) ?? "").trim(),
            activeSceneId,
          ),
        );
      } else {
        parts.push(
          formatAggregatedSceneSynopsis(
            n,
            activeSceneId,
            beatSectionBySceneId.get(n.id),
          ),
        );
      }
    } else if (n.nodeType === "folder") {
      if (guard.has(n.id)) continue;
      guard.add(n.id);
      parts.push(formatAggregatedFolderSection(n));
      appendProjectGroupedParts(
        n.id,
        childrenByParent,
        guard,
        parts,
        mode,
        activeSceneId,
        bodyBySceneId,
        beatSectionBySceneId,
      );
    }
  }
}

/** folder / project スコープ共通の Tier 1/2 synopsis・本文集約。 */
async function buildAggregatedScene(opts: {
  anchorId: string;
  anchorTitle: string;
  descendants: TreeNodeData[];
  includeBodies: boolean;
  activeSceneId: string | null;
  prefacePolicy: AggregatedPrefacePolicy;
  allEntries: CodexEntry[];
  /** project スコープのフォルダ階層グループ化に必須 */
  allNodes?: TreeNodeData[];
  /**
   * Agent mode（Tool Use ループ）か。project スコープでは ON のとき
   * synopsis 集約（Tier 2）を pull 委譲に切り替える: 事前注入は folder
   * outline のみ（foldersOnly）に落とし、各シーンの synopsis / 本文は
   * agent が get_chapter_summaries / get_scene / search_scenes で必要時だけ
   * 取得する前提にする。クエリ無関係の全 synopsis ダンプを避けるのが目的。
   */
  agentMode: boolean;
}): Promise<{
  aggregatedScene: { id: string; title: string; content: string };
  aggregatedDetected: CodexEntry[];
} | null> {
  const MAX_BODY_TIER_SCENES = 30;
  const MAX_BODY_TIER_CHARS = 100_000;
  const MAX_SYNOPSIS_TIER_SCENES = 200;
  const LOAD_CHUNK = 8;

  const {
    anchorId,
    anchorTitle,
    descendants,
    includeBodies,
    activeSceneId,
    prefacePolicy,
    allEntries,
    allNodes,
    agentMode,
  } = opts;

  const isProjectGrouped = prefacePolicy === "project" && !!allNodes?.length;
  const hasScenes = descendants.length > 0;

  if (!hasScenes && !isProjectGrouped) return null;

  // Agent mode の project スコープでは synopsis を push せず pull に委譲する。
  // foldersOnly（Tier 3 相当の outline のみ）へ落とし、agent に取得ツールを案内する。
  const agentPullProject = agentMode && isProjectGrouped;

  const totalChars = descendants.reduce(
    (sum, s) => sum + (s.charCount ?? 0),
    0,
  );
  // Tier 1（本文集約）は agent mode でも維持する: includeBodies=true は
  // ユーザーが小規模プロジェクトで明示的に本文を要求した操作なので尊重する
  // （その規模なら本文を入れても安価）。pull 委譲は Tier 2 のみに適用する。
  const canTier1 =
    hasScenes &&
    includeBodies &&
    descendants.length <= MAX_BODY_TIER_SCENES &&
    totalChars <= MAX_BODY_TIER_CHARS;
  const canTier2 =
    hasScenes &&
    descendants.length <= MAX_SYNOPSIS_TIER_SCENES &&
    !agentPullProject;

  const tier1Preface =
    prefacePolicy === "folder"
      ? `[この章「${anchorTitle}」配下のシーンを reading order (sortOrder) で集約しています。各シーンは「--- {タイトル} ---」区切りで列挙され、Synopsis 行があるシーンはその要約、[current edit] マーカー付きが現在編集中のシーンです]`
      : `[このプロジェクト「${anchorTitle}」の全シーンをフォルダ階層（=== フォルダ名 ===）ごとに集約しています。フォルダ見出しの Outline は各フォルダの synopsis、配下シーンは「--- {タイトル} ---」区切りで reading order に並び、[current edit] マーカー付きが現在編集中のシーンです]`;

  // Tier 2 は (a) eco モード (includeBodies=false) と (b) 本文集約の上限超過
  // (includeBodies=true だが descendants.length > MAX_BODY_TIER_SCENES または
  // totalChars > MAX_BODY_TIER_CHARS) の両方で到達する。(b) を「eco モード」と
  // 表示するとユーザーがトグルを OFF にしても eco 表記が消えず誤解を招くため、
  // 原因に応じて注記を切り替える (tier3ProjectPreface と同じ方針)。上限超過は
  // シーン数 OR 文字数のどちらでも起きるので、原因はシーン数に限定せず中立に書く。
  const tier2BodyNote = includeBodies
    ? "シーン数または総文字数が本文集約の上限を超えたため、本文は注入されていません"
    : "eco モード: 本文は注入されていません";

  const tier2Preface =
    prefacePolicy === "folder"
      ? `[この章「${anchorTitle}」配下のシーンを synopsis 単位で集約しています（${tier2BodyNote}）。各シーンは「--- {タイトル} ---」区切りで reading order に並んでおり、[current edit] マーカー付きが現在編集中のシーンです]`
      : `[このプロジェクト「${anchorTitle}」の全シーンをフォルダ階層（=== フォルダ名 ===）ごとに synopsis 単位で集約しています（${tier2BodyNote}）。フォルダ見出しの Outline は各フォルダの synopsis、配下シーンは「--- {タイトル} ---」区切りです]`;

  // Tier 3 (foldersOnly) は「agent mode の pull 委譲」「シーン多すぎ overflow」
  // 「シーン 0 のフォルダのみプロジェクト」の 3 通りで到達する。原因ごとに preface を
  // 切り替える: overflow で「シーン数が多いため」を出すと scene 0 や agent pull に
  // 誤情報を渡すため。agent pull のときは「省略」ではなく「ツールで取得せよ」と案内する。
  const tier3ProjectPreface = agentPullProject
    ? `[このプロジェクト「${anchorTitle}」のフォルダ階層 Outline（=== フォルダ名 ===）のみを事前注入しています。個別シーンの synopsis / 本文はトークン節約のため事前注入していません。必要に応じて get_chapter_summaries（全シーンのあらすじ一覧）、list_chapters（章・シーン構成）、search_scenes（本文横断検索）、get_scene（個別シーンの本文）で取得してください]`
    : descendants.length === 0
      ? `[このプロジェクト「${anchorTitle}」のフォルダ階層の Outline（=== フォルダ名 ===）を注入しています。シーンはまだ作成されていません]`
      : `[このプロジェクト「${anchorTitle}」はシーン数が多いため、フォルダ階層の Outline のみを注入しています（=== フォルダ名 ===）。個別シーンの synopsis / 本文は省略されています]`;

  async function detectFromJoined(joined: string): Promise<CodexEntry[]> {
    try {
      const detectable = allEntries.filter(
        (e) => e.contextMode !== "hidden" && e.contextMode !== "suppress",
      );
      const matched = await findMentionedEntriesAsync(joined, detectable);
      const matchedIds = new Set(matched.map((m) => m.id));
      return detectable.filter((e) => matchedIds.has(e.id));
    } catch {
      return [];
    }
  }

  function buildProjectParts(
    mode: "tier1" | "tier2" | "foldersOnly",
    bodyBySceneId: Map<string, string>,
    beatSectionBySceneId: Map<string, string>,
  ): string[] {
    const parts: string[] = [];
    const childrenByParent = buildChildrenByParentIndex(allNodes!);
    appendProjectGroupedParts(
      null,
      childrenByParent,
      new Set<string>(),
      parts,
      mode,
      activeSceneId,
      bodyBySceneId,
      beatSectionBySceneId,
    );
    return parts;
  }

  if (canTier1) {
    // 1 scene のロード失敗が aggregate 全体を破棄しないよう、各 scene を
    // 個別 try/catch で safe load する（失敗時は空文字扱い）。
    const safeLoadSceneText = async (sceneId: string): Promise<string> => {
      try {
        return prosemirrorToText((await loadSceneContent(sceneId)) ?? "");
      } catch (e) {
        debugLog.warn(
          "ChatStore",
          `loadSceneContent failed in aggregate (sceneId=${sceneId})`,
          errorDetail(e),
        );
        return "";
      }
    };

    if (isProjectGrouped) {
      const bodyBySceneId = new Map<string, string>();
      for (let i = 0; i < descendants.length; i += LOAD_CHUNK) {
        const slice = descendants.slice(i, i + LOAD_CHUNK);
        const loaded = await Promise.all(
          slice.map((s) => safeLoadSceneText(s.id)),
        );
        for (let j = 0; j < slice.length; j++) {
          bodyBySceneId.set(slice[j].id, loaded[j] ?? "");
        }
      }
      const parts = buildProjectParts("tier1", bodyBySceneId, new Map());
      if (parts.length === 0) return null;
      const joined = `${tier1Preface}\n\n${parts.join("\n\n")}`;
      const aggregatedDetected = await detectFromJoined(joined);
      return {
        aggregatedScene: {
          id: anchorId,
          title: anchorTitle,
          content: joined,
        },
        aggregatedDetected,
      };
    }

    const ordered = descendants;
    const bodies: string[] = new Array(ordered.length);
    for (let i = 0; i < ordered.length; i += LOAD_CHUNK) {
      const slice = ordered.slice(i, i + LOAD_CHUNK);
      const loaded = await Promise.all(
        slice.map((s) => safeLoadSceneText(s.id)),
      );
      for (let j = 0; j < slice.length; j++) {
        bodies[i + j] = loaded[j];
      }
    }
    const parts: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
      parts.push(
        formatAggregatedSceneWithBody(
          ordered[i],
          (bodies[i] ?? "").trim(),
          activeSceneId,
        ),
      );
    }
    const joined = `${tier1Preface}\n\n${parts.join("\n\n")}`;
    const aggregatedDetected = await detectFromJoined(joined);
    return {
      aggregatedScene: {
        id: anchorId,
        title: anchorTitle,
        content: joined,
      },
      aggregatedDetected,
    };
  }

  if (canTier2) {
    const injectBeats = useSettingsStore
      .getState()
      .getBoolean("beat.injectIntoContext", true);

    const beatSectionBySceneId = new Map<string, string>();
    if (injectBeats && descendants.length > 0) {
      const resolveCharacterName = (id: string): string | null =>
        allEntries.find((e) => e.id === id)?.name ?? null;

      // 旧実装は scene ごとに loadSceneFull を呼び、descendant 数だけ IPC 往復
      // (各 ~150ms の drizzle microtask + Mutex<Connection> 直列) が発生していた。
      // 1 クエリにバッチ化して往復を畳む。読み出しのみで beat surfacing の挙動は不変。
      const loaded = await loadScenesFull(descendants.map((s) => s.id)).catch(
        () => new Map<string, { content: string; unplacedBeatsDoc: string }>(),
      );

      for (const scene of descendants) {
        const { content, unplacedBeatsDoc } = loaded.get(scene.id) ?? {
          content: "",
          unplacedBeatsDoc: "[]",
        };
        let docJson: unknown = null;
        if (content) {
          try {
            docJson = JSON.parse(content);
          } catch {
            /* keep null */
          }
        }
        let unplacedBeats: UnplacedBeat[] = [];
        try {
          const parsed = JSON.parse(unplacedBeatsDoc);
          if (Array.isArray(parsed)) unplacedBeats = parsed as UnplacedBeat[];
        } catch {
          /* empty */
        }

        const section = buildPendingBeatsSection({
          sceneDocJson: docJson,
          unplacedBeats,
          resolveCharacterName,
          currentBeatId: null,
          scenePovCharacterId: scene.povCharacterId ?? null,
        });
        if (section) beatSectionBySceneId.set(scene.id, section);
      }
    }

    if (isProjectGrouped) {
      const parts = buildProjectParts("tier2", new Map(), beatSectionBySceneId);
      if (parts.length === 0) return null;
      const joined = `${tier2Preface}\n\n${parts.join("\n\n")}`;
      const aggregatedDetected = await detectFromJoined(joined);
      return {
        aggregatedScene: {
          id: anchorId,
          title: anchorTitle,
          content: joined,
        },
        aggregatedDetected,
      };
    }

    const parts: string[] = [];
    for (const scene of descendants) {
      parts.push(
        formatAggregatedSceneSynopsis(
          scene,
          activeSceneId,
          beatSectionBySceneId.get(scene.id),
        ),
      );
    }
    const joined = `${tier2Preface}\n\n${parts.join("\n\n")}`;
    const aggregatedDetected = await detectFromJoined(joined);
    return {
      aggregatedScene: {
        id: anchorId,
        title: anchorTitle,
        content: joined,
      },
      aggregatedDetected,
    };
  }

  if (isProjectGrouped) {
    const parts = buildProjectParts("foldersOnly", new Map(), new Map());
    if (parts.length === 0) return null;
    const joined = `${tier3ProjectPreface}\n\n${parts.join("\n\n")}`;
    const aggregatedDetected = await detectFromJoined(joined);
    return {
      aggregatedScene: {
        id: anchorId,
        title: anchorTitle,
        content: joined,
      },
      aggregatedDetected,
    };
  }

  return null;
}

// Module-level cleanup function for the active stream
let _streamCleanup: (() => void) | null = null;
// Stop 経路から coalesce バッファを同期 flush するためのフック（sendMessage が設定）。
let _flushPendingDelta: (() => void) | null = null;
// Debounce timer for refreshContextLayers when input-detected entry IDs change.
// Token counting (WASM tiktoken) は同期で長文 scene でも数百 ms。打鍵が落ち着いてから走らせる。
let _inputPinnedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
// ask_user の遅延 Promise を解決するクロージャ（guardedExecuteTool が設定）。
// シリアライズ不可なので state ではなく module-local に持つ。
let _resolveUserQuestion: ((result: ToolResult) => void) | null = null;
// agent ループの中断要求フラグ。Stop / セッション切替で true にし、runAgentLoop
// の shouldAbort から参照する（stop が agent path を止められない問題への対処）。
let _agentAborted = false;

// ---------------------------------------------------------------------------
// Shared scene context builder — used by both sendMessage and buildPromptForCopy
// ---------------------------------------------------------------------------

interface SceneContextPayload {
  prompt: string;
  totalTokens: number;
  layers: LayerBreakdown[];
  detectedEntries: CodexEntry[];
  alwaysEntries: CodexEntry[];
  /** L4 に full body + custom details + aliases が完全注入されたエントリの ID。
   * Agent モードで `get_codex_entry` 短絡判定に使う。Spotlight 経路を通った
   * エントリ（pinnedCodexEntries）が該当する。 */
  fullyInjectedIds: string[];
  stableCodexIds: string[];
  cacheSegments?: string[];
  /** Phase 4 後続: ContextBar chip 表示用の outline 値。注入されたものと同一。 */
  projectOutline: string | undefined;
  chapterOutlines: Array<{ title: string; outline: string }>;
}

/**
 * Map overlay: 現在 includeMapBoard が ON ならアクティブな board を
 * シリアライズして返す。OFF / board 未解決 / DB 失敗のときは undefined。
 *
 * Endpoint resolver: 非 Sticky 端点（Scene/Codex/Snippet/Note/AIBranch）を
 * kind+title に解決する。codex は呼び出し側が既に取得済みの entries を渡す
 * （重複 fetch 防止）。tree / aiBranch / snippet は内部で lookup。
 */
async function loadMapBoardMarkdown(
  allEntries: CodexEntry[],
): Promise<string | undefined> {
  const { includeMapBoard, mapBoardId } = useChatStore.getState();
  if (!includeMapBoard) return undefined;
  const resolvedBoardId = mapBoardId ?? useMapStore.getState().activeBoardId;
  if (!resolvedBoardId) return undefined;
  try {
    const [board, mapStickies, mapEdges, mapFrames, mapPositions, aiBranches] =
      await Promise.all([
        getMapBoard(resolvedBoardId),
        listMapStickies(resolvedBoardId),
        listMapUserEdges(resolvedBoardId),
        listMapFrames(resolvedBoardId),
        listMapNodePositions(resolvedBoardId),
        listMapAiBranches(resolvedBoardId),
      ]);
    if (!board) return undefined;
    const treeNodesById = new Map(
      useTreeStore.getState().nodes.map((n) => [n.id, n] as const),
    );
    const codexById = new Map(allEntries.map((e) => [e.id, e] as const));
    const aiBranchById = new Map(aiBranches.map((a) => [a.id, a] as const));
    // snippet endpoint は稀。同期取得できないので初回のみ「(snippet)」表示で
    // injection を成立させ、副作用で次回送信時に warm 化する。
    const snippetCache = new Map<string, string>();
    const fillSnippetTitle = (id: string): string | null => {
      const cached = snippetCache.get(id);
      if (cached !== undefined) return cached;
      getSnippet(getCurrentProjectId(), id)
        .then((s) => {
          if (s) snippetCache.set(id, s.title);
        })
        .catch(() => {});
      return null;
    };
    const resolveLabel = (
      p: (typeof mapPositions)[number],
    ): ResolvedLabel | null => {
      if (p.nodeRefType === "scene" || p.nodeRefType === "note") {
        if (!p.treeNodeId) return null;
        const node = treeNodesById.get(p.treeNodeId);
        if (!node) return null;
        return { kind: p.nodeRefType, title: node.title || "(untitled)" };
      }
      if (p.nodeRefType === "codex") {
        if (!p.codexEntryId) return null;
        const e = codexById.get(p.codexEntryId);
        if (!e) return null;
        return { kind: "codex", title: e.name || "(untitled)" };
      }
      if (p.nodeRefType === "snippet") {
        if (!p.snippetId) return null;
        const title = fillSnippetTitle(p.snippetId);
        return title
          ? { kind: "snippet", title }
          : { kind: "snippet", title: "(snippet)" };
      }
      if (p.nodeRefType === "ai_branch") {
        if (!p.aiBranchId) return null;
        const ab = aiBranchById.get(p.aiBranchId);
        if (!ab) return null;
        const promptHead = ab.prompt.trim().slice(0, 40);
        return { kind: "ai_branch", title: promptHead || "(AI branch)" };
      }
      return null;
    };
    return buildMapContextMarkdown({
      boardTitle: board.title,
      stickies: mapStickies,
      edges: mapEdges,
      frames: mapFrames,
      positions: mapPositions,
      resolveLabel,
    });
  } catch {
    return undefined;
  }
}

async function buildSceneContextPrompt(opts: {
  sceneCtx: SceneContext;
  projectCtx: ProjectContext | null;
  activeSessionId: string | null;
  effectiveSceneId: string | null;
  inputPinnedEntryIds: string[];
  conversationMessages: ChatMessage[];
  commandInstruction?: string;
  prefetchedEntries?: CodexEntry[];
  agentMode?: boolean;
  /** @scene mention で per-message pin される scene ID 群。本関数内で
   * tree から本文を読み込み、buildSystemPrompt の mentionedScenes として
   * 注入される (eco モードでも必ず注入)。 */
  mentionedSceneIds?: string[];
  sessionStableCodexIds?: string[];
}): Promise<SceneContextPayload> {
  const {
    sceneCtx,
    projectCtx,
    activeSessionId,
    effectiveSceneId,
    inputPinnedEntryIds,
    conversationMessages,
    commandInstruction,
  } = opts;

  await ensureTokenizer();
  const allEntries =
    opts.prefetchedEntries ?? (await listCodexEntries(getCurrentProjectId()));

  const aiSettings = useAiSettingsStore.getState().settings;
  const chatModel = aiSettings?.model ?? "";
  const chatApiVariant = getChatApiVariant(chatModel);
  const { contextWindow, maxOutputTokens } = resolveModelCapabilities(
    chatModel,
    aiSettings,
    chatApiVariant,
  );
  const budgets = allocateLayerBudgets(contextWindow, { maxOutputTokens });
  const L4_TOTAL_BUDGET = budgets.l4;

  // G12: context_mode filter (Codex + Note)
  const allNodesEarly = useTreeStore.getState().nodes;
  const noteNodes = allNodesEarly.filter((n) => n.nodeType === "note");
  const detectableCodex = allEntries.filter(
    (e) => e.contextMode !== "hidden" && e.contextMode !== "suppress",
  );
  const alwaysCodexEntries = allEntries.filter(
    (e) => e.contextMode === "always",
  );
  const detectableNotes = noteNodes.filter((n) => {
    const mode = n.contextMode ?? "mentioned";
    return mode !== "hidden" && mode !== "suppress";
  });
  const alwaysNoteNodes = noteNodes.filter(
    (n) => (n.contextMode ?? "mentioned") === "always",
  );

  const noteToMatchTarget = (node: TreeNodeData) => ({
    id: node.id,
    name: node.title,
    type: "note",
    aliases: node.aliases ?? "[]",
    excludedAliases: node.excludedAliases ?? "[]",
  });

  const detectableMatchTargets = [
    ...detectableCodex.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      aliases: e.aliases,
      excludedAliases: e.excludedAliases,
    })),
    ...detectableNotes.map(noteToMatchTarget),
  ];

  const mentionText = [
    sceneCtx.content,
    ...conversationMessages
      .filter((m) => m.role === "user")
      .map((m) => m.content),
  ].join("\n");

  markStart("buildSceneCtx.findMentionedEntriesAsync");
  const mentionedAll = await findMentionedEntriesAsync(
    mentionText,
    detectableMatchTargets,
  );
  markEnd("buildSceneCtx.findMentionedEntriesAsync");

  const mentioned = mentionedAll.filter((e) => e.type !== "note");
  const mentionedNotes = mentionedAll.filter((e) => e.type === "note");

  const mentionedIds = new Set(mentioned.map((e) => e.id));
  const alwaysNotMentioned = alwaysCodexEntries.filter(
    (e) => !mentionedIds.has(e.id),
  );
  const rawCodexEntries = stableSortCodexEntries([
    ...mentioned,
    ...alwaysNotMentioned,
  ]);

  const buildCodexCtx = (e: CodexEntry): CodexContext => {
    const summary = e.summary ?? "";
    const contentFallback = summary.trim()
      ? undefined
      : extractPlainText(e.content) || undefined;
    const aliases = parseAliases(e.aliases);
    return {
      id: e.id,
      type: e.type,
      name: e.name,
      summary,
      contentFallback,
      ...(aliases ? { aliases } : {}),
    };
  };

  const baseCodexEntries: CodexContext[] = rawCodexEntries.map((e) => {
    const full = allEntries.find((a) => a.id === e.id);
    return full
      ? buildCodexCtx(full)
      : { id: e.id, type: e.type, name: e.name, summary: "" };
  });

  // Children context (subtree token budget)
  const withChildrenCtx: CodexContext[] = baseCodexEntries.map((ctx) => {
    const fullEntry = allEntries.find((e) => e.id === ctx.id);
    if (!fullEntry) return ctx;
    const preset = fullEntry.childrenBudget ?? "compact";
    if (preset === "none") return ctx;
    const budget = computeChildrenTokenBudget(preset, L4_TOTAL_BUDGET);
    const descendants = getDescendantsBFS(fullEntry.id, allEntries);
    const childrenContext = buildChildrenContext(descendants, budget);
    return childrenContext ? { ...ctx, childrenContext } : ctx;
  });

  // G14: enrich with custom details
  markStart("buildSceneCtx.enrichWithCustomDetails");
  const enrichedCodexEntries = await enrichWithCustomDetails(
    withChildrenCtx,
    allEntries,
  );
  markEnd("buildSceneCtx.enrichWithCustomDetails");

  // Phase resolution
  const rawFullEntries = rawCodexEntries
    .map((e) => allEntries.find((a) => a.id === e.id))
    .filter((e): e is CodexEntry => e !== undefined);
  const { resolved: phaseResolved, phases: entryPhases } =
    await resolveEntriesForContext(rawFullEntries, effectiveSceneId);

  const codexEntries: CodexContext[] = enrichedCodexEntries.map((ctx) => {
    const rs = phaseResolved.get(ctx.id);
    if (!rs) return ctx;
    const phases = entryPhases.get(ctx.id) ?? [];
    const lastPhaseId = rs.appliedPhaseIds[rs.appliedPhaseIds.length - 1];
    const lastPhase = lastPhaseId
      ? phases.find((p) => p.id === lastPhaseId)
      : undefined;
    return {
      ...ctx,
      summary: rs.summary ?? ctx.summary,
      ...(lastPhase ? { phaseLabel: lastPhase.label } : {}),
    };
  });

  // Compute full pin set upfront (DB + G21 in-memory) to avoid duplicate injection
  const pinnedFromDB = activeSessionId
    ? await chatApi.listPinnedCodexEntries(activeSessionId)
    : [];
  const dbPinnedIdSet = new Set(pinnedFromDB.map((e) => e.id));
  const g21Ids = inputPinnedEntryIds.filter((id) => !dbPinnedIdSet.has(id));
  const allPinnedIdSet = new Set([...dbPinnedIdSet, ...g21Ids]);

  // Pinned codex entries (from DB — includes any just-auto-pinned entries)
  let pinnedCodexEntries: import("./contextBuilder").PinnedCodexContext[] =
    pinnedFromDB.map((e) => {
      const children = e.withChildren
        ? getChildrenFromArray(e.id, allEntries)
            .filter((c) => !allPinnedIdSet.has(c.id))
            .map((c) => {
              const childAliases = parseAliases(c.aliases);
              return {
                id: c.id,
                type: c.type,
                name: c.name,
                summary: c.summary ?? "",
                ...(childAliases ? { aliases: childAliases } : {}),
              };
            })
        : undefined;
      const childrenCtx = buildChildrenCtxForEntry(
        e,
        allEntries,
        L4_TOTAL_BUDGET,
        allPinnedIdSet,
      );
      const aliases = parseAliases(e.aliases);
      const tags = parseTags(e.tagsCache);
      return {
        id: e.id,
        type: e.type,
        name: e.name,
        summary: e.summary ?? "",
        fullContent: extractPlainText(e.content) || undefined,
        withChildren: e.withChildren,
        children,
        ...(aliases ? { aliases } : {}),
        ...(tags ? { tags } : {}),
        ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
      };
    });

  // G21: include input-typed detected entries not yet pinned to DB
  {
    const extraPinned = g21Ids.flatMap((id) => {
      const e = allEntries.find((a) => a.id === id);
      if (!e) return [];
      const childrenCtx = buildChildrenCtxForEntry(
        e,
        allEntries,
        L4_TOTAL_BUDGET,
        allPinnedIdSet,
      );
      const aliases = parseAliases(e.aliases);
      const tags = parseTags(e.tagsCache);
      const ctx: import("./contextBuilder").PinnedCodexContext = {
        id: e.id,
        type: e.type,
        name: e.name,
        summary: e.summary ?? "",
        fullContent: extractPlainText(e.content) || undefined,
        withChildren: false,
        ...(aliases ? { aliases } : {}),
        ...(tags ? { tags } : {}),
        ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
      };
      return [ctx];
    });
    if (extraPinned.length > 0) {
      pinnedCodexEntries = [...pinnedCodexEntries, ...extraPinned];
    }
  }

  // Spotlight された pinned エントリにも customDetails を付ける。
  // L4 描画は `pinnedIds.has(entry.id) && entry.customDetails?.length` で
  // pinned 限定なので、ここで詰めないと customDetails 行が永遠に出ない。
  pinnedCodexEntries = await enrichWithCustomDetails(
    pinnedCodexEntries,
    allEntries,
  );

  // G15: compute detectedEntries / alwaysEntries (excluding pinned) for caller
  const pinnedIdSet = new Set(pinnedCodexEntries.map((e) => e.id));
  const detectedNotPinned = mentioned
    .filter((e) => !pinnedIdSet.has(e.id))
    .map((e) => allEntries.find((a) => a.id === e.id))
    .filter((e): e is CodexEntry => e !== undefined);
  const alwaysNotPinned = alwaysCodexEntries.filter(
    (e) => !pinnedIdSet.has(e.id) && !mentionedIds.has(e.id),
  );

  // Note L4 entries (mentioned + always-not-mentioned)
  const mentionedNoteIds = new Set(mentionedNotes.map((n) => n.id));
  const noteById = new Map(noteNodes.map((n) => [n.id, n]));
  const buildNoteCtx = (node: TreeNodeData): NoteContext => {
    const aliases = parseAliases(node.aliases);
    return {
      id: node.id,
      title: node.title,
      content: prosemirrorToText(node.content ?? ""),
      ...(aliases ? { aliases } : {}),
    };
  };
  const rawNoteEntries: NoteContext[] = [
    ...mentionedNotes
      .map((m) => noteById.get(m.id))
      .filter((n): n is TreeNodeData => n !== undefined)
      .map(buildNoteCtx),
    ...alwaysNoteNodes
      .filter((n) => !mentionedNoteIds.has(n.id))
      .map(buildNoteCtx),
  ];
  const noteEntries = rawNoteEntries.length > 0 ? rawNoteEntries : undefined;
  const alwaysNoteIds =
    alwaysNoteNodes.length > 0 ? alwaysNoteNodes.map((n) => n.id) : undefined;

  // Story so far
  const allNodes = useTreeStore.getState().nodes;
  const currentScene = allNodes.find((n) => n.id === sceneCtx.id);
  markStart("buildSceneCtx.buildStorySoFar");
  const storySoFar = buildStorySoFar(sceneCtx.id, allNodes, budgets.l2);
  markEnd("buildSceneCtx.buildStorySoFar");

  // Phase 4: 祖先 folder の outline (= synopsis) を root まで walk して収集。
  // 非空の synopsis を持つ folder のみ採用し、outermost (root に近い) →
  // innermost (現シーン直接親) の順で並べる。L2 で chapter outlines として注入。
  const chapterOutlines: Array<{ title: string; outline: string }> = [];
  {
    const path: { title: string; outline: string }[] = [];
    let cursor: typeof currentScene | undefined = currentScene;
    while (cursor?.parentId) {
      const parent = allNodes.find((n) => n.id === cursor!.parentId);
      if (!parent) break;
      if (parent.nodeType === "folder" && parent.synopsis?.trim()) {
        path.push({ title: parent.title, outline: parent.synopsis.trim() });
      }
      cursor = parent;
    }
    chapterOutlines.push(...path.reverse()); // outermost first
  }

  // G11: previousScene (reading-order)
  const previousSceneNode = currentScene
    ? allNodes
        .filter(
          (n) =>
            n.nodeType === "scene" &&
            n.id !== sceneCtx.id &&
            cmpKeys(n.sortOrder, currentScene.sortOrder) < 0 &&
            n.synopsis != null &&
            n.synopsis.trim() !== "",
        )
        .sort((a, b) => cmpKeys(b.sortOrder, a.sortOrder))[0]
    : undefined;
  const previousScene = previousSceneNode
    ? {
        title: previousSceneNode.title,
        synopsis: previousSceneNode.synopsis as string,
      }
    : undefined;

  // Phase 2: ストーリー時系列の直前シーン。reading-order の previousScene と
  // 異なる場合のみ注入する。current の storyTimeOrder が未設定なら無効。
  const storyTimePreviousNode =
    currentScene && currentScene.storyTimeOrder
      ? allNodes
          .filter(
            (n) =>
              n.nodeType === "scene" &&
              n.id !== sceneCtx.id &&
              n.storyTimeOrder != null &&
              cmpKeys(n.storyTimeOrder, currentScene.storyTimeOrder!) < 0 &&
              n.synopsis != null &&
              n.synopsis.trim() !== "",
          )
          .sort((a, b) =>
            cmpKeys(b.storyTimeOrder as string, a.storyTimeOrder as string),
          )[0]
      : undefined;
  const storyTimePreviousScene =
    storyTimePreviousNode && storyTimePreviousNode.id !== previousSceneNode?.id
      ? {
          title: storyTimePreviousNode.title,
          synopsis: storyTimePreviousNode.synopsis as string,
          storyTimeLabel: storyTimePreviousNode.storyTimeLabel ?? null,
        }
      : undefined;

  // G16: pinned snippets
  let pinnedSnippets: PinnedSnippetContext[] = [];
  let pinnedStickies: PinnedStickyContext[] = [];
  if (activeSessionId) {
    try {
      const snippetItems = await listPinnedSnippetEntries(activeSessionId);
      pinnedSnippets = snippetItems.map((s) => ({
        id: s.id,
        title: s.title,
        content: extractPlainText(s.content) || s.title,
      }));
    } catch {
      // 取得失敗は無視
    }
    try {
      const stickyItems = await listPinnedStickyEntries(activeSessionId);
      pinnedStickies = stickyItems.map((s) => ({
        id: s.id,
        title: s.title,
        content: s.content,
      }));
    } catch {
      // 取得失敗は無視
    }
  }

  // Map overlay: scope と直交する独立トグル。ON のとき active board
  // 全体（Sticky / Edge / Frame）を 1 ブロックとして L4 に注入する。
  const mapBoardMarkdown = await loadMapBoardMarkdown(allEntries);

  // G19: active tab content
  let activeTabContent:
    | { type: "codex" | "snippet"; title: string; content: string }
    | undefined;
  try {
    const tabState = useTabStore.getState();
    const activeTab = tabState.tabs.find(
      (t) => t.nodeId === tabState.activeTabId,
    );
    if (activeTab?.contentType === "codex") {
      const codexEntry = allEntries.find((e) => e.id === activeTab.nodeId);
      if (codexEntry) {
        activeTabContent = {
          type: "codex",
          title: codexEntry.name,
          content:
            extractPlainText(codexEntry.content) || codexEntry.summary || "",
        };
      }
    } else if (activeTab?.contentType === "snippet") {
      const snippet = await getSnippet(
        getCurrentProjectId(),
        activeTab.nodeId,
      ).catch(() => undefined);
      if (snippet) {
        activeTabContent = {
          type: "snippet",
          title: snippet.title,
          content: extractPlainText(snippet.content) || snippet.title,
        };
      }
    }
  } catch {
    // 無視
  }

  // G17: conversation summary
  let conversationSummary: string | undefined;
  if (activeSessionId) {
    try {
      const summaries = await chatApi.listSummaries(activeSessionId);
      if (summaries.length > 0) {
        conversationSummary = summaries.map((s) => s.summary).join("\n\n");
      }
    } catch {
      // 無視
    }
  }

  markStart(
    `buildSceneCtx.conversationTokenize.${conversationMessages.length}`,
  );
  const conversationTokens = conversationMessages
    .filter((m) => m.role !== "system")
    .reduce((sum, m) => sum + countTokens(m.content), 0);
  markEnd(`buildSceneCtx.conversationTokenize.${conversationMessages.length}`);

  // C-3: Build "pending beats" section if injection is enabled.
  // contentJson が undefined/空/JSON parse 失敗のいずれでも、Unplaced beat の
  // ヒントだけは落とさず注入する（旧 HTML 形式 scene 等のフォールバック）。
  const injectBeats = useSettingsStore
    .getState()
    .getBoolean("beat.injectIntoContext", true);
  let pendingBeatsSection: string | undefined;
  if (injectBeats) {
    let docJson: unknown = null;
    if (sceneCtx.contentJson) {
      try {
        docJson = JSON.parse(sceneCtx.contentJson);
      } catch {
        docJson = null;
      }
    }
    try {
      const unplacedBeats = useUnplacedBeatsStore
        .getState()
        .getBeats(sceneCtx.id);
      pendingBeatsSection = buildPendingBeatsSection({
        sceneDocJson: docJson,
        unplacedBeats,
        resolveCharacterName: (id) =>
          allEntries.find((e) => e.id === id)?.name ?? null,
        currentBeatId: null,
        scenePovCharacterId: currentScene?.povCharacterId ?? null,
      });
    } catch {
      // 無視
    }
  }

  // Phase 1+2: シーンラベル / シーン直結伏線 / 全体未回収伏線 を並列取得。
  // すべて DB アクセスのみで in-memory store に依存しない。個別に try/catch して
  // フォールバックで空にすることで、データが無くても既存挙動は維持される。
  const projectIdForFs = useTreeStore.getState().projectId;
  markStart("buildSceneCtx.fetchLabelsAndForeshadow");
  const [sceneLabelRows, sceneForeshadow, openForeshadowRows] =
    await Promise.all([
      listNodeLabels(sceneCtx.id).catch(() => []),
      getSceneForeshadowContext(sceneCtx.id).catch(() => ({
        setups: [],
        payoffs: [],
      })),
      projectIdForFs
        ? listOpenForeshadowsForContext(projectIdForFs).catch(() => [])
        : Promise.resolve([]),
    ]);
  markEnd("buildSceneCtx.fetchLabelsAndForeshadow");
  const sceneLabels = sceneLabelRows.map((l) => l.name);
  const openForeshadowsInput =
    openForeshadowRows.length > 0
      ? openForeshadowRows.map((r) => ({
          title: r.title,
          intent: r.intent,
          loadBearing: r.loadBearing,
          setupCount: r.setupCount,
          derivedLabel: r.derivedLabel,
        }))
      : undefined;
  const sceneForeshadowInput =
    sceneForeshadow.setups.length > 0 || sceneForeshadow.payoffs.length > 0
      ? {
          setups: sceneForeshadow.setups.map((s) => ({
            title: s.title,
            intent: s.intent,
            derivedLabel: s.derivedLabel,
            strength: s.strength ?? null,
            excerpt: s.excerpt ?? null,
          })),
          payoffs: sceneForeshadow.payoffs.map((p) => ({
            title: p.title,
            intent: p.intent,
            setupSceneTitle: p.setupSceneTitle,
            derivedLabel: p.derivedLabel,
            strength: p.strength ?? null,
            excerpt: p.excerpt ?? null,
          })),
        }
      : undefined;

  // @scene mention の本文ロード (per-send only)。buildSystemPrompt の中で
  // 現在シーン id と同一のものは除外されるが、ここでも loadSceneContent の
  // 二重呼び出しを避けるため明示的に弾いている。
  const mentionedScenes = await loadMentionedScenes(
    opts.mentionedSceneIds,
    sceneCtx.id,
  );

  // Phase Cb: BFS-expand formal Codex relations from entries already in L4.
  const projectIdForRel = useTreeStore.getState().projectId;
  let relationCodexEntries: CodexContext[] | undefined;
  if (projectIdForRel) {
    const l4SeedIds = new Set([
      ...codexEntries.map((e) => e.id),
      ...pinnedCodexEntries.map((e) => e.id),
    ]);
    if (l4SeedIds.size > 0) {
      const relations = await listCodexRelations(projectIdForRel).catch(
        () => [],
      );
      const expanded = expandCodexRelationsBFS(
        [...l4SeedIds],
        relations,
        allEntries,
        l4SeedIds,
      );
      relationCodexEntries = expanded.length > 0 ? expanded : undefined;
    }
  }

  markStart("buildSceneCtx.buildSystemPrompt");
  const promptResult = buildSystemPrompt({
    scene: sceneCtx,
    project: projectCtx ?? undefined,
    storySoFar: storySoFar || undefined,
    previousScene,
    codexEntries,
    pinnedCodexEntries,
    pinnedSnippets: pinnedSnippets.length > 0 ? pinnedSnippets : undefined,
    pinnedStickies: pinnedStickies.length > 0 ? pinnedStickies : undefined,
    mapBoardMarkdown,
    activeTabContent,
    commandInstruction,
    conversationTokens,
    contextWindow,
    maxOutputTokens,
    conversationSummary,
    pendingBeatsSection,
    sceneLabels: sceneLabels.length > 0 ? sceneLabels : undefined,
    sceneForeshadow: sceneForeshadowInput,
    openForeshadows: openForeshadowsInput,
    storyTimePreviousScene,
    projectOutline: projectCtx?.outline ?? undefined,
    chapterOutlines: chapterOutlines.length > 0 ? chapterOutlines : undefined,
    mentionedScenes: mentionedScenes.length > 0 ? mentionedScenes : undefined,
    lang: projectCtx?.language ?? "ja",
    agentMode: opts.agentMode,
    customChatInstruction: useSettingsStore
      .getState()
      .get("aiPrompt.custom.chat", ""),
    sessionStableCodexIds: opts.sessionStableCodexIds,
    alwaysEntryIds: alwaysNotPinned.map((e) => e.id),
    noteEntries,
    alwaysNoteIds,
    relationCodexEntries,
  });
  markEnd("buildSceneCtx.buildSystemPrompt");

  const stableCodexIds = [
    ...allPinnedIdSet,
    ...rawCodexEntries.map((e) => e.id),
    ...(noteEntries?.map((n) => n.id) ?? []),
    ...(relationCodexEntries?.map((e) => e.id) ?? []),
  ];

  return {
    prompt: promptResult.prompt,
    totalTokens: promptResult.totalTokens,
    layers: promptResult.layers,
    detectedEntries: detectedNotPinned,
    alwaysEntries: alwaysNotPinned,
    fullyInjectedIds: pinnedCodexEntries.map((e) => e.id),
    stableCodexIds: [...new Set(stableCodexIds)],
    cacheSegments: promptResult.cacheSegments,
    projectOutline: projectCtx?.outline?.trim()
      ? projectCtx.outline
      : undefined,
    chapterOutlines,
  };
}

export const useChatStore = create<ChatState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoadingSessions: false,
  isLoadingMessages: false,
  messages: [],
  isStreaming: false,
  error: null,
  activeSceneId: "",
  activeProjectId: null,
  contextTokenCount: 0,
  contextLayers: [],
  lastSystemPrompt: "",
  pinsVersion: 0,
  projectOutline: undefined,
  chapterOutlines: [],
  detectedEntries: [],
  alwaysEntries: [],
  inputPinnedEntryIds: [],
  agentMode: false,
  agentProgress: null,
  pendingUserQuestion: null,
  ragEnabled: false,
  ragSearching: false,
  chatScope: "scene",
  scopeAnchorId: null,
  includeBodies: true,
  includeMapBoard: false,
  mapBoardId: null,
  _editingOldContent: null,
  pendingLookupText: null,
  summaryCount: 0,
  maxSummaryGeneration: 0,
  cacheInvalidatedReason: null,
  sessionStableCodexIds: [],
  sessionAgentToolsSnapshot: null,
  _lastCachedModel: null,

  invalidateContextCache: (reason) => {
    set({ cacheInvalidatedReason: reason });
  },

  dismissCacheInvalidated: () => {
    set({ cacheInvalidatedReason: null });
  },

  syncInsertedToEditorMetadata: (messageId) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m;
        let meta: Record<string, unknown> = {};
        if (m.metadata) {
          try {
            meta = JSON.parse(m.metadata) as Record<string, unknown>;
          } catch {
            meta = {};
          }
        }
        return {
          ...m,
          metadata: JSON.stringify({ ...meta, insertedToEditor: true }),
        };
      }),
    }));
  },

  createLinkedSession: async () => {
    const {
      activeSessionId,
      activeProjectId,
      activeSceneId,
      chatScope,
      sessions,
    } = get();
    const ref = sessions.find((s) => s.id === activeSessionId);
    const projectId = activeProjectId ?? getCurrentProjectId();
    const nodeId =
      chatScope === "project"
        ? undefined
        : chatScope === "folder"
          ? undefined
          : activeSceneId || undefined;
    try {
      const session = await chatApi.createSession(
        projectId,
        ref ? `Linked: ${ref.title}` : "New session",
        nodeId,
      );
      set((state) => ({
        sessions: [session, ...state.sessions],
        activeSessionId: session.id,
        messages: [],
        summaryCount: 0,
        maxSummaryGeneration: 0,
        sessionStableCodexIds: [],
        sessionAgentToolsSnapshot: snapshotAgentTools(),
        cacheInvalidatedReason: null,
      }));
      if (ref) {
        const linkMsg = await chatApi.addMessage(
          session.id,
          "system",
          i18next.t("chat.linkedSessionReference", {
            title: ref.title,
            sessionId: ref.id,
          }),
        );
        set({ messages: [linkMsg] });
      }
    } catch (e) {
      toast.error(i18next.t("chat.createSessionFailed"));
      debugLog.error("ChatStore", "createLinkedSession", errorDetail(e));
    }
  },

  removeEntryFromAuto: (entryId: string) => {
    set((state) => ({
      detectedEntries: state.detectedEntries.filter((e) => e.id !== entryId),
      alwaysEntries: state.alwaysEntries.filter((e) => e.id !== entryId),
    }));
  },

  setInputPinnedEntryIds: (ids: string[]) => {
    const { isStreaming, inputPinnedEntryIds } = get();
    if (isStreaming) return;
    const sorted = [...ids].sort();
    const prev = [...inputPinnedEntryIds].sort();
    if (sorted.join(",") === prev.join(",")) return;
    set({ inputPinnedEntryIds: ids });
    if (_inputPinnedRefreshTimer !== null)
      clearTimeout(_inputPinnedRefreshTimer);
    _inputPinnedRefreshTimer = setTimeout(() => {
      _inputPinnedRefreshTimer = null;
      void get().refreshContextLayers();
    }, 500);
  },

  setPendingLookupText: (text) => set({ pendingLookupText: text }),

  // --- Session management ---

  loadSessions: async (nodeId?: string | null) => {
    set({ isLoadingSessions: true });
    try {
      const sessions = await chatApi.listSessions(nodeId);
      set({ sessions, isLoadingSessions: false });
    } catch (e) {
      set({ isLoadingSessions: false });
      toast.error(i18next.t("chat.loadSessionsFailed"));
      debugLog.error("ChatStore", "loadSessions", errorDetail(e));
    }
  },

  selectSession: async (sessionId: string | null) => {
    // セッションを切り替える前に、回答待ちの ask_user を sentinel 解決して
    // resolver リーク・別セッションでのカード誤表示を防ぐ（null/切替の両分岐共通）。
    get()._cancelPendingUserQuestion();
    if (sessionId === null) {
      set({
        activeSessionId: null,
        messages: [],
        isLoadingMessages: false,
        summaryCount: 0,
        maxSummaryGeneration: 0,
        sessionStableCodexIds: [],
        sessionAgentToolsSnapshot: null,
      });
      return;
    }
    set({
      isLoadingMessages: true,
      activeSessionId: sessionId,
      messages: [],
    });
    try {
      const [messages, summaries] = await Promise.all([
        chatApi.listMessages(sessionId),
        chatApi.listSummaries(sessionId),
      ]);
      set({
        activeSessionId: sessionId,
        messages,
        isLoadingMessages: false,
        summaryCount: summaries.length,
        maxSummaryGeneration:
          summaries.length > 0
            ? Math.max(...summaries.map((s) => s.generation))
            : 0,
        sessionStableCodexIds: [],
        sessionAgentToolsSnapshot: snapshotAgentTools(),
        cacheInvalidatedReason: null,
      });
    } catch (e) {
      set({ isLoadingMessages: false });
      toast.error(i18next.t("chat.loadMessagesFailed"));
      debugLog.error("ChatStore", "selectSession", errorDetail(e));
    }
  },

  createNewSession: async (
    projectId: string,
    title: string,
    nodeId?: string,
  ) => {
    try {
      const session = await chatApi.createSession(projectId, title, nodeId);
      set((state) => ({
        sessions: [session, ...state.sessions],
        activeSessionId: session.id,
        messages: [],
        summaryCount: 0,
        maxSummaryGeneration: 0,
        sessionStableCodexIds: [],
        sessionAgentToolsSnapshot: snapshotAgentTools(),
        cacheInvalidatedReason: null,
      }));
    } catch (e) {
      toast.error(i18next.t("chat.createSessionFailed"));
      debugLog.error("ChatStore", "createNewSession", errorDetail(e));
    }
  },

  ensureSession: async () => {
    const {
      activeSessionId,
      activeProjectId,
      activeSceneId,
      chatScope,
      scopeAnchorId,
    } = get();
    if (activeSessionId) return activeSessionId;
    const effectiveNodeId =
      chatScope === "scene"
        ? (activeSceneId ?? undefined)
        : chatScope === "folder"
          ? (scopeAnchorId ?? undefined)
          : undefined;
    try {
      const session = await chatApi.createSession(
        activeProjectId ?? getCurrentProjectId(),
        "New session",
        effectiveNodeId,
      );
      set((state) => ({
        sessions: [session, ...state.sessions],
        activeSessionId: session.id,
      }));
      return session.id;
    } catch (e) {
      debugLog.error("ChatStore", "ensureSession", errorDetail(e));
      return null;
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await chatApi.deleteSession(sessionId);
      const { activeSessionId } = get();
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        ...(activeSessionId === sessionId
          ? { activeSessionId: null, messages: [] }
          : {}),
      }));
    } catch (e) {
      toast.error(i18next.t("chat.deleteSessionFailed"));
      debugLog.error("ChatStore", "deleteSession", errorDetail(e));
    }
  },

  persistMessage: async (role: MessageRole, content: string) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;

    try {
      const message = await chatApi.addMessage(activeSessionId, role, content);
      set((state) => ({
        messages: [...state.messages, message],
      }));
    } catch (e) {
      toast.error(i18next.t("chat.saveMessageFailed"));
      debugLog.error("ChatStore", "persistMessage", errorDetail(e));
    }
  },

  // --- Prompt preview for copy ---

  buildPromptForCopy: async (
    userInput: string,
    options?: { mentionedSceneIds?: string[] },
  ): Promise<string> => {
    await ensureTokenizer();
    const {
      activeSceneId,
      activeProjectId,
      activeSessionId,
      chatScope,
      agentMode,
      messages: prevMessages,
      inputPinnedEntryIds,
    } = get();
    const effectiveSceneId =
      chatScope === "scene" && activeSceneId ? activeSceneId : null;

    const parts: string[] = [];
    let contextLoaded = false;
    let needsMentionCleanup = false;

    try {
      if (effectiveSceneId) {
        const [sceneCtx, projectCtx] = await Promise.all([
          fetchSceneContext(effectiveSceneId),
          fetchProjectContext(activeProjectId),
        ]);
        if (sceneCtx) {
          // Agent モードでも通常モードと同じコンテキスト（L1〜L4）を組む。
          const conversationMessages: ChatMessage[] = [
            ...prevMessages.filter((m) => !m.isSummarized),
            {
              id: "preview",
              sessionId: activeSessionId ?? "",
              role: "user",
              content: userInput,
              createdAt: new Date().toISOString(),
            } as ChatMessage,
          ];
          const { prompt } = await buildSceneContextPrompt({
            sceneCtx,
            projectCtx,
            activeSessionId,
            effectiveSceneId,
            inputPinnedEntryIds,
            conversationMessages,
            agentMode,
            mentionedSceneIds: options?.mentionedSceneIds,
          });
          parts.push(`[system]\n${prompt}`);
          contextLoaded = true;
        }
      } else if (chatScope === "folder" || chatScope === "project") {
        // folder / project: sendMessage / agent と同じく refreshContextLayers の
        // lastSystemPrompt を流用（空 scene で buildSystemPrompt しない）。
        // mentions 込みで refresh すると lastSystemPrompt に @scene pin が焼き込まれ、
        // ユーザーが mention を消して送信した次回送信でも古い pin を吸う。Copy 後に
        // mentions 無しで refresh し直して state を巻き戻す（後段の finally で実行）。
        const hadMentions =
          !!options?.mentionedSceneIds && options.mentionedSceneIds.length > 0;
        if (hadMentions) {
          await get().refreshContextLayers({
            mentionedSceneIds: options!.mentionedSceneIds,
          });
          needsMentionCleanup = true;
        } else if (!get().lastSystemPrompt) {
          await get().refreshContextLayers();
        }
        const prompt = get().lastSystemPrompt;
        if (prompt) {
          parts.push(`[system]\n${prompt}`);
          contextLoaded = true;
        }
      }
    } catch (e) {
      console.error("[buildPromptForCopy] context fetch failed:", e);
    }

    if (needsMentionCleanup) {
      // Copy 用に mentions 込みで焼き込んだ state を巻き戻す。失敗しても Copy 結果には
      // 影響しないので個別 catch でログのみ。
      try {
        await get().refreshContextLayers();
      } catch (e) {
        console.error("[buildPromptForCopy] cleanup refresh failed:", e);
      }
    }

    if (!contextLoaded) {
      const fallback = get().lastSystemPrompt;
      if (fallback) {
        parts.push(`[system]\n${fallback}`);
      }
    }

    // 会話履歴
    for (const msg of prevMessages) {
      if (msg.role === "system") continue;
      parts.push(`[${msg.role}]\n${msg.content}`);
    }

    // 今回のユーザー入力
    parts.push(`[user]\n${userInput}`);

    return parts.join("\n\n---\n\n");
  },

  // --- Streaming chat ---

  sendMessage: async (
    content: string,
    commandInstruction?: string,
    options?: {
      overrideAgentMode?: boolean;
      mentionedSceneIds?: string[];
    },
  ) => {
    const {
      isStreaming,
      activeSceneId,
      activeProjectId,
      activeSessionId,
      chatScope,
      scopeAnchorId,
    } = get();
    if (isStreaming) return;
    await ensureTokenizer();
    if (!content.trim()) return;
    // Defense: chat がポリシーで OFF なら送信を弾く。Send ボタンは hide/disabled
    // になるが、Enter / Cmd+Enter / regenerate / agent 再入は全てこの sendMessage
    // に集約されるため、ここで塞げば UI を経由しない送信経路も封じられる。
    // 最初の set() より前に判定する。
    if (blockIfPolicyOff("chat")) return;

    const aiSettingsEarly = useAiSettingsStore.getState().settings;
    const chatModelEarly = aiSettingsEarly?.model ?? "";
    if (get()._lastCachedModel && get()._lastCachedModel !== chatModelEarly) {
      set({ cacheInvalidatedReason: "model" });
    }
    if (!get().sessionAgentToolsSnapshot) {
      set({ sessionAgentToolsSnapshot: snapshotAgentTools() });
    }
    set({ _lastCachedModel: chatModelEarly });

    const effectiveSceneId = chatScope === "scene" ? activeSceneId : null;
    // 一回限りの Agent mode override (サジェストチップ / 再試行ボタンから)
    // ユーザーの永続トグルは変更しない。
    const agentModeForThisSend = options?.overrideAgentMode ?? get().agentMode;
    const aiProvider = useAiSettingsStore.getState().settings?.provider;
    // RAG (Web 検索) が ON かつ対応プロバイダ (OpenRouter / Anthropic) のときは、
    // agentMode の有無に関わらず構造化 (非ストリーミング) パスに通す。引用パースを
    // send_agent_message の1経路に集約するため (設計判断)。
    const ragActive = get().ragEnabled && isRagCapableProvider(aiProvider);
    // CLI は subprocess 専用。Agent モードでも HTTP の send_agent_message に落とすと
    // 空応答・無応答になるため、常に通常モードの sendCliChatStream へ回す。
    const useAgentPath =
      (agentModeForThisSend || ragActive) && aiProvider !== "cli";

    const sessionId = activeSessionId ?? "";

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };

    const prevMessages = get().messages;
    set({
      messages: [...prevMessages, userMsg, assistantMsg],
      isStreaming: true,
      ragSearching: ragActive,
      error: null,
    });

    // -----------------------------------------------------------------------
    // セッションが未作成の場合は自動作成 (P0-2)
    // -----------------------------------------------------------------------
    let sessionIdForPersist = activeSessionId;
    if (!sessionIdForPersist) {
      const effectiveNodeId =
        chatScope === "scene"
          ? (effectiveSceneId ?? undefined)
          : chatScope === "folder"
            ? (scopeAnchorId ?? undefined)
            : undefined;
      try {
        const session = await chatApi.createSession(
          activeProjectId ?? getCurrentProjectId(),
          "New session",
          effectiveNodeId ?? undefined,
        );
        sessionIdForPersist = session.id;
        set((state) => ({
          sessions: [session, ...state.sessions],
          activeSessionId: session.id,
          messages: state.messages.map((m) => ({
            ...m,
            sessionId: session.id,
          })),
        }));
      } catch (e) {
        debugLog.error("ChatStore", "auto-create session", errorDetail(e));
      }
    }

    // -----------------------------------------------------------------------
    // Agent mode path — tool-use loop
    //
    // 通常モードと同じ buildSceneContextPrompt / refreshContextLayers 経由で
    // L1〜L4（自動検出 Codex の summary + Spotlight された Codex/Snippet の content）
    // を注入する。Agent はその上で必要に応じて search_codex / get_codex_entry を
    // 叩いて未注入エントリの探索や詳細深掘りを行う、という階層的アクセス前提。
    // -----------------------------------------------------------------------
    if (useAgentPath) {
      try {
        const sceneCtx = effectiveSceneId
          ? await fetchSceneContext(effectiveSceneId)
          : null;
        const projectCtx = await fetchProjectContext(activeProjectId);

        // 通常モードと同じく、@言及/CodexHighlight 経由でメッセージ内に検出された
        // Codex エントリを送信時に自動 Spotlight する。
        // listCodexEntries の結果は buildSceneContextPrompt に prefetchedEntries
        // として渡し、二重 fetch を避ける。
        const allEntriesForCtx = sceneCtx
          ? await listCodexEntries(getCurrentProjectId())
          : [];
        if (sessionIdForPersist && sceneCtx) {
          const chatMentioned = await findMentionedEntriesAsync(
            content,
            allEntriesForCtx,
          );
          for (const entry of chatMentioned) {
            await chatApi
              .pinCodexEntry(
                sessionIdForPersist,
                entry.id,
                false,
                "chat_mention",
              )
              .catch(() => {});
          }
        }

        const projectCtxLang = projectCtx?.language ?? "ja";
        let agentMessages = prevMessages;
        if (sessionIdForPersist) {
          const agentApiVariant = getChatApiVariant(chatModelEarly);
          const { contextWindow, maxOutputTokens } = resolveModelCapabilities(
            chatModelEarly,
            aiSettingsEarly,
            agentApiVariant,
          );
          const budgets = allocateLayerBudgets(contextWindow, {
            maxOutputTokens,
          });
          agentMessages = await maybeRunSummarization(
            sessionIdForPersist,
            prevMessages,
            budgets.l5,
            projectCtxLang,
            set,
          );
        }

        const agentMsgs: AgentMessagePayload[] = [];
        let systemPromptForAgent = "";
        let systemCacheSegmentsForAgent: string[] | undefined;
        // Spotlight された (= L4 に full body + custom details + aliases が
        // 揃って注入された) エントリの ID 集合。`get_codex_entry` が
        // この集合の ID で呼ばれた場合は executor を呼ばずスタブを返す
        // (LLM はプロンプト指示に従わず再 fetch しがちなため)。
        let fullyInjectedIds: Set<string> = new Set();
        if (sceneCtx) {
          const messagesForCtx: ChatMessage[] = [
            ...agentMessages.filter((m) => !m.isSummarized),
            userMsg,
          ];
          const ctxResult = await buildSceneContextPrompt({
            sceneCtx,
            projectCtx,
            activeSessionId: sessionIdForPersist ?? activeSessionId,
            effectiveSceneId,
            inputPinnedEntryIds: get().inputPinnedEntryIds,
            conversationMessages: messagesForCtx,
            commandInstruction,
            prefetchedEntries: allEntriesForCtx,
            agentMode: true,
            mentionedSceneIds: options?.mentionedSceneIds,
            sessionStableCodexIds: get().sessionStableCodexIds,
          });
          systemPromptForAgent = ctxResult.prompt;
          systemCacheSegmentsForAgent = ctxResult.cacheSegments;
          fullyInjectedIds = new Set(ctxResult.fullyInjectedIds);
          if (get().sessionStableCodexIds.length === 0) {
            set({ sessionStableCodexIds: ctxResult.stableCodexIds });
          }
          set({
            contextTokenCount: ctxResult.totalTokens,
            contextLayers: ctxResult.layers,
            lastSystemPrompt: ctxResult.prompt,
            detectedEntries: ctxResult.detectedEntries,
            alwaysEntries: ctxResult.alwaysEntries,
          });
        } else if (projectCtx) {
          // グローバルチャット: refreshContextLayers が事前に組んだ
          // L1 + Spotlight L4 (codex/snippet) + always エントリ込みの prompt を流用。
          // 入力側で新たに Spotlight された場合に備え再計算してから使う。
          // @scene mention は per-send の一時 pin として渡す。
          await get().refreshContextLayers({
            mentionedSceneIds: options?.mentionedSceneIds,
            // 一回限り override で送るときも、その agentMode で集約 tier を組む
            // （永続トグル基準で組むと pull 委譲が override 送信に効かない）。
            agentModeOverride: agentModeForThisSend,
          });
          systemPromptForAgent = get().lastSystemPrompt;
          const dbPinned = sessionIdForPersist
            ? await chatApi
                .listPinnedCodexEntries(sessionIdForPersist)
                .catch(() => [])
            : [];
          fullyInjectedIds = new Set([
            ...dbPinned.map((e) => e.id),
            ...get().inputPinnedEntryIds,
          ]);
        }

        // RAG 有効ターンは Web 検索の安全指示を system 末尾へ付与する
        // (本文をクエリに混入させない / 引用捏造の抑止 / 取得指示の無視)。
        // 注意: Anthropic 直叩きは system を cacheSegments から再構築し system
        // message 本文を無視する一方、OpenRouter は system message 本文を直接
        // 使う。全経路に確実に届けるため両方へ付与する (どの経路も両方は読まず、
        // 重複しない。segment は新規追加せず最終 segment へ連結し 4 block 制限を守る)。
        if (ragActive) {
          // Hermes プロトコル × agent mode（declared client tools あり）のときだけ
          // Hermes 用 RAG 指示を使う。標準版は全 `<tool_call>` を禁止しており、Hermes の
          // 正規ツール呼び出しと矛盾するため。RAG 単独（agent OFF=client tools なし）は
          // 全面禁止のままで正しい。
          const ragAgentControl = getPromptCatalog(
            projectCtx?.language ?? "ja",
          ).agentControl;
          const useHermesRag =
            agentModeForThisSend &&
            isHermesProtocol(useAiSettingsStore.getState().settings);
          const ragInstruction = useHermesRag
            ? ragAgentControl.webSearchInstructionHermes
            : ragAgentControl.webSearchInstruction;
          systemPromptForAgent = systemPromptForAgent
            ? `${systemPromptForAgent}\n\n${ragInstruction}`
            : ragInstruction;
          if (
            systemCacheSegmentsForAgent &&
            systemCacheSegmentsForAgent.length > 0
          ) {
            const segs = [...systemCacheSegmentsForAgent];
            segs[segs.length - 1] =
              `${segs[segs.length - 1]}\n\n${ragInstruction}`;
            systemCacheSegmentsForAgent = segs;
          }
        }

        if (systemPromptForAgent) {
          agentMsgs.push({ role: "system", content: systemPromptForAgent });
        }

        // Convert conversation history
        for (const msg of prevMessages) {
          if (msg.role === "system") continue;
          if (msg.isSummarized) continue;
          if (msg.role === "user") {
            agentMsgs.push({ role: "user", content: msg.content });
          } else if (msg.role === "assistant") {
            // 過去ターンの assistant 本文に擬似ツール記法が混入していると、
            // モデルがそれを few-shot として模倣し続ける。履歴を戻す前に除去。
            agentMsgs.push({
              role: "assistant",
              content: stripToolProtocol(msg.content),
            });
          }
        }
        agentMsgs.push({ role: "user", content });

        // Token budget + thinking params
        const aiSettings = useAiSettingsStore.getState().settings;
        const currentModel = aiSettings?.model ?? "";
        const agentApiVariant = getChatApiVariant(currentModel);
        const tokenBudget = getToolTokenBudget(currentModel);
        const agentThinkingParams = buildThinkingParams(
          currentModel,
          getEffortForTask("agent"),
          "summarized",
          aiSettings?.thinkingEnabled ?? true,
          aiSettings,
          agentApiVariant,
          aiSettings?.reasoningEffortOverride ?? undefined,
        );

        // Accumulate tool calls for live metadata update
        const accToolCalls: ToolCallRecord[] = [];

        // 短絡: get_codex_entry が「事前に full body + custom details +
        // aliases が注入されているエントリ」に対して呼ばれた場合は、
        // executor (DB アクセス) を呼ばずスタブを返す。LLM はプロンプト
        // 指示に従わず再 fetch しがちなため、ランタイム側で受け止める。
        const agentControl = getPromptCatalog(
          projectCtx?.language ?? "ja",
        ).agentControl;

        const guardedExecuteTool: typeof executeTool = async (
          name,
          toolCallId,
          params,
        ) => {
          // ask_user: 遅延 Promise を返し、UI の回答で resolve されるまでループを
          // 待機させる。resolve クロージャは module-local に退避し、renderable な
          // 仕様のみ state に置く。
          if (name === "ask_user") {
            const spec = normalizeAskUserSpec(params);
            if (!spec) {
              return invalidAskUserResult(
                toolCallId,
                "ask_user requires a non-empty questions[] array.",
              );
            }
            const sessionId = get().activeSessionId;
            const dismissNote = agentControl.userDismissMessage;
            return await new Promise<ToolResult>((resolve) => {
              _resolveUserQuestion = resolve;
              set({
                pendingUserQuestion: {
                  sessionId,
                  toolCallId,
                  spec,
                  dismissNote,
                },
              });
            });
          }
          if (name === "get_codex_entry") {
            const id = String(params?.["id"] ?? "");
            if (id && fullyInjectedIds.has(id)) {
              const note =
                "This entry is already fully injected in the system prompt — refer to the 登場キャラクター・設定情報 section above (id, aliases, summary, custom details, full body are all there). Do not call get_codex_entry on this id again.";
              const content = { id, note };
              const json = JSON.stringify(content);
              return {
                toolCallId,
                name,
                content,
                summary: "Already injected (short-circuited)",
                tokensUsed: countTokens(json),
              };
            }
          }
          return executeTool(name, toolCallId, params);
        };

        // クライアントツールは agentMode のときだけ渡す。RAG 単独 (agent OFF)
        // ターンは tools=[] とし、Web 検索を一発注入 (OpenRouter web plugin /
        // Anthropic native) で完結させる (plugin と function-tool の混在を避ける)。
        const agentTools = agentModeForThisSend
          ? (get().sessionAgentToolsSnapshot ?? snapshotAgentTools())
          : [];
        // RAG ターンのみ Web 検索設定を Rust へ渡す。agentMode 併用時は
        // OpenRouter で server tool / 単独時は web plugin を選ばせる (agentic)。
        // Phase 2: 永続設定 (settingsStore の ai.webSearch.*) のドメイン制御 /
        // content cap を載せる。
        const settingsState = useSettingsStore.getState();
        const webSearchConfig: WebSearchConfig | null = buildWebSearchConfig(
          ragActive,
          agentModeForThisSend,
          parseWebSearchControls({
            domainMode: settingsState.get("ai.webSearch.domainMode", "off"),
            domainsJson: settingsState.get("ai.webSearch.domains", "[]"),
            maxContentTokensRaw: settingsState.get(
              "ai.webSearch.maxContentTokens",
              "",
            ),
          }),
        );
        // 中断フラグをこのターンの開始時にリセット（前ターンの取り残しを排除）。
        _agentAborted = false;
        const {
          toolCallRecords,
          finalThinkingBlocks,
          citations,
          cost,
          tokensIn: agentTokensIn,
          tokensOut: agentTokensOut,
        } = await runAgentLoop({
          messages: agentMsgs,
          tools: agentTools,
          tokenBudget,
          shouldAbort: () => _agentAborted,
          callLimitMessage: agentControl.callLimitMessage,
          tokenBudgetMessage: agentControl.tokenBudgetMessage,
          userQuestionLimitMessage: agentControl.userQuestionLimitMessage,
          sendToLLM: (msgs, tools) =>
            chatApi.sendAgentMessage(
              msgs,
              tools,
              agentThinkingParams,
              systemCacheSegmentsForAgent,
              agentApiVariant,
              webSearchConfig,
            ),
          executeTool: guardedExecuteTool,
          onProgress: (progress) => {
            set({ agentProgress: progress });
          },
          onToolComplete: (record) => {
            accToolCalls.push(record);
            set((s) => {
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                msgs[msgs.length - 1] = {
                  ...last,
                  metadata: JSON.stringify({ tool_calls: accToolCalls }),
                };
              }
              return { messages: msgs };
            });
          },
          onTextChunk: (text) => {
            set((s) => {
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                const prev = last.content;
                msgs[msgs.length - 1] = {
                  ...last,
                  content: prev ? `${prev}\n\n${text}` : text,
                };
              }
              return { messages: msgs };
            });
          },
        });

        // 引用の事後検証: 不正 URL を排除 + 本文中の裏付けなし URL を検出。
        const safeCitations = sanitizeCitations(citations);
        const answerForCheck =
          get().messages[get().messages.length - 1]?.content ?? "";
        const unbackedUrls = findUnbackedUrls(answerForCheck, safeCitations);
        if (unbackedUrls.length > 0) {
          debugLog.warn(
            "ChatStore",
            "RAG: 引用に裏付けのない URL を検出",
            unbackedUrls.join(", "),
          );
        }

        // tool_calls / thinking / 引用 / コストをまとめた最終 metadata。
        // in-memory メッセージ (UI 即時表示) と DB 永続化で共有する。
        const finalAgentMetadata = JSON.stringify({
          tool_calls: toolCallRecords,
          ...(finalThinkingBlocks.length > 0
            ? { thinking_blocks: finalThinkingBlocks }
            : {}),
          ...(safeCitations.length > 0 ? { citations: safeCitations } : {}),
          ...(cost != null ? { cost } : {}),
        });
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") {
            msgs[msgs.length - 1] = { ...last, metadata: finalAgentMetadata };
          }
          return { messages: msgs };
        });

        // Persist
        if (sessionIdForPersist) {
          const userMetadata =
            options?.mentionedSceneIds && options.mentionedSceneIds.length > 0
              ? JSON.stringify({
                  mentioned_scene_ids: options.mentionedSceneIds,
                })
              : undefined;
          await chatApi.addMessage(sessionIdForPersist, "user", content, {
            id: userMsg.id,
            ...(userMetadata ? { metadata: userMetadata } : {}),
          });
          const finalMessages = get().messages;
          const lastMsg = finalMessages[finalMessages.length - 1];
          if (lastMsg?.role === "assistant" && lastMsg.content) {
            const agentModel =
              useAiSettingsStore.getState().settings?.model ?? undefined;
            await chatApi.addMessage(
              sessionIdForPersist,
              "assistant",
              lastMsg.content,
              {
                id: assistantMsg.id,
                model: agentModel,
                // N4: 従来エージェントターンは tokens_* が常に null だった。
                // runAgentLoop が全ターン合算したトークンをここで埋める。
                tokensIn: agentTokensIn ?? undefined,
                tokensOut: agentTokensOut ?? undefined,
                metadata: finalAgentMetadata,
              },
            );
            // N4: エージェントターンの usage を台帳にも記録 (cost は OpenRouter 実値)。
            void recordAiUsage({
              surface: "agent",
              model: agentModel,
              tokensIn: agentTokensIn,
              tokensOut: agentTokensOut,
              costUsd: cost,
              traceId: assistantMsg.id,
              refId: assistantMsg.id,
            });

            // セッションタイトル自動生成 (P1-2) — fire-and-forget
            const isFirstAgentResponse =
              prevMessages.filter((m) => m.role === "assistant").length === 0;
            const currentSession = get().sessions.find(
              (s) => s.id === sessionIdForPersist,
            );
            if (isFirstAgentResponse && currentSession?.titleManual === 0) {
              const agentModel =
                useAiSettingsStore.getState().settings?.model ?? "";
              chatApi
                .generateSessionTitle(
                  content,
                  lastMsg.content,
                  agentModel,
                  projectCtx?.language ?? "ja",
                )
                .then(async (title) => {
                  if (!title) {
                    title = content.slice(0, 30);
                  }
                  await chatApi.updateSessionTitle(sessionIdForPersist, title);
                  set((state) => ({
                    sessions: state.sessions.map((s) =>
                      s.id === sessionIdForPersist ? { ...s, title } : s,
                    ),
                  }));
                })
                .catch((e) => {
                  debugLog.error(
                    "ChatStore",
                    "agent title generation",
                    errorDetail(e),
                  );
                });
            }
          }
        }
      } catch (e) {
        const kind = classifyError(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (kind === "auth") {
          toast.error(i18next.t("chat.invalidApiKey"));
        } else if (kind === "network") {
          toast.error(i18next.t("chat.networkError"));
        } else {
          toast.error(i18next.t("chat.agentFailed", { message: msg }));
        }
        set({ error: msg });
      } finally {
        // 例外で抜けた場合も含め、回答待ちの ask_user を確実に解決して
        // awaiting 中のループ Promise をリークさせない。中断フラグもリセット。
        get()._cancelPendingUserQuestion();
        _agentAborted = false;
        set({ isStreaming: false, agentProgress: null, ragSearching: false });
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Normal mode path (existing)
    // -----------------------------------------------------------------------
    try {
      const sceneCtx = effectiveSceneId
        ? await fetchSceneContext(effectiveSceneId)
        : null;
      const projectCtx = await fetchProjectContext(activeProjectId);

      const aiSettings = useAiSettingsStore.getState().settings;
      const chatModel = aiSettings?.model ?? "";
      const chatApiVariant = getChatApiVariant(chatModel);
      const { contextWindow, maxOutputTokens } = resolveModelCapabilities(
        chatModel,
        aiSettings,
        chatApiVariant,
      );
      const budgets = allocateLayerBudgets(contextWindow, { maxOutputTokens });

      let currentMessages = get().messages;
      if (sessionIdForPersist) {
        currentMessages = await maybeRunSummarization(
          sessionIdForPersist,
          prevMessages,
          budgets.l5,
          projectCtx?.language ?? "ja",
          set,
        );
      }

      // APIペイロードを構築（要約済みメッセージを除外）
      const messagesForApi: ChatMessage[] = [
        ...currentMessages.filter(
          (m) =>
            m.id !== userMsg.id && m.id !== assistantMsg.id && !m.isSummarized,
        ),
        userMsg,
      ];

      let systemCacheSegments: string[] | undefined;

      if (sceneCtx) {
        const allEntries = await listCodexEntries(getCurrentProjectId());

        // P2-5: チャットメッセージ内のCodex言及を検出し自動ピン留め
        if (sessionIdForPersist) {
          const chatMentioned = await findMentionedEntriesAsync(
            content,
            allEntries,
          );
          for (const entry of chatMentioned) {
            await chatApi
              .pinCodexEntry(
                sessionIdForPersist,
                entry.id,
                false,
                "chat_mention",
              )
              .catch(() => {});
          }

          // G20: メッセージ編集時に削除された@言及のピンを解除
          const { _editingOldContent } = get();
          if (_editingOldContent !== null) {
            try {
              const oldMentioned = await findMentionedEntriesAsync(
                _editingOldContent,
                allEntries,
              );
              const newMentionedIds = new Set(chatMentioned.map((e) => e.id));
              const removedIds = oldMentioned
                .filter((e) => !newMentionedIds.has(e.id))
                .map((e) => e.id);
              if (removedIds.length > 0) {
                await chatApi
                  .unpinCodexEntriesByIds(
                    sessionIdForPersist,
                    removedIds,
                    "chat_mention",
                  )
                  .catch(() => {});
              }
            } catch {
              // 解除失敗は無視
            }
            set({ _editingOldContent: null });
          }
        }

        const ctxResult = await buildSceneContextPrompt({
          sceneCtx,
          projectCtx,
          activeSessionId: sessionIdForPersist ?? activeSessionId,
          effectiveSceneId,
          inputPinnedEntryIds: get().inputPinnedEntryIds,
          conversationMessages: messagesForApi,
          commandInstruction,
          prefetchedEntries: allEntries,
          mentionedSceneIds: options?.mentionedSceneIds,
          sessionStableCodexIds: get().sessionStableCodexIds,
        });

        if (get().sessionStableCodexIds.length === 0) {
          set({ sessionStableCodexIds: ctxResult.stableCodexIds });
        }
        systemCacheSegments = ctxResult.cacheSegments;

        set({
          contextTokenCount: ctxResult.totalTokens,
          contextLayers: ctxResult.layers,
          lastSystemPrompt: ctxResult.prompt,
          detectedEntries: ctxResult.detectedEntries,
          alwaysEntries: ctxResult.alwaysEntries,
          cacheInvalidatedReason: null,
        });

        const systemMsg: ChatMessage = {
          id: "system",
          sessionId,
          role: "system",
          content: ctxResult.prompt,
          createdAt: new Date().toISOString(),
        };
        messagesForApi.unshift(systemMsg);
      } else {
        // シーンコンテキストなし（グローバルチャットまたはシーン未選択）:
        // @scene mention があるときは lastSystemPrompt を一時 pin 付きで再構築する。
        // 無いときは既に計算済みの lastSystemPrompt をそのまま流用する。
        if (
          options?.mentionedSceneIds &&
          options.mentionedSceneIds.length > 0
        ) {
          await get().refreshContextLayers({
            mentionedSceneIds: options.mentionedSceneIds,
          });
        }
        const fallbackPrompt = get().lastSystemPrompt;
        if (fallbackPrompt) {
          const fallbackSystemMsg: ChatMessage = {
            id: "system",
            sessionId,
            role: "system",
            content: fallbackPrompt,
            createdAt: new Date().toISOString(),
          };
          messagesForApi.unshift(fallbackSystemMsg);
        }
      }

      const chatThinkingParams = buildThinkingParams(
        chatModel,
        getEffortForTask("chat"),
        "summarized",
        aiSettings?.thinkingEnabled ?? true,
        aiSettings,
        chatApiVariant,
        aiSettings?.reasoningEffortOverride ?? undefined,
      );
      const apiPayload = messagesForApi.map((m) => ({
        role: m.role,
        // assistant 履歴の擬似ツール記法を除去してからモデルへ戻す（模倣抑止）。
        content:
          m.role === "assistant" ? stripToolProtocol(m.content) : m.content,
      }));
      const chatStartTime = performance.now();

      // Accumulate thinking text locally during streaming
      let thinkingAccumulator = "";
      const isFirstResponse =
        prevMessages.filter((m) => m.role === "assistant").length === 0;

      // CLI プロバイダ選択時は subprocess 経由のストリームに切り替える。
      // CLI は単一プロンプトしか受け付けないので、会話履歴は role タグ付きで
      // 平坦化する。
      const isCliProvider = aiSettings?.provider === "cli";
      const cliConfig = aiSettings?.cli ?? {
        kind: "claude" as const,
        binaryPath: "",
        model: "",
      };

      // Start streaming — returns a Promise<cleanup_fn>
      await new Promise<void>((resolve, reject) => {
        // delta coalesce: provider が 1:1 で emit する SSE delta(秒間 20〜40)を
        // requestAnimationFrame でまとめて flush し、streaming bubble の
        // ReactMarkdown 再パース頻度を frame rate に抑える（所見#1b）。
        // onDone/onError/stop では必ず同期 flush して末尾を取りこぼさない。
        let pendingDelta = "";
        let flushHandle: number | null = null;
        const flushDelta = () => {
          if (flushHandle !== null) {
            if (typeof cancelAnimationFrame === "function") {
              cancelAnimationFrame(flushHandle);
            }
            flushHandle = null;
          }
          if (!pendingDelta) return;
          const chunk = pendingDelta;
          pendingDelta = "";
          set((s) => {
            const msgs = [...s.messages];
            const idx = msgs.findIndex((m) => m.id === assistantMsg.id);
            if (idx >= 0) {
              msgs[idx] = {
                ...msgs[idx],
                content: msgs[idx].content + chunk,
              };
            }
            return { messages: msgs };
          });
        };
        const scheduleFlush = () => {
          if (flushHandle !== null) return;
          if (typeof requestAnimationFrame !== "function") {
            // 非ブラウザ環境(テスト等)は即時 flush にフォールバック（従来挙動）。
            flushDelta();
            return;
          }
          flushHandle = requestAnimationFrame(flushDelta);
        };
        _flushPendingDelta = flushDelta;

        const callbacks = {
          onTextDelta: (delta: string) => {
            pendingDelta += delta;
            scheduleFlush();
          },
          onThinkingDelta: (delta: string) => {
            thinkingAccumulator += delta;
          },
          onDone: (info: {
            stopReason: string;
            inputTokens?: number;
            outputTokens?: number;
            cost?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          }) => {
            // 末尾の buffered delta を確定前に同期反映。
            flushDelta();
            _flushPendingDelta = null;
            const chatDurationMs = Math.round(
              performance.now() - chatStartTime,
            );

            // N4: 通常チャットの usage を台帳に記録 (chat_messages.tokens_* とは
            // 別に、集計用の単一台帳に集約する。cost は OpenRouter streaming 実値)。
            void recordAiUsage({
              surface: "chat",
              model: chatModel || undefined,
              tokensIn: info.inputTokens,
              tokensOut: info.outputTokens,
              costUsd: info.cost ?? null,
              cacheReadTokens: info.cacheReadTokens,
              cacheWriteTokens: info.cacheWriteTokens,
              durationMs: chatDurationMs,
              traceId: assistantMsg.id,
              refId: assistantMsg.id,
            });

            // Build metadata: thinking blocks + stopped flag
            const metadataObj: Record<string, unknown> = {};
            if (thinkingAccumulator) {
              metadataObj.thinking_blocks = [{ thinking: thinkingAccumulator }];
            }
            if (info.stopReason === "stopped") {
              metadataObj.stopped = true;
            }
            const chatMetadata =
              Object.keys(metadataObj).length > 0
                ? JSON.stringify(metadataObj)
                : undefined;

            // Update final assistant message state
            set((s) => {
              const msgs = [...s.messages];
              const idx = msgs.findIndex((m) => m.id === assistantMsg.id);
              if (idx >= 0 && chatMetadata) {
                msgs[idx] = { ...msgs[idx], metadata: chatMetadata };
              }
              return { messages: msgs };
            });

            // Persist to DB
            const persistToDb = async () => {
              if (!sessionIdForPersist) return;
              const finalMessages = get().messages;
              const lastMsg = finalMessages[finalMessages.length - 1];
              const userMetadata =
                options?.mentionedSceneIds &&
                options.mentionedSceneIds.length > 0
                  ? JSON.stringify({
                      mentioned_scene_ids: options.mentionedSceneIds,
                    })
                  : undefined;
              await chatApi.addMessage(sessionIdForPersist, "user", content, {
                id: userMsg.id,
                ...(userMetadata ? { metadata: userMetadata } : {}),
              });
              if (lastMsg && lastMsg.role === "assistant" && lastMsg.content) {
                await chatApi.addMessage(
                  sessionIdForPersist,
                  "assistant",
                  lastMsg.content,
                  {
                    id: assistantMsg.id,
                    model: chatModel || undefined,
                    tokensIn: info.inputTokens,
                    tokensOut: info.outputTokens,
                    durationMs: chatDurationMs,
                    ...(chatMetadata ? { metadata: chatMetadata } : {}),
                  },
                );
              }

              // セッションタイトル自動生成 (P1-2) — fire-and-forget
              const currentSession = get().sessions.find(
                (s) => s.id === sessionIdForPersist,
              );
              if (
                isFirstResponse &&
                currentSession &&
                currentSession.titleManual === 0 &&
                lastMsg?.role === "assistant" &&
                lastMsg.content
              ) {
                chatApi
                  .generateSessionTitle(
                    content,
                    lastMsg.content,
                    chatModel,
                    projectCtx?.language ?? "ja",
                  )
                  .then(async (title) => {
                    if (!title) {
                      title = content.slice(0, 30);
                    }
                    if (sessionIdForPersist) {
                      await chatApi.updateSessionTitle(
                        sessionIdForPersist,
                        title,
                      );
                      set((state) => ({
                        sessions: state.sessions.map((s) =>
                          s.id === sessionIdForPersist ? { ...s, title } : s,
                        ),
                      }));
                    }
                  })
                  .catch((e) => {
                    debugLog.error(
                      "ChatStore",
                      "title generation",
                      errorDetail(e),
                    );
                  });
              }
            };

            persistToDb()
              .catch((e) => {
                debugLog.error(
                  "ChatStore",
                  "persist after stream",
                  errorDetail(e),
                );
              })
              .finally(() => {
                _streamCleanup?.();
                _streamCleanup = null;
                set({ isStreaming: false });
                resolve();
              });
          },
          onError: (message: string) => {
            // エラー時も partial content を保持するため同期 flush。
            flushDelta();
            _flushPendingDelta = null;
            _streamCleanup?.();
            _streamCleanup = null;
            reject(new Error(message));
          },
        };

        const streamPromise = isCliProvider
          ? cliApi.sendCliChatStream(
              {
                cli: cliConfig.kind,
                binaryPath: cliConfig.binaryPath || undefined,
                model: cliConfig.model || undefined,
                prompt: flattenMessagesForCli(apiPayload),
              },
              callbacks,
            )
          : chatApi.sendChatMessageStream(
              apiPayload,
              chatThinkingParams,
              callbacks,
              systemCacheSegments,
              chatApiVariant,
            );

        streamPromise
          .then((cleanup) => {
            _streamCleanup = cleanup;
          })
          .catch(reject);
      });
    } catch (e) {
      const kind = classifyError(e);
      const msg = e instanceof Error ? e.message : String(e);

      if (kind === "auth") {
        toast.error(i18next.t("chat.invalidApiKey"), {
          action: {
            label: i18next.t("chat.openSettings"),
            onClick: () => {
              // Signal to open settings dialog via a custom event
              window.dispatchEvent(
                new CustomEvent("open-settings", {
                  detail: { category: "ai" },
                }),
              );
            },
          },
          duration: 8000,
        });
      } else if (kind === "rate_limit") {
        // Retry after a delay for 429
        toast.warning(i18next.t("chat.rateLimited"));
        setTimeout(() => {
          get().sendMessage(content);
        }, 10_000);
        set({ isStreaming: false });
        return;
      } else if (kind === "network") {
        toast.error(i18next.t("chat.networkError"));
      } else {
        toast.error(i18next.t("chat.sendFailed", { message: msg }));
      }

      set({ error: msg });
    } finally {
      // isStreaming is set to false inside onDone/onError callbacks
      // but guard here in case of early exit
      if (get().isStreaming) {
        set({ isStreaming: false });
      }
    }
  },

  refreshContextLayers: async (opts) => {
    markStart("refreshContextLayers.ensureTokenizer");
    await ensureTokenizer();
    markEnd("refreshContextLayers.ensureTokenizer");
    const {
      activeSceneId,
      activeProjectId,
      activeSessionId,
      chatScope,
      scopeAnchorId,
    } = get();
    // 一回限りの Agent mode override（送信経路から渡る）を優先。無ければ永続トグル。
    const effectiveAgentMode = opts?.agentModeOverride ?? get().agentMode;
    // synopsis の pull 委譲は「実際にツールループが走る」provider でのみ安全。
    // CLI はツール無しで非 agent 経路に落ちる（useAgentPath の aiProvider !== "cli"）。
    // CLI で pull 委譲すると outline + 使えない取得ツール指示 + synopsis 皆無となり、
    // pull 委譲前（全 synopsis push）より文脈が悪化する。よって CLI では push を維持する。
    const aiProvider = useAiSettingsStore.getState().settings?.provider;
    const agentPullWillRunTools = effectiveAgentMode && aiProvider !== "cli";
    const effectiveSceneId = chatScope === "scene" ? activeSceneId : null;
    if (!effectiveSceneId) {
      // @scene mention の per-message pin (sendMessage 経由でのみ渡される)。
      // 通常の context bar 更新では undefined のままで従来挙動。
      // scene scope では buildSceneContextPrompt が内部で読み込むため
      // ここでは folder/project ブロックのみで取得する。
      const mentionedScenes = await loadMentionedScenes(
        opts?.mentionedSceneIds,
        effectiveSceneId,
      );
      // Folder: anchor + 祖先 folder の synopsis（outermost first）。
      // Project: フォルダ outline は L3 集約ブロックの === 見出し に含める（L2 重複回避）。
      const scopeOutlines: Array<{ title: string; outline: string }> = [];
      const allNodesForScope = useTreeStore.getState().nodes;
      if (chatScope === "folder" && scopeAnchorId) {
        const anchor = allNodesForScope.find((n) => n.id === scopeAnchorId);
        const ancestors = getAncestorFolders(allNodesForScope, scopeAnchorId);
        const chain = anchor ? [anchor, ...ancestors] : ancestors;
        for (const f of chain) {
          if (f.nodeType === "folder" && f.synopsis?.trim()) {
            scopeOutlines.push({
              title: f.title,
              outline: f.synopsis.trim(),
            });
          }
        }
        scopeOutlines.reverse(); // outermost first
      }
      // グローバルチャット: L1(project) + L4(pinned + always) のみ計算
      try {
        const [projectCtx, allEntries] = await Promise.all([
          fetchProjectContext(activeProjectId),
          listCodexEntries(getCurrentProjectId()),
        ]);

        // Phase 2 / 2.5: folder / project スコープでは 3 段階の集約 tier。
        //   Tier 1 (body 集約): includeBodies=true かつ scene≤30 かつ chars≤100k
        //   Tier 2 (synopsis 集約): scene≤200。本文は注入せず title+synopsis のみ
        //   Tier 3 (outline only): それ以上 — scopeOutlines のみ
        // project スコープ + agent mode では Tier 2 を pull 委譲（outline only）に
        // 切り替える（buildAggregatedScene 内 agentPullProject 参照）。
        let aggregatedScene: {
          id: string;
          title: string;
          content: string;
        } | null = null;
        let aggregatedDetected: CodexEntry[] = [];
        const includeBodies = get().includeBodies;
        if (chatScope === "folder" && scopeAnchorId) {
          const anchorFolder = allNodesForScope.find(
            (n) => n.id === scopeAnchorId,
          );
          const descendants = getDescendantScenesInOrder(
            allNodesForScope,
            scopeAnchorId,
          );
          if (anchorFolder) {
            const result = await buildAggregatedScene({
              anchorId: anchorFolder.id,
              anchorTitle: anchorFolder.title,
              descendants,
              includeBodies,
              activeSceneId,
              prefacePolicy: "folder",
              allEntries,
              agentMode: agentPullWillRunTools,
            });
            if (result) {
              aggregatedScene = result.aggregatedScene;
              aggregatedDetected = result.aggregatedDetected;
            }
          }
        } else if (chatScope === "project") {
          const descendants = getAllProjectScenesInOrder(allNodesForScope);
          const result = await buildAggregatedScene({
            anchorId: activeProjectId ?? "",
            anchorTitle: projectCtx?.title ?? "Project",
            descendants,
            includeBodies,
            activeSceneId,
            prefacePolicy: "project",
            allEntries,
            allNodes: allNodesForScope,
            agentMode: agentPullWillRunTools,
          });
          if (result) {
            aggregatedScene = result.aggregatedScene;
            aggregatedDetected = result.aggregatedDetected;
          }
        }

        const globalAlwaysEntries = allEntries.filter(
          (e) => e.contextMode === "always",
        );

        const L4_TOTAL_BUDGET = 60_000;
        let globalPinnedCodex: import("./contextBuilder").PinnedCodexContext[] =
          [];
        let globalPinnedSnippets: PinnedSnippetContext[] = [];
        // Compute full pin set upfront (DB + G21 in-memory) to avoid duplicate injection
        const pinnedFromDB = activeSessionId
          ? await chatApi.listPinnedCodexEntries(activeSessionId)
          : [];
        const dbPinnedIdSet = new Set(pinnedFromDB.map((e) => e.id));
        const inputIds = get().inputPinnedEntryIds;
        const g21Ids = inputIds.filter((id) => !dbPinnedIdSet.has(id));
        const allPinnedIdSet = new Set([...dbPinnedIdSet, ...g21Ids]);

        if (activeSessionId) {
          const snippetItems = await listPinnedSnippetEntries(activeSessionId);
          globalPinnedCodex = pinnedFromDB.map((e) => {
            const children = e.withChildren
              ? getChildrenFromArray(e.id, allEntries)
                  .filter((c) => !allPinnedIdSet.has(c.id))
                  .map((c) => {
                    const childAliases = parseAliases(c.aliases);
                    return {
                      id: c.id,
                      type: c.type,
                      name: c.name,
                      summary: c.summary ?? "",
                      ...(childAliases ? { aliases: childAliases } : {}),
                    };
                  })
              : undefined;
            const childrenCtx = buildChildrenCtxForEntry(
              e,
              allEntries,
              L4_TOTAL_BUDGET,
              allPinnedIdSet,
            );
            const aliases = parseAliases(e.aliases);
            const tags = parseTags(e.tagsCache);
            return {
              id: e.id,
              type: e.type,
              name: e.name,
              summary: e.summary ?? "",
              fullContent: extractPlainText(e.content) || undefined,
              withChildren: e.withChildren,
              children,
              ...(aliases ? { aliases } : {}),
              ...(tags ? { tags } : {}),
              ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
            };
          });
          globalPinnedSnippets = snippetItems.map((s) => ({
            id: s.id,
            title: s.title,
            content: extractPlainText(s.content) || s.title,
          }));
        }

        // G21: include input-typed detected entries not yet pinned to DB
        const extraPinned = g21Ids.flatMap((id) => {
          const e = allEntries.find((a) => a.id === id);
          if (!e) return [];
          const childrenCtx = buildChildrenCtxForEntry(
            e,
            allEntries,
            L4_TOTAL_BUDGET,
            allPinnedIdSet,
          );
          const aliases = parseAliases(e.aliases);
          const tags = parseTags(e.tagsCache);
          const ctx: import("./contextBuilder").PinnedCodexContext = {
            id: e.id,
            type: e.type,
            name: e.name,
            summary: e.summary ?? "",
            fullContent: extractPlainText(e.content) || undefined,
            withChildren: false,
            ...(aliases ? { aliases } : {}),
            ...(tags ? { tags } : {}),
            ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
          };
          return [ctx];
        });
        const mergedGlobalPinnedCodex = await enrichWithCustomDetails(
          [...globalPinnedCodex, ...extraPinned],
          allEntries,
        );
        const mergedGlobalPinnedIdSet = new Set(
          mergedGlobalPinnedCodex.map((e) => e.id),
        );

        const alwaysNotPinned = globalAlwaysEntries.filter(
          (e) => !mergedGlobalPinnedIdSet.has(e.id),
        );
        // Phase 2: 集約した detected をピン重複を除外して合流。
        // L5 light 入り口の `codexEntries` に detected → always の順で乗せる。
        const detectedNotPinned = aggregatedDetected.filter(
          (e) => !mergedGlobalPinnedIdSet.has(e.id),
        );
        const detectedIdSet = new Set(detectedNotPinned.map((e) => e.id));
        const alwaysNotDetected = alwaysNotPinned.filter(
          (e) => !detectedIdSet.has(e.id),
        );
        const codexLightSource = [...detectedNotPinned, ...alwaysNotDetected];
        const globalCodexEntries: CodexContext[] = codexLightSource.map((e) => {
          const aliases = parseAliases(e.aliases);
          return {
            id: e.id,
            type: e.type,
            name: e.name,
            summary: e.summary ?? "",
            ...(aliases ? { aliases } : {}),
          };
        });

        // Map overlay: scope と直交するため folder/project 経路でも注入する。
        const mapBoardMarkdown = await loadMapBoardMarkdown(allEntries);
        const promptResult = buildSystemPrompt({
          scene: aggregatedScene
            ? {
                id: aggregatedScene.id,
                title: aggregatedScene.title,
                content: aggregatedScene.content,
              }
            : { id: "", title: "", content: "" },
          project: projectCtx ?? undefined,
          codexEntries:
            globalCodexEntries.length > 0 ? globalCodexEntries : undefined,
          pinnedCodexEntries:
            mergedGlobalPinnedCodex.length > 0
              ? mergedGlobalPinnedCodex
              : undefined,
          pinnedSnippets:
            globalPinnedSnippets.length > 0 ? globalPinnedSnippets : undefined,
          chapterOutlines: scopeOutlines.length > 0 ? scopeOutlines : undefined,
          mentionedScenes:
            mentionedScenes.length > 0 ? mentionedScenes : undefined,
          lang: projectCtx?.language ?? "ja",
          agentMode: effectiveAgentMode,
          mapBoardMarkdown,
          customChatInstruction: useSettingsStore
            .getState()
            .get("aiPrompt.custom.chat", ""),
        });

        set({
          contextTokenCount: promptResult.totalTokens,
          contextLayers: promptResult.layers,
          lastSystemPrompt: promptResult.prompt,
          detectedEntries: detectedNotPinned,
          alwaysEntries: alwaysNotDetected,
          projectOutline: projectCtx?.outline ?? undefined,
          chapterOutlines: scopeOutlines,
        });
      } catch {
        set({
          contextTokenCount: 0,
          contextLayers: [],
          projectOutline: undefined,
          chapterOutlines: [],
        });
      }
      return;
    }
    try {
      const [sceneCtx, projectCtx] = await Promise.all([
        fetchSceneContext(effectiveSceneId),
        fetchProjectContext(activeProjectId),
      ]);
      if (!sceneCtx) return;

      // scene scope の eco モード: includeBodies=false なら content を空に
      // して buildSystemPrompt の `### シーン本文` セクションを抑制する。
      // synopsis や foreshadow など本文以外の情報はそのまま残る。
      // 副作用として codex auto-detect も synopsis ベースになる。
      if (!get().includeBodies) {
        sceneCtx.content = "";
      }

      const ctxResult = await buildSceneContextPrompt({
        sceneCtx,
        projectCtx,
        activeSessionId,
        effectiveSceneId,
        inputPinnedEntryIds: get().inputPinnedEntryIds,
        conversationMessages: get().messages.filter((m) => !m.isSummarized),
        agentMode: get().agentMode,
        mentionedSceneIds: opts?.mentionedSceneIds,
      });

      set({
        contextTokenCount: ctxResult.totalTokens,
        contextLayers: ctxResult.layers,
        lastSystemPrompt: ctxResult.prompt,
        detectedEntries: ctxResult.detectedEntries,
        alwaysEntries: ctxResult.alwaysEntries,
        projectOutline: ctxResult.projectOutline,
        chapterOutlines: ctxResult.chapterOutlines,
        pinsVersion: get().pinsVersion + 1,
      });
    } catch {
      // コンテキスト計算失敗は無視（送信時に再計算される）
    }
  },

  setAgentMode: (on: boolean) => set({ agentMode: on }),
  setRagEnabled: (on: boolean) => set({ ragEnabled: on }),

  // --- ask_user（ユーザーへの質問）の解決 ---
  resolveUserQuestion: (answer: AskUserContent) => {
    const pending = get().pendingUserQuestion;
    if (!pending) return;
    // ask 発行時と別セッションに切り替わっていたら適用しない
    // （切替時は _cancelPendingUserQuestion が既に sentinel 解決しているはず）。
    if (pending.sessionId !== get().activeSessionId) {
      return;
    }
    const result = buildAskUserResult(
      pending.toolCallId,
      answer,
      pending.dismissNote,
    );
    _resolveUserQuestion?.(result);
    _resolveUserQuestion = null;
    set({ pendingUserQuestion: null });
  },

  dismissUserQuestion: () => {
    get().resolveUserQuestion({ answers: [], dismissed: true });
  },

  _cancelPendingUserQuestion: () => {
    if (_resolveUserQuestion) {
      // 非自発的キャンセル（Stop / セッション切替 / error）の単一ファネル。
      // Promise を sentinel 解決するだけでは、再開したループが tool_result を
      // 積んで次ターンを発火し、別セッションへ stream を漏らす。ここで中断
      // フラグも立て、resolve で再開したループが shouldAbort を見て即 return
      // するようにする。自発的な Answer/dismiss は resolveUserQuestion 経由で
      // この関数を通らないため、フラグは立たずループは正常継続する。
      _agentAborted = true;
      const pending = get().pendingUserQuestion;
      _resolveUserQuestion(
        dismissedAskUserResult(
          pending?.toolCallId ?? "ask_user_cancelled",
          pending?.dismissNote ?? "",
        ),
      );
      _resolveUserQuestion = null;
    }
    if (get().pendingUserQuestion) set({ pendingUserQuestion: null });
  },

  setChatScope: (scope, anchorId) => {
    // scope === "folder" のとき anchorId 必須。空指定なら scene に fallback。
    // includeBodies は scope ごとのデフォルトに揃え直す: scene=true, folder=false。
    // project では本文集約しないので値自体は影響しないが false に揃える。
    if (scope === "folder") {
      if (!anchorId) {
        set({ chatScope: "scene", scopeAnchorId: null, includeBodies: true });
        return;
      }
      set({
        chatScope: "folder",
        scopeAnchorId: anchorId,
        includeBodies: false,
      });
      return;
    }
    set({
      chatScope: scope,
      scopeAnchorId: null,
      includeBodies: scope === "scene",
    });
  },
  setIncludeBodies: (on: boolean) => set({ includeBodies: on }),
  setIncludeMapBoard: (on, options) => {
    // 現状 source は telemetry / 将来拡張用。動作上は user/auto 共通で
    // includeMapBoard と mapBoardId を更新するだけ（panel/board 変更で
    // 再同期される設計のため、override セマンティクスは持たない）。
    const next: Partial<ChatState> = { includeMapBoard: on };
    if (options?.boardId !== undefined) {
      next.mapBoardId = options.boardId;
    } else if (!on) {
      // OFF 時は board 参照もクリアして stale な id を残さない
      next.mapBoardId = null;
    }
    set(next);
  },

  // --- P2-1: ストリーミング中断 ---
  stopGeneration: () => {
    // agent ループの中断を要求してから、回答待ちの ask_user を sentinel 解決する。
    // フラグを先に立てるので、resolve で再開したループは shouldAbort を見て
    // tool_result を送らずに即 return する（stop が agent path を止められない
    // 問題への対処）。フラグ→resolve の順序が肝。
    _agentAborted = true;
    // CLI subprocess と HTTP ベースのストリームは別系統なので、
    // 現在のプロバイダに合わせた abort を発火する。両方発火しても害は無いが、
    // CLI 用フラグはアプリ全体で 1 つしかないため不要な reset を避ける。
    const provider = useAiSettingsStore.getState().settings?.provider;
    if (provider === "cli") {
      void cliApi.abortCliChatStream().catch(() => {});
    } else {
      void chatApi.abortChatStream().catch(() => {});
    }
    // abort 前に buffered delta を確定（onDone/onError が来ない hard-abort 対策）。
    _flushPendingDelta?.();
    _flushPendingDelta = null;
    _streamCleanup?.();
    _streamCleanup = null;
    get()._cancelPendingUserQuestion();
    set({ isStreaming: false, agentProgress: null, ragSearching: false });
  },

  // --- P2-2: メッセージ削除 ---
  deleteMessage: async (messageId: string) => {
    const { activeSessionId, messages } = get();
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const msg = messages[idx];
    try {
      if (msg.role === "user") {
        // ユーザーメッセージ: 以降のメッセージも全削除
        const toDelete = messages.slice(idx).filter((m) => m.role !== "system");
        if (activeSessionId) {
          for (const m of toDelete) {
            await chatApi.deleteMessage(m.id);
          }
        }
        set({ messages: messages.slice(0, idx) });
      } else {
        // AIメッセージ: 単独削除
        if (activeSessionId) {
          await chatApi.deleteMessage(messageId);
        }
        set({ messages: messages.filter((m) => m.id !== messageId) });
      }
    } catch (e) {
      toast.error(i18next.t("chat.deleteMessageFailed"));
      debugLog.error("ChatStore", "deleteMessage", errorDetail(e));
    }
  },

  // --- P2-2: ユーザーメッセージ編集 (内容を返し、以降を削除) ---
  editUserMessage: (messageId: string) => {
    const { activeSessionId, messages } = get();
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return { content: "" };
    const msg = messages[idx];
    const content = msg.content;
    const mentionedSceneIds = parseMentionedSceneIdsFromMetadata(msg.metadata);
    const toDelete = messages.slice(idx).filter((m) => m.role !== "system");
    if (activeSessionId) {
      Promise.all(toDelete.map((m) => chatApi.deleteMessage(m.id))).catch((e) =>
        debugLog.error("ChatStore", "editUserMessage", errorDetail(e)),
      );
    }
    // G20: save old content to detect removed @mentions on re-send
    set({ messages: messages.slice(0, idx), _editingOldContent: content });
    return mentionedSceneIds ? { content, mentionedSceneIds } : { content };
  },

  // --- P2-2: AIメッセージ再生成 ---
  regenerate: async (
    assistantMessageId: string,
    options?: { withAgentMode?: boolean },
  ) => {
    const { messages, activeSessionId } = get();
    const assIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (assIdx === -1) return;

    // 直前のユーザーメッセージを探す
    const userMsg = [...messages]
      .slice(0, assIdx)
      .reverse()
      .find((m) => m.role === "user");
    if (!userMsg) return;

    // @scene mention の per-message pin は user メッセージの metadata
    // (`mentioned_scene_ids`) に永続化されている。再生成時に復元しないと
    // 元の prompt と再生成 prompt で context が食い違うので拾い直す。
    const mentionedSceneIds = parseMentionedSceneIdsFromMetadata(
      userMsg.metadata,
    );

    // アシスタントメッセージを削除
    if (activeSessionId) {
      try {
        await chatApi.deleteMessage(assistantMessageId);
      } catch (e) {
        debugLog.error("ChatStore", "regenerate delete", errorDetail(e));
      }
    }
    set({ messages: messages.filter((m) => m.id !== assistantMessageId) });

    // 再送信 (ユーザーメッセージは既にstateにある)
    // withAgentMode: 一回限りの Agent mode 切替で再試行する場合
    const sendOptions: {
      overrideAgentMode?: boolean;
      mentionedSceneIds?: string[];
    } = {};
    if (options?.withAgentMode) sendOptions.overrideAgentMode = true;
    if (mentionedSceneIds) sendOptions.mentionedSceneIds = mentionedSceneIds;
    await get().sendMessage(
      userMsg.content,
      undefined,
      Object.keys(sendOptions).length > 0 ? sendOptions : undefined,
    );
  },

  clearMessages: () => set({ messages: [] }),
  clearError: () => set({ error: null }),
  setActiveSceneId: (id: string) => {
    markStart("chatStore.setActiveSceneId");
    try {
      const { activeSceneId, chatScope } = get();
      // tree の active scene が変わったときは activeSceneId を更新。
      // scope === "scene" のときは anchor が active scene を追従するため、
      // セッションを切り替えるべく activeSessionId / messages をリセット。
      // scope === "folder" / "project" のときは scope axis が sticky で、
      // anchor は user 選択を維持する（=セッションも維持）。
      if (id !== activeSceneId) {
        if (chatScope === "scene") {
          set({
            activeSceneId: id,
            activeSessionId: null,
            messages: [],
          });
        } else {
          set({ activeSceneId: id });
        }
      } else {
        set({ activeSceneId: id });
      }
    } finally {
      markEnd("chatStore.setActiveSceneId");
    }
  },
  setActiveProjectId: (id: string | null) => set({ activeProjectId: id }),
}));
