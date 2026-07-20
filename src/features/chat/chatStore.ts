import { create } from "zustand";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import {
  getCurrentImeWorkspaceIdentity,
  isCurrentImeWorkspaceIdentity,
  type ImeWorkspaceIdentity,
} from "@/features/ime/workspaceScope";
import * as chatApi from "./chatApi";
import { resolveModelForPath, resolveRolePathConfig } from "./modelRouting";
import { debugLog, errorDetail } from "@/lib/debugLog";

// ---------------------------------------------------------------------------
// D-17: Error classification and retry helpers
// ---------------------------------------------------------------------------

/** 429（レート制限）で streaming 送信を自動リトライする最大回数。 */
const MAX_RATE_LIMIT_RETRIES = 3;

function classifyError(
  e: unknown,
): "auth" | "rate_limit" | "network" | "context_length" | "unknown" {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized|authentication|api\.key|invalid\.key/i.test(msg))
    return "auth";
  if (/429|rate.?limit|too.?many.?request/i.test(msg)) return "rate_limit";
  if (/network|connect|timeout|fetch|ECONNREFUSED/i.test(msg)) return "network";
  if (
    /AI_CONTEXT_WINDOW_EXCEEDED|context.window.exceeded|context.length.exceeded|maximum.context|token.limit|too.long|content.too.large/i.test(
      msg,
    )
  )
    return "context_length";
  return "unknown";
}

import {
  countTokens,
  allocateLayerBudgets,
  ensureTokenizer,
  getTokenEstimatorFamily,
} from "./contextBuilder";
import type {
  SceneContext,
  ProjectContext,
  CodexContext,
  LayerBreakdown,
  BuildSystemPromptInput,
} from "./contextBuilder";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { fetchProjectContext as fetchProjectContextAtom } from "@/features/project/contextAtoms";
import { runAgentLoop } from "./agent/agentLoop";
import { resolveAgentPrivacyPlan } from "./agent/agentPrivacy";
import { executeTool, executeReadOnlyTool } from "./agent/toolExecutors";
import {
  snapshotAgentTools,
  getResearchSubagentTools,
  RESEARCH_SUBAGENT_TOOL,
} from "./agent/toolDefinitions";
import {
  buildAskUserResult,
  dismissedAskUserResult,
  invalidAskUserResult,
  normalizeAskUserSpec,
} from "./agent/askUser";
import {
  getToolTokenBudget,
  getAgentToolCallBudget,
  buildThinkingParams,
  getEffortForTask,
  resolveModelCapabilities,
} from "./agent/modelLimits";
import { useAiSettingsStore, isRagCapableProvider } from "./store";
import type { AiProvider } from "./types";
import {
  finalizeTurnPayload,
  selectsCacheSystemDelivery,
} from "@/features/ai-context/finalizeTurnPayload";
import { planChatContext } from "./context/chatContextPlanner";
import {
  createNonSceneTurnContextRequest,
  createSceneTurnContextRequest,
  type CreateNonSceneTurnContextRequestInput,
  type ContextPlanningPurpose,
  type ContextScopeTarget,
  type SceneTurnContextRequest,
} from "./context/turnContextRequest";
import { createDefaultContextPlannerDeps } from "./context/defaultContextPlannerDeps";
import {
  collectSceneContext,
  createSceneContextSourceDeps,
  type SceneContextSourceDeps,
} from "./context/sources/sceneContextSource";
import type { ChatContextPlan } from "./context/types";
import {
  createNonSceneContextPlannerDeps,
  planNonSceneChatContext,
} from "./context/nonSceneContextPlanner";
import { renderLegacyPrompt } from "./context/legacyPromptAdapter";
import {
  resolveChatTurnRoute,
  type ResolvedChatTurnRoute,
} from "./turn/resolveTurnRoute";
import {
  renderAgentConversationPayloads,
  renderAgentToolPayloads,
} from "./turn/renderAgentPayload";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import {
  accumulateInputTokenDrift,
  buildInputTokenDriftMetadata,
  createInputTokenDriftTotals,
  type InputTokenRouteSnapshot,
} from "@/features/ai-usage/inputTokenDrift";
import { sanitizeCitations, findUnbackedUrls } from "./citationVerify";
import {
  fetchSemanticRecall,
  SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS,
} from "./semanticRecall";
import { fetchChatRecall } from "./chatRecall";
import {
  createRecallPromoteTracker,
  trackRecallForPromote,
  dismissRecallPromote,
  resetRecallPromote,
  type RecallPromoteSuggestion,
} from "./chatRecallPromote";
import { stripToolProtocol } from "./toolProtocol";
import {
  buildWebSearchConfig,
  parseWebSearchControls,
} from "./webSearchConfig";
import * as cliApi from "./cliApi";
import * as codexAppApi from "./codexAppApi";
import {
  buildCodexBootstrapHistory,
  computeChatHistoryRevision,
} from "./historyRevision";
import { resolveSendApiVariant } from "./aiNovelist";
import { createAgentTextBatcher } from "./agent/agentTextBatcher";
import { readDocumentRuntimeTarget } from "@/runtime/runtimeDocumentTarget";

function getChatApiVariant(model: string): string | undefined {
  const { settings, models } = useAiSettingsStore.getState();
  return resolveSendApiVariant(settings, models, model);
}

/**
 * Web Editor sessions must not inherit the desktop-only database model
 * default. An empty string records the truthful "not configured yet" state;
 * native runtimes keep omitting the column so their established default is
 * unchanged.
 */
function createSessionForCurrentRuntime(
  projectId: string,
  title: string,
  nodeId?: string,
  codexAnchorId?: string,
  snippetAnchorId?: string,
) {
  const webModel =
    readDocumentRuntimeTarget() === "web"
      ? (useAiSettingsStore.getState().settings?.model ?? "")
      : undefined;
  if (webModel === undefined) {
    return chatApi.createSession(
      projectId,
      title,
      nodeId,
      codexAnchorId,
      snippetAnchorId,
    );
  }
  return chatApi.createSession(
    projectId,
    title,
    nodeId,
    codexAnchorId,
    snippetAnchorId,
    webModel,
  );
}

/**
 * composer のモデルピッカーで「別プロバイダ」のモデルを選んだ場合の override を返す。
 * cross-provider override は provider/model/variant を一括で決め、per-role routing より
 * 優先する(明示的かつ即時のユーザー選択で、provider と model の名前空間整合を保つため)。
 * 同一プロバイダ内の一時モデル(chatProviderOverride==null)や未選択時は null を返し、
 * 呼び出し側は従来ロジック(role routing / getChatApiVariant)に委ねる(= 回帰なし)。
 *
 * variant は選択時に resolveModelApiVariant で確定済みの値(active provider の models へ
 * 依存しない)。null は backend 既定解決を意味するため undefined に正規化して返す。
 */
function getCrossProviderChatOverride(): {
  provider: AiProvider;
  model: string;
  variant: string | undefined;
  /**
   * OpenAI 互換で別エンドポイントのモデルを選んだ場合の endpoint id。
   * provider は "openai-compatible" のまま（同一プロバイダの別サーバ）でも、この値で
   * 送信先 base_url / API キーを切り替える。他プロバイダ選択時は undefined。
   */
  endpointId: string | undefined;
} | null {
  const st = useAiSettingsStore.getState();
  const provider = st.chatProviderOverride;
  const model = st.chatModelOverride;
  if (!provider || !model) return null;
  return {
    provider,
    model,
    variant: st.chatModelVariantOverride ?? undefined,
    endpointId: st.chatEndpointIdOverride ?? undefined,
  };
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

const TURN_PAYLOAD_SAFETY_MARGIN_TOKENS = 32;

function estimateMessageEnvelopeTokens(
  messages: ReadonlyArray<{ role: string; content: string }>,
): number {
  // Provider tokenizers account for role/message boundaries differently. Keep
  // this explicit and conservative; exact text content is measured separately.
  return messages.length * 4 + (messages.length > 0 ? 2 : 0);
}

function finalizeChatTurnPayload(input: {
  route: ResolvedChatTurnRoute;
  fallbackSystemPrompt: string;
  cacheSegments?: string[];
  volatileTail?: string;
  messages: AgentMessagePayload[] | Array<{ role: string; content: string }>;
  tools?: AgentToolDefinition[];
  webSearch?: WebSearchConfig | null;
}) {
  const isAgentPayload = input.tools !== undefined;
  const renderedToolPayloads = isAgentPayload
    ? renderAgentToolPayloads(input.route, input.tools ?? [], input.webSearch)
    : input.webSearch?.enabled
      ? [JSON.stringify(input.webSearch)]
      : [];
  const renderedConversationPayloads = isAgentPayload
    ? renderAgentConversationPayloads(
        input.route,
        input.messages as AgentMessagePayload[],
      )
    : undefined;
  return finalizeTurnPayload(
    {
      route: input.route,
      system: {
        fallback: input.fallbackSystemPrompt,
        cacheSegments: input.cacheSegments,
        volatileTail: input.volatileTail,
      },
      messages: input.messages,
      renderedConversationPayloads,
      renderedToolPayloads,
      envelopeTokens: isAgentPayload
        ? 0
        : estimateMessageEnvelopeTokens(input.messages),
      safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
    },
    countTokens,
  );
}

function materializeSystemDeliverySnapshot(
  finalized: ReturnType<typeof finalizeChatTurnPayload>,
): string {
  return finalized.systemDelivery.kind === "plain"
    ? finalized.systemDelivery.text
    : finalized.systemDelivery.blocks.map((block) => block.text).join("");
}

function snapshotInputTokenRoute(
  route: ResolvedChatTurnRoute,
): InputTokenRouteSnapshot {
  return {
    surface: route.surface,
    provider: route.provider,
    model: route.model,
    apiVariant: route.apiVariant,
    requestedEndpointId: route.endpointId,
    resolvedEndpointId: route.resolvedEndpointId,
    toolProtocol: route.toolProtocol,
    contextWindow: route.contextWindow,
  };
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
import { useTreeStore } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { loadSceneContent, loadScenesFull, getNode } from "@/features/tree/api";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { computeSceneThreadContext } from "@/features/plot-threads/sceneThreadTracks";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { prosemirrorToText } from "@/lib/prosemirror";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  listCodexContextMetadata,
  listCodexEntriesForContext,
  listCodexEntriesForContextByIds,
} from "@/features/codex/api";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import {
  listEvents,
  listEventParticipantsForProject,
  listSceneEventsForProject,
  getProjectCalendar,
  listEventRelations,
} from "@/features/chronicle/api";
import { assembleChronicleSnapshotText } from "@/features/chronicle/chronicleSnapshot";
import type { SceneChronicle } from "@/features/chronicle/resolveSceneAnchor";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { calendarFromRow } from "@/features/chronicle/chronicleTime";
import type { EventPrecision } from "@/db/schema";
import {
  getCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import { markStart, markEnd } from "@/lib/perfLog";
import {
  getDescendantsBFS,
  buildChildrenContext,
  computeChildrenTokenBudget,
  collectBudgetedDescendantIds,
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
import type { CodexEntry, CodexContextEntry } from "@/features/codex/api";
import {
  listContextDetailsByEntryIds,
  listRawDetailValuesByEntryIds,
} from "@/features/codex/detailApi";
import { detailValueToPlainText } from "@/features/codex/detailCleanup";
import {
  listPhasesByEntryIds,
  listDetailOverridesByPhaseIds,
} from "@/features/codex/phaseApi";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import {
  resolveCodexState,
  formatTimelineContext,
} from "@/features/codex/phaseResolver";
import type {
  PhaseResolutionMode,
  ResolvedCodexState,
  SceneTimeIndex,
} from "@/features/codex/phaseResolver";
import {
  getEntryScanText,
  findReverseMentioningEntries,
} from "@/features/codex/codexCrossMentions";
import {
  resolveScopeSessionKey,
  type ChatScope,
  type ScopeSessionKey,
} from "./chatScope";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTabStore } from "@/features/editor/tabStore";
import { getSnippet } from "@/features/snippets/api";
import { setSnippetDeletedHandler } from "@/features/snippets/anchorNotify";
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
// (M10: icon/notes は読まないので context projection 行を受ける。全列行も可)
async function resolveEntriesForContext(
  entries: CodexContextEntry[],
  effectiveSceneId: string | null,
  opts?: { applyAllPhases?: boolean },
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

  const phaseState = usePhaseStore.getState();
  const temporalAnchor = opts?.applyAllPhases
    ? ({ kind: "latest" } as const)
    : effectiveSceneId
      ? ({ kind: "scene", sceneId: effectiveSceneId } as const)
      : ({ kind: "base" } as const);

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
        temporalAnchor,
        phaseState.sceneTimeIndex,
        phaseState.resolutionMode,
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
  allEntries: CodexContextEntry[],
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
    let resolved: string;
    if (d.fieldType === "codex_reference") {
      // codex_reference: resolve entry ID → name
      const ref = allEntries.find((e) => e.id === d.value);
      resolved = ref ? ref.name : d.value;
    } else {
      // text 値は PM JSON で保存されている。生 JSON を注入しない
      resolved = detailValueToPlainText(d.value);
    }
    if (resolved.trim() === "") continue;
    const arr = byEntryId.get(d.entryId) ?? [];
    arr.push({ fieldName: d.fieldName, value: resolved });
    byEntryId.set(d.entryId, arr);
  }

  return entries.map((entry) => {
    const customDetails = byEntryId.get(entry.id);
    return customDetails?.length ? { ...entry, customDetails } : entry;
  });
}

// Helper: compute childrenContext for pinned/G21 entries based on childrenBudget.
// resolvedById を渡すと子孫 summary を phase 解決済みで注入する（Phase Cb）。
function buildChildrenCtxForEntry(
  entry: Pick<CodexEntry, "id" | "childrenBudget">,
  allEntries: CodexContextEntry[],
  l4Budget: number,
  excludeIds?: Set<string>,
  resolvedById?: ReadonlyMap<
    string,
    { summary: string | null; content: string }
  >,
): string | undefined {
  const preset = entry.childrenBudget ?? "compact";
  if (preset === "none") return undefined;
  const budget = computeChildrenTokenBudget(preset, l4Budget);
  const descendants = getDescendantsBFS(entry.id, allEntries).filter(
    (d) => !excludeIds?.has(d.id),
  );
  return buildChildrenContext(descendants, budget, resolvedById) || undefined;
}

type CapturedNonSceneRequestSeed = Omit<
  CreateNonSceneTurnContextRequestInput,
  | "requestId"
  | "purpose"
  | "sessionId"
  | "messages"
  | "outgoingUserMessage"
  | "commandInstruction"
  | "mentionedSceneIds"
  | "mentionedCodexIds"
>;

interface CapturedNonSceneContextAuthority {
  requestSeed: CapturedNonSceneRequestSeed;
  temporalResolution: {
    sceneTimeIndex: SceneTimeIndex;
    resolutionMode: PhaseResolutionMode;
  };
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
  /** Context window used by the finalized turn route (null before resolution). */
  contextWindowSize: number | null;
  /** Model paired with contextTokenCount/contextWindowSize. */
  contextModel: string | null;
  contextLayers: LayerBreakdown[];
  /** Typed selection plan behind contextLayers and the rendered prompt. */
  contextPlan: ChatContextPlan | null;
  lastSystemPrompt: string;
  /** lastSystemPrompt がどのスコープ構成（scope/anchor/scene/session）で
   * 構築されたかの識別キー（contextPromptKey）。null = 未構築。
   * sendMessage の非 scene 分岐が「スコープ切替直後の即送信」で前の構成の
   * プロンプトを流用しないための照合に使う。 */
  lastSystemPromptKey: string | null;
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
   * scene スコープ以外は RAG 対象外のためライブ値をそのまま返す。 */
  buildPreviewPrompt: () => Promise<{
    prompt: string;
    layers: LayerBreakdown[];
    totalTokens: number;
    /** プレビューに描画する「これから送る入力メッセージ」。空文字なら非表示。 */
    userMessage: string;
  }>;
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
  ) => Promise<void>;
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
      /** 429 リトライの内部カウンタ（外部呼び出しでは指定しない）。
       * 上限は MAX_RATE_LIMIT_RETRIES。 */
      _rateLimitRetry?: number;
    },
  ) => Promise<void>;
  buildPromptForCopy: (
    userInput: string,
    options?: { mentionedSceneIds?: string[]; mentionedCodexIds?: string[] },
  ) => Promise<string>;
  /** ChatInput の入力中テキスト getter を登録 / 解除(null で解除)。
   * buildPreviewPrompt が seed と表示に使う。 */
  registerInputDraftProvider: (
    provider:
      | (() => {
          markdown: string;
          mentionedSceneIds: string[];
          mentionedCodexIds: string[];
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
    /** Internal send-time snapshot captured before the turn's first await. */
    capturedNonSceneAuthority?: CapturedNonSceneContextAuthority;
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
  }) => Promise<{
    prompt: string;
    totalTokens: number;
    layers: LayerBreakdown[];
    contextPlan: ChatContextPlan;
    cacheSegments?: string[];
    volatileTail?: string;
    fullyInjectedIds: string[];
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
  excludeEntryFromAuto: (entryId: string) => boolean;
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

async function maybeRunSummarization(
  sessionId: string,
  messages: ChatMessage[],
  l5Budget: number,
  lang: string,
  set: (
    partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
  ) => void,
  isAuthorized: () => boolean,
): Promise<ChatMessage[]> {
  await ensureTokenizer();
  if (!isAuthorized()) return messages;
  let summaries: Awaited<ReturnType<typeof chatApi.listSummaries>> = [];
  try {
    summaries = await chatApi.listSummaries(sessionId);
  } catch {
    return messages;
  }
  if (!isAuthorized()) return messages;

  const summaryTexts = summaries.map((s) => s.summary);
  const l5Used = computeL5UsedTokens(messages, summaryTexts, l5Budget);
  const maxGen =
    summaries.length > 0 ? Math.max(...summaries.map((s) => s.generation)) : 0;

  if (isAuthorized()) {
    set({
      summaryCount: summaries.length,
      maxSummaryGeneration: maxGen,
    });
  }

  if (!shouldSummarize(messages, l5Budget, l5Used)) {
    return messages;
  }

  const candidates = selectSummarizationCandidates(messages, l5Budget);
  if (candidates.length === 0) return messages;

  try {
    const generation = await chatApi.getSummaryGeneration(sessionId);
    if (!isAuthorized()) return messages;
    const previousSummary = getPreviousSummaryText(summaries);
    const candidateIds = candidates.map((m) => m.id);
    const lastMsgId = candidateIds[candidateIds.length - 1]!;

    const summaryText = await runSummarization(
      candidates,
      // cheap ロール: 要約は injected callback 経由で model/provider/endpoint override を渡す。
      (messages, thinkingParams) => {
        if (!isAuthorized()) {
          return Promise.reject(new Error("chat turn authority changed"));
        }
        const aiState = useAiSettingsStore.getState();
        const role = resolveRolePathConfig("summarization");
        const route = aiState.settings
          ? resolveChatTurnRoute({
              surface: "chat",
              activeSettings: aiState.settings,
              activeApiVariant: getChatApiVariant(aiState.settings.model),
              role: role
                ? {
                    model: role.model,
                    provider: role.provider,
                    apiVariant: role.provider
                      ? role.variant
                      : getChatApiVariant(role.model),
                    endpointId: role.endpointId,
                  }
                : null,
              taskEffort: "low",
              thinkingDisplay: "summarized",
              thinkingEnabled: aiState.settings.thinkingEnabled,
              reasoningEffortOverride:
                aiState.settings.reasoningEffortOverride ?? undefined,
            })
          : null;
        if (route) {
          finalizeChatTurnPayload({
            route,
            fallbackSystemPrompt: "",
            messages,
          });
        }
        return chatApi.sendChatMessageWithThinking(
          messages,
          route?.thinking ?? thinkingParams,
          undefined,
          route?.apiVariant ?? null,
          undefined,
          route?.model ?? role?.model ?? null,
          route ? route.providerOverride : (role?.provider ?? null),
          route ? route.endpointId : (role?.endpointId ?? null),
          route?.outputBudget.requestMaxOutputTokens ?? null,
          route?.provider ?? null,
          route?.resolvedEndpointId ?? null,
        );
      },
      {
        lang,
        previousSummary,
        generation,
        sourceMsgCount: candidates.length,
        lastMsgId,
      },
    );
    if (!isAuthorized()) return messages;

    const tokenCount = estimateSummaryTokenCount(summaryText);
    if (!isAuthorized()) return messages;
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
    if (!isAuthorized()) return messages;
    await chatApi.markMessagesSummarized(candidateIds);
    if (!isAuthorized()) return messages;

    let resultMessages = messages;
    set((s) => {
      if (!isAuthorized()) return {};
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
  treeNodesSnapshot?: readonly TreeNodeData[],
): Promise<Array<{ id: string; title: string; content: string }>> {
  if (!ids || ids.length === 0) return [];
  const allNodes = treeNodesSnapshot ?? useTreeStore.getState().nodes;
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
  expectedProjectId: string,
): Promise<SceneContext | null> {
  let node: Awaited<ReturnType<typeof getNode>>;
  let content: Awaited<ReturnType<typeof loadSceneContent>>;
  try {
    [node, content] = await Promise.all([
      getNode(sceneId),
      loadSceneContent(sceneId),
    ]);
  } catch {
    return null;
  }
  if (!node) return null;
  // Persisted tree rows always carry projectId. The optional guard only keeps
  // legacy test doubles compatible while production fails closed on a stale
  // scene id left behind by a project switch.
  if (node.projectId && node.projectId !== expectedProjectId) {
    throw new Error("scene context project mismatch");
  }
  return {
    id: node.id,
    title: node.title,
    synopsis: node.synopsis ?? undefined,
    intent: node.intent ?? undefined,
    content: prosemirrorToText(content ?? ""),
    contentJson: content ?? "",
    storyTimeLabel: node.storyTimeLabel ?? null,
  };
}

// fetchProjectContext は features/project/contextAtoms に切り出して
// Map AI Branch と共有。chatStore 側はラッパーで既存 callsite を維持。
async function fetchProjectContext(
  projectId: string | null,
): Promise<ProjectContext | null> {
  return fetchProjectContextAtom(projectId);
}

/** A turn with a captured project must not silently lose L1 policy/instructions. */
async function fetchRequiredProjectContext(
  projectId: string,
): Promise<ProjectContext> {
  const project = await fetchProjectContext(projectId);
  if (!project) {
    throw new Error("required project context is unavailable");
  }
  return project;
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

/** Codex スコープ: 選択エントリの最終状態 + 関連 L1 + relation 展開。 */
export async function buildCodexScopeBlocks(opts: {
  selectedEntryId: string;
  allEntries: CodexContextEntry[];
  /** project 言語 (timeline 文脈の見出し英語化に使用)。 */
  lang?: string | null;
}): Promise<{
  selectedPinned: import("./contextBuilder").PinnedCodexContext;
  relatedMentioned: CodexContextEntry[];
  relationExpanded: CodexContext[];
} | null> {
  const { selectedEntryId, allEntries, lang } = opts;
  const selected = allEntries.find((e) => e.id === selectedEntryId);
  if (!selected) return null;

  const L4_TOTAL_BUDGET = 60_000;
  const { resolved, phases: phasesMap } = await resolveEntriesForContext(
    [selected],
    null,
    { applyAllPhases: true },
  );
  const resolvedState = resolved.get(selected.id);
  if (!resolvedState) return null;

  const phases = phasesMap.get(selected.id) ?? [];
  const allNodes = useTreeStore.getState().nodes;
  const phaseById = new Map(phases.map((phase) => [phase.id, phase] as const));
  // The resolver owns mixed story-time fallback and deterministic tie-breaks.
  // Reusing its applied order keeps the timeline text byte-consistent with the
  // overrides that produced resolvedState; the compatibility total-order map
  // cannot represent entry-specific story fallback.
  const validPhases = resolvedState.appliedPhaseIds.flatMap((phaseId) => {
    const phase = phaseById.get(phaseId);
    return phase ? [phase] : [];
  });

  const timelinePhases = validPhases.map((phase) => {
    const anchorNode = allNodes.find((n) => n.id === phase.anchorNodeId);
    return {
      label: phase.label,
      anchorTitle: anchorNode?.title ?? phase.anchorNodeId!,
      summaryOverride: phase.summaryOverride,
    };
  });

  const finalContent = extractPlainText(resolvedState.content) || "";
  const timelineText =
    timelinePhases.length > 0
      ? formatTimelineContext(
          {
            name: selected.name,
            type: selected.type,
            summary: resolvedState.summary,
          },
          timelinePhases,
          resolvedState,
          lang,
        )
      : "";
  const fullContent =
    timelineText.length > 0
      ? `${finalContent}\n\n${timelineText}`
      : finalContent;

  const lastPhase = resolvedState.activePhaseId
    ? phaseById.get(resolvedState.activePhaseId)
    : undefined;

  // Phase Cb: 子孫 summary も seed と同じ基準（focus は applyAllPhases）で
  // phase 解決してから注入する。生注入だと子孫の旧状態を漏らす。
  const focusDescIds = collectBudgetedDescendantIds([selected.id], allEntries);
  const { resolved: resolvedFocusDescendants } = await resolveEntriesForContext(
    allEntries.filter((e) => focusDescIds.has(e.id)),
    null,
    { applyAllPhases: true },
  );
  const childrenCtx = buildChildrenCtxForEntry(
    selected,
    allEntries,
    L4_TOTAL_BUDGET,
    new Set([selected.id]),
    resolvedFocusDescendants,
  );
  const aliases = parseAliases(selected.aliases);
  const tags = parseTags(selected.tagsCache);

  const selectedPinned: import("./contextBuilder").PinnedCodexContext = {
    id: selected.id,
    type: selected.type,
    name: selected.name,
    summary: resolvedState.summary ?? "",
    fullContent: fullContent || undefined,
    withChildren: false,
    ...(aliases ? { aliases } : {}),
    ...(tags ? { tags } : {}),
    ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
    ...(lastPhase ? { phaseLabel: lastPhase.label } : {}),
  };

  const detectable = allEntries.filter(
    (e) =>
      e.id !== selected.id &&
      e.contextMode !== "hidden" &&
      e.contextMode !== "suppress",
  );
  const scanText = getEntryScanText(selected);
  const forwardMatched = await findMentionedEntriesAsync(scanText, detectable);
  const selectedTarget = {
    id: selected.id,
    name: selected.name,
    type: selected.type,
    aliases: selected.aliases,
    excludedAliases: selected.excludedAliases,
  };
  const reverseMatched = findReverseMentioningEntries(
    selectedTarget,
    detectable,
  );

  const relatedIdSet = new Set<string>();
  const relatedMentioned: CodexContextEntry[] = [];
  for (const entry of [...forwardMatched, ...reverseMatched]) {
    if (entry.id === selected.id || relatedIdSet.has(entry.id)) continue;
    relatedIdSet.add(entry.id);
    const full = allEntries.find((e) => e.id === entry.id);
    if (full) relatedMentioned.push(full);
  }

  const projectId = getCurrentProjectId();
  const relations = await listCodexRelations(projectId).catch(() => []);
  const excludeIds = new Set([selected.id, ...relatedIdSet]);
  const relationExpanded = expandCodexRelationsBFS(
    [selected.id],
    relations,
    allEntries,
    excludeIds,
    { maxDepth: 1 },
  ).map(({ contentFallback: _cf, ...rest }) => rest);

  const enrichedPinned = (
    await enrichWithCustomDetails([selectedPinned], allEntries)
  )[0]!;

  return {
    selectedPinned: enrichedPinned,
    relatedMentioned,
    relationExpanded,
  };
}

/** folder / project スコープ共通の Tier 1/2 synopsis・本文集約。 */
async function buildAggregatedScene(opts: {
  anchorId: string;
  anchorTitle: string;
  descendants: TreeNodeData[];
  includeBodies: boolean;
  activeSceneId: string | null;
  prefacePolicy: AggregatedPrefacePolicy;
  allEntries: CodexContextEntry[];
  /** Resolved mention-only trigger candidates (always is not mention-driven). */
  detectableEntries?: CodexContextEntry[];
  /** project スコープのフォルダ階層グループ化に必須 */
  allNodes?: TreeNodeData[];
  /** Immutable turn setting; do not re-read SettingsStore after source IO. */
  injectBeats: boolean;
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
  aggregatedDetected: CodexContextEntry[];
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
    detectableEntries,
    allNodes,
    agentMode,
    injectBeats,
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

  async function detectFromJoined(
    joined: string,
  ): Promise<CodexContextEntry[]> {
    try {
      const detectable = (detectableEntries ?? allEntries).filter(
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
// Normal streaming Stop finalizes/persists the partial turn synchronously
// before listener cleanup invalidates its callback authority.
let _finalizeStoppedStream: (() => void) | null = null;
// Debounce timer for refreshContextLayers when input-detected entry IDs change.
// Token counting (WASM tiktoken) は同期で長文 scene でも数百 ms。打鍵が落ち着いてから走らせる。
let _inputPinnedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
// ask_user の遅延 Promise を解決するクロージャ（guardedExecuteTool が設定）。
// シリアライズ不可なので state ではなく module-local に持つ。
let _resolveUserQuestion: ((result: ToolResult) => void) | null = null;
// Identity of the send that is still authorized to start a transport. Stop
// clears it so an older turn cannot resume after tokenizer/context awaits.
let _activeSendTurnId: string | null = null;
interface SendTurnControl {
  id: string;
  projectId: string;
  sessionId: string | null;
  surface: "chat" | "agent";
  aborted: boolean;
  userMessageId: string;
  assistantMessageId: string;
  transportStarted: boolean;
  transport: "http" | "cli-exec" | "codex-app-server";
}
let _activeSendControl: SendTurnControl | null = null;
// Async session reads can finish after a scope/project transition. Only the
// newest request for each surface may publish its result.
let _sessionListGeneration = 0;
let _sessionSelectionGeneration = 0;
let _contextRefreshGeneration = 0;
// Session create/select/delete operations cross IPC and can otherwise finish
// after a later Send has captured the old session. Serialize those mutations,
// and make Send wait for every mutation that was requested before it. A
// mutation requested after Send starts re-checks `isStreaming` inside the
// queue and either stops intentionally (select) or becomes a no-op.
let _sessionMutationTail: Promise<void> = Promise.resolve();
let _pendingSessionMutationCount = 0;

interface SessionMutationAuthority {
  workspaceIdentity: ImeWorkspaceIdentity | null;
  projectId: string;
  chatScope: ChatScope;
  scopeKey: ScopeSessionKey;
}

function captureSessionMutationAuthority(
  state: Pick<
    ChatState,
    "activeProjectId" | "activeSceneId" | "chatScope" | "scopeAnchorId"
  >,
): SessionMutationAuthority {
  return {
    workspaceIdentity: getCurrentImeWorkspaceIdentity(),
    projectId: state.activeProjectId ?? getCurrentProjectId(),
    chatScope: state.chatScope,
    scopeKey: resolveScopeSessionKey(
      state.chatScope,
      state.activeSceneId,
      state.scopeAnchorId,
    ),
  };
}

function sameScopeSessionKey(
  left: ScopeSessionKey,
  right: ScopeSessionKey,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.codexAnchorId === right.codexAnchorId &&
    left.snippetAnchorId === right.snippetAnchorId
  );
}

function isCapturedWorkspaceCurrent(
  workspaceIdentity: ImeWorkspaceIdentity | null,
): boolean {
  if (workspaceIdentity) {
    return isCurrentImeWorkspaceIdentity(workspaceIdentity);
  }
  return getCurrentImeWorkspaceIdentity() === null;
}

function isSessionMutationAuthorityCurrent(
  authority: SessionMutationAuthority,
  state: Pick<
    ChatState,
    "activeProjectId" | "activeSceneId" | "chatScope" | "scopeAnchorId"
  >,
): boolean {
  if (!isCapturedWorkspaceCurrent(authority.workspaceIdentity)) return false;
  if (
    (state.activeProjectId ?? getCurrentProjectId()) !== authority.projectId
  ) {
    return false;
  }
  if (state.chatScope !== authority.chatScope) return false;
  return sameScopeSessionKey(
    resolveScopeSessionKey(
      state.chatScope,
      state.activeSceneId,
      state.scopeAnchorId,
    ),
    authority.scopeKey,
  );
}

function isSessionTargetForAuthority(
  session: Pick<
    ChatSession,
    "projectId" | "nodeId" | "codexAnchorId" | "snippetAnchorId"
  >,
  authority: SessionMutationAuthority,
): boolean {
  if (session.projectId !== authority.projectId) return false;
  switch (authority.chatScope) {
    case "scene":
    case "folder":
      return (
        typeof authority.scopeKey.nodeId === "string" &&
        session.nodeId === authority.scopeKey.nodeId &&
        (session.codexAnchorId ?? null) === null &&
        (session.snippetAnchorId ?? null) === null
      );
    case "project":
      return (
        (session.nodeId ?? null) === null &&
        (session.codexAnchorId ?? null) === null &&
        (session.snippetAnchorId ?? null) === null
      );
    case "codex":
      return (
        typeof authority.scopeKey.codexAnchorId === "string" &&
        (session.nodeId ?? null) === null &&
        session.codexAnchorId === authority.scopeKey.codexAnchorId &&
        (session.snippetAnchorId ?? null) === null
      );
    case "snippet":
      return (
        typeof authority.scopeKey.snippetAnchorId === "string" &&
        (session.nodeId ?? null) === null &&
        (session.codexAnchorId ?? null) === null &&
        session.snippetAnchorId === authority.scopeKey.snippetAnchorId
      );
  }
}

function isSameCapturedSession(
  current: ChatSession,
  captured: ChatSession,
): boolean {
  return (
    current.id === captured.id &&
    current.projectId === captured.projectId &&
    (current.nodeId ?? null) === (captured.nodeId ?? null) &&
    (current.codexAnchorId ?? null) === (captured.codexAnchorId ?? null) &&
    (current.snippetAnchorId ?? null) === (captured.snippetAnchorId ?? null)
  );
}

function enqueueSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
  _pendingSessionMutationCount += 1;
  const pending = _sessionMutationTail.then(operation, operation);
  _sessionMutationTail = pending.then(
    () => {
      _pendingSessionMutationCount -= 1;
    },
    () => {
      _pendingSessionMutationCount -= 1;
    },
  );
  return pending;
}

// Stop must target the transport selected for the in-flight turn, not mutable
// settings that may have changed after the request started.
let _activeTurnRoute: ResolvedChatTurnRoute | null = null;
// プロンプトプレビューの seed / 表示用に、ChatInput の入力中テキストを on-demand
// で取得する DI。打鍵毎にストアへ書かず、プレビューを開いた瞬間だけ読む。
// ChatInput が mount 時に登録し unmount で null 解除する。
let _inputDraftProvider:
  | (() => {
      markdown: string;
      mentionedSceneIds: string[];
      mentionedCodexIds: string[];
    })
  | null = null;

// ---------------------------------------------------------------------------
// Shared scene context builder — used by both sendMessage and buildPromptForCopy
// ---------------------------------------------------------------------------

interface SceneContextPayload {
  prompt: string;
  totalTokens: number;
  layers: LayerBreakdown[];
  contextPlan: ChatContextPlan;
  detectedEntries: CodexContextEntry[];
  alwaysEntries: CodexContextEntry[];
  /** L4 に full body + custom details + aliases が完全注入されたエントリの ID。
   * Agent モードで `get_codex_entry` 短絡判定に使う。Spotlight 経路を通った
   * エントリ（pinnedCodexEntries）が該当する。 */
  fullyInjectedIds: string[];
  stableCodexIds: string[];
  cacheSegments?: string[];
  volatileTail?: string;
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
  allEntries: Array<Pick<CodexContextEntry, "id" | "name">>,
  selection?: {
    enabled: boolean;
    boardId: string | null;
    activeBoardId: string | null;
    projectId: string;
    treeNodes?: readonly TreeNodeData[];
  },
): Promise<string | undefined> {
  const chatState = selection ? null : useChatStore.getState();
  const includeMapBoard = selection?.enabled ?? chatState!.includeMapBoard;
  if (!includeMapBoard) return undefined;
  const resolvedBoardId = selection
    ? (selection.boardId ?? selection.activeBoardId)
    : (chatState!.mapBoardId ?? useMapStore.getState().activeBoardId);
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
    if (!board || (selection && board.projectId !== selection.projectId)) {
      return undefined;
    }
    const treeNodesById = new Map(
      (selection?.treeNodes ?? useTreeStore.getState().nodes).map(
        (node) => [node.id, node] as const,
      ),
    );
    const codexById = new Map(allEntries.map((e) => [e.id, e] as const));
    const aiBranchById = new Map(aiBranches.map((a) => [a.id, a] as const));
    // snippet endpoint は稀。同期取得できないので初回のみ「(snippet)」表示で
    // injection を成立させ、副作用で次回送信時に warm 化する。
    const snippetCache = new Map<string, string>();
    const fillSnippetTitle = (id: string): string | null => {
      const cached = snippetCache.get(id);
      if (cached !== undefined) return cached;
      getSnippet(selection?.projectId ?? getCurrentProjectId(), id)
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

/**
 * preview / copy 共通の scene スコープ "outgoing プロンプト" ビルダー。
 * 「これから送るメッセージ (inputText)」を semantic recall の seed と会話末尾の
 * outgoing user message の両方に反映し、send (sendMessage) と揃える。
 * ただし seed は send より寛容で、inputText が空のときは直近 user 発話 →
 * 本文末尾へフォールバックする(プレビューを入力前に開いても related_scenes が
 * 出るように)。eco (includeBodies=false) の本文ブランクもここで一元化する。
 */
async function buildOutgoingScenePrompt(
  get: () => ChatState,
  effectiveSceneId: string,
  opts: {
    purpose: Extract<ContextPlanningPurpose, "preview" | "copy">;
    inputText: string;
    mentionedSceneIds?: string[];
    mentionedCodexIds?: string[];
  },
): Promise<{
  prompt: string;
  layers: LayerBreakdown[];
  totalTokens: number;
} | null> {
  const { activeProjectId, activeSessionId, agentMode, ragEnabled, messages } =
    get();

  // send (sendMessage) は agentMode トグル OFF でも web 検索 RAG が有効な対応
  // プロバイダ時は agent パスに入り agentMode:true で L0 に agentInstruction を足す。
  // 逆に cli は RAG 非対応かつ agent パス対象外。preview/copy を同じ判定に揃える。
  const aiState = useAiSettingsStore.getState();
  const xprov = getCrossProviderChatOverride();
  const aiProvider = xprov?.provider ?? aiState.settings?.provider;
  // openrouter/fusion (マルチモデル合議) はツール呼び出しと両立できない。OpenRouter は
  // tools[] 同梱時にカスタムパネル(analysis_models)を無視して既定パネルに落とすため、
  // fusion 選択時は常にプレーン経路(非エージェント・Web検索なし)に通し、fusion plugin が
  // tools 無しで効くようにする(現在の実モデル = 一時オーバーライド優先で判定)。
  const isFusionModel =
    (aiState.chatModelOverride ?? aiState.settings?.model) ===
    "openrouter/fusion";
  const ragActive =
    ragEnabled && isRagCapableProvider(aiProvider) && !isFusionModel;
  const effectiveAgentMode =
    (agentMode || ragActive) && aiProvider !== "cli" && !isFusionModel;
  const projectId = activeProjectId ?? getCurrentProjectId();
  const activeSession = activeSessionId
    ? get().sessions.find((session) => session.id === activeSessionId)
    : undefined;
  if (activeSession && activeSession.projectId !== projectId) {
    throw new Error("chat session project mismatch");
  }
  const authority = captureSceneTurnAuthority({
    projectId,
    sceneId: effectiveSceneId,
    agentMode: effectiveAgentMode,
  });
  await ensureTokenizer();
  if (
    activeSessionId &&
    !(await chatApi.getSessionForProject(activeSessionId, projectId))
  ) {
    throw new Error("chat session project mismatch");
  }

  const [sceneCtx, projectCtx] = await Promise.all([
    fetchSceneContext(effectiveSceneId, projectId),
    fetchRequiredProjectContext(projectId),
  ]);
  if (!sceneCtx) return null;

  const input = opts.inputText.trim();

  // RAG seed: 今送る入力 → 無ければ直近 user 発話 → 無ければ本文末尾。
  // 本文末尾は eco ブランク前の本文から取る(seed はクエリであって注入ではない)。
  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === "user" && !m.isSummarized)?.content;
  const seed =
    input ||
    lastUserMessage?.trim() ||
    sceneCtx.content.slice(-SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS);

  // 会話履歴 + これから送るメッセージ(send の messagesForCtx と同形)。
  const conversationMessages: ChatMessage[] = [
    ...messages.filter((m) => !m.isSummarized),
    ...(input
      ? [
          {
            id: "outgoing",
            sessionId: activeSessionId ?? "",
            role: "user",
            content: opts.inputText,
            createdAt: new Date().toISOString(),
          } as ChatMessage,
        ]
      : []),
  ];

  // sessionStableCodexIds / prefetchedEntries は send 専用(cacheSegments 分割と
  // fetch 重複排除のみで、返す prompt 文字列には影響しない)ため preview/copy では省く。
  const { prompt, layers, totalTokens } = await buildSceneContextPrompt({
    purpose: opts.purpose,
    authority,
    sceneCtx,
    projectCtx,
    activeSessionId,
    conversationMessages,
    mentionedSceneIds: opts.mentionedSceneIds,
    mentionedCodexIds: opts.mentionedCodexIds,
    semanticRecallSeedMessage: seed,
  });
  return { prompt, layers, totalTokens };
}

/** 糸ごとに表示する他シーンの最大数（構造行は安価だが念のため上限）。 */
const PLOT_THREAD_MAX_MARKERS = 24;

/**
 * 作中年表 (Chronicle) スナップショットを AI 文脈用に組む（push）。
 * project-scoped bulk API (XPROJ 安全) で取得 → アンカー解決 → derive → render。
 * トグル OFF / events 0 件 / 出力空 は undefined（注入スキップ）。
 */
async function buildChronicleSnapshotTextForScene(
  projectId: string,
  sceneId: string,
  treeNodes: TreeNodeData[],
  lang: string,
  codexNames: Map<string, string>,
  sceneCodexIds: string[],
  mentionedCodexIds: string[],
  enabledOverride?: boolean,
): Promise<string | undefined> {
  const enabled =
    enabledOverride ??
    useSettingsStore.getState().getBoolean("aiPrompt.chronicle.enabled", true);
  if (!enabled) return undefined;
  const events = await listEvents(projectId);

  // シーン自身の暦日付（scene-own アンカー源）を tree store から構築。
  const sceneChronicle = new Map<string, SceneChronicle>();
  for (const n of treeNodes) {
    if (n.nodeType !== "scene") continue;
    sceneChronicle.set(n.id, {
      startTime: n.chronicleStartTime ?? null,
      startMinute: n.chronicleStartMinute ?? null,
      startGranularity: n.chronicleStartGranularity ?? "none",
      precision: (n.chroniclePrecision ?? "exact") as EventPrecision,
    });
  }
  // fast path: events 0 件でも、現在シーンが暦日付を持つなら scene-own アンカーで
  // 作中時刻を注入する。両方無いときのみスキップ。
  const cur = sceneChronicle.get(sceneId);
  const currentHasDate =
    !!cur && cur.startGranularity !== "none" && cur.startTime != null;
  if (events.length === 0 && !currentHasDate) return undefined;

  const [participants, sceneEvents, calendarRow, relations] = await Promise.all(
    [
      listEventParticipantsForProject(projectId),
      listSceneEventsForProject(projectId),
      getProjectCalendar(projectId),
      listEventRelations(projectId),
    ],
  );

  // 暦復元は正本 calendarFromRow に委譲（eras/timezone/reform/lunarTzMinutes を
  // 落とさない。旧インラインパースは季節/月/曜日/閏のみで元号等を捨てていた）。
  const calendar = calendarRow ? calendarFromRow(calendarRow) : null;

  const readingOrder = computeGlobalSceneOrder(treeNodes);
  return assembleChronicleSnapshotText({
    sceneId,
    events,
    participants,
    relations,
    sceneEvents,
    calendar,
    readingOrder,
    codexNames,
    sceneCodexIds,
    mentionedCodexIds,
    sceneChronicle,
    lang,
  });
}

/**
 * Phase 3a: 現在シーンが属するプロットスレッドの「構成」を AI 文脈用に組む。
 * 本文は載せず、各糸での位置づけ＋同じ糸の他シーン（タイトル＋段階）だけ。
 * 全て in-memory store から導出（DB I/O なし）。意味検索と食い合わないので
 * semanticRecall の exclude は不要。所属が無ければ undefined。
 */
function buildPlotThreadScenesInput(
  sceneId: string,
): BuildSystemPromptInput["plotThreadScenes"] {
  const { threads, links } = usePlotThreadStore.getState();
  const memberships = computeSceneThreadContext(links, sceneId);
  if (memberships.length === 0) return undefined;

  const nodes = useTreeStore.getState().nodes;
  const titleById = new Map(nodes.map((n) => [n.id, n.title] as const));
  const threadById = new Map(threads.map((t) => [t.id, t] as const));
  const phaseLabel = (p: PlotPhaseType) =>
    i18next.t(`plotThread.phaseType.${p}`);
  const phaseRank = (p: PlotPhaseType) =>
    (PLOT_PHASE_TYPES as readonly string[]).indexOf(p);
  const unnamed = i18next.t("plotThread.unnamed", "（無名）");

  // スレッド順は sortOrder（Timeline / Scene トラックと一致）。
  const ordered = [...memberships].sort((a, b) =>
    cmpKeys(
      threadById.get(a.threadId)?.sortOrder ?? "",
      threadById.get(b.threadId)?.sortOrder ?? "",
    ),
  );

  return ordered.map((m) => {
    const thread = threadById.get(m.threadId);
    // 他シーンは段階順（introduce→resolve）に並べて縦糸の弧を見せる。
    const markers = [...m.others]
      .sort((a, b) => phaseRank(a.phaseType) - phaseRank(b.phaseType))
      .slice(0, PLOT_THREAD_MAX_MARKERS)
      .map((o) => ({
        title: titleById.get(o.nodeId) ?? unnamed,
        phaseLabel: phaseLabel(o.phaseType),
      }));
    return {
      threadName: thread?.name?.trim() || unnamed,
      currentPhases: m.currentPhases.map(phaseLabel),
      markers,
    };
  });
}

interface CapturedSceneTurnAuthority {
  projectId: string;
  sceneId: string;
  mode: "chat" | "agent";
  route: ResolvedChatTurnRoute | null;
  budget: SceneTurnContextRequest["budget"];
  includeBodies: boolean;
  map: SceneTurnContextRequest["map"];
  activeTab: SceneTurnContextRequest["activeTab"];
  settings: SceneTurnContextRequest["settings"];
  inputPinnedEntryIds: readonly string[];
  excludedAutoEntryIds: readonly string[];
  sessionStableCodexIds: readonly string[];
  sessionStableContextInitialized: boolean;
  sourceDeps: SceneContextSourceDeps;
}

/** Capture every mutable store input before the first async source read. */
function captureSceneTurnAuthority(input: {
  projectId: string;
  sceneId: string;
  agentMode: boolean;
  turnRoute?: ResolvedChatTurnRoute;
  inputOverheadTokens?: number;
}): CapturedSceneTurnAuthority {
  const aiState = useAiSettingsStore.getState();
  const aiSettings = aiState.settings;
  const xprov = getCrossProviderChatOverride();
  const chatModel = aiState.chatModelOverride ?? aiSettings?.model ?? "";
  const apiVariant = xprov ? xprov.variant : getChatApiVariant(chatModel);
  const fallbackCapabilities = resolveModelCapabilities(
    chatModel,
    aiSettings,
    apiVariant,
  );
  const chatState = useChatStore.getState();
  const mapState = useMapStore.getState();
  const settingsState = useSettingsStore.getState();
  const tabState = useTabStore.getState();
  const focusedTabs =
    tabState.activeGroupIndex === 1 ? tabState.secondaryTabs : tabState.tabs;
  const focusedTabId =
    tabState.activeGroupIndex === 1
      ? tabState.secondaryActiveTabId
      : tabState.activeTabId;
  const activeTab = focusedTabs.find((tab) => tab.nodeId === focusedTabId);

  return {
    projectId: input.projectId,
    sceneId: input.sceneId,
    mode: input.agentMode ? "agent" : "chat",
    route: input.turnRoute ?? null,
    budget: {
      contextWindow:
        input.turnRoute?.contextWindow ?? fallbackCapabilities.contextWindow,
      maxOutputTokens:
        input.turnRoute?.capabilities.maxOutputTokens ??
        fallbackCapabilities.maxOutputTokens,
      responseReservationTokens:
        input.turnRoute?.outputBudget.responseReservationTokens,
      inputOverheadTokens: input.inputOverheadTokens,
      deliveryMode:
        input.turnRoute && selectsCacheSystemDelivery(input.turnRoute)
          ? "cache"
          : "plain",
    },
    includeBodies: chatState.includeBodies,
    map: {
      enabled: chatState.includeMapBoard,
      boardId: chatState.mapBoardId,
      activeBoardId: mapState.activeBoardId,
    },
    activeTab:
      activeTab?.contentType === "codex" || activeTab?.contentType === "snippet"
        ? { nodeId: activeTab.nodeId, contentType: activeTab.contentType }
        : null,
    settings: {
      injectBeats: settingsState.getBoolean("beat.injectIntoContext", true),
      chronicleEnabled: settingsState.getBoolean(
        "aiPrompt.chronicle.enabled",
        true,
      ),
      semanticRecallEnabled: settingsState.getBoolean(
        "ai.semanticRecall",
        true,
      ),
      episodicRecallEnabled: settingsState.getBoolean("ai.chatRecall", true),
      hybridRecallEnabled: settingsState.getBoolean("ai.hybridRecall", true),
      customChatInstruction: settingsState.get("aiPrompt.custom.chat", ""),
    },
    inputPinnedEntryIds: [...chatState.inputPinnedEntryIds],
    excludedAutoEntryIds: [...chatState.excludedAutoEntryIds],
    sessionStableCodexIds: [...chatState.sessionStableCodexIds],
    sessionStableContextInitialized: chatState.sessionStableContextInitialized,
    sourceDeps: createProductionSceneContextSourceDeps(
      input.projectId,
      input.sceneId,
    ),
  };
}

/**
 * Production composition root for the scene source. Turn-owned mutable inputs
 * enter through the request snapshot; application IO stays behind explicit
 * adapters instead of leaking into the source implementation.
 */
function createProductionSceneContextSourceDeps(
  capturedProjectId: string,
  capturedSceneId: string,
): SceneContextSourceDeps {
  const treeNodes = useTreeStore
    .getState()
    .nodes.filter((node) => node.projectId === capturedProjectId)
    .map((node) => ({ ...node }));
  const phaseState = usePhaseStore.getState();
  const temporalResolution = {
    sceneTimeIndex: {
      ...phaseState.sceneTimeIndex,
      readingOrder: new Map(phaseState.sceneTimeIndex.readingOrder),
      explicitStoryOrder: new Map(phaseState.sceneTimeIndex.explicitStoryOrder),
      inheritedStoryOrder: new Map(
        phaseState.sceneTimeIndex.inheritedStoryOrder,
      ),
    },
    resolutionMode: phaseState.resolutionMode,
  };
  // Plot Thread is entirely store-backed, so materialize it synchronously at
  // the composition boundary instead of re-reading stores after source IO.
  const plotThreadScenes = buildPlotThreadScenesInput(capturedSceneId);
  const unplacedBeats = useUnplacedBeatsStore
    .getState()
    .getBeats(capturedSceneId)
    .map((beat) => ({
      ...beat,
      content: beat.content.map((node) => ({ ...node })),
    }));

  return createSceneContextSourceDeps({
    listCodexEntries: listCodexEntriesForContext,
    listCodexContextMetadata,
    listCodexEntriesByIds: listCodexEntriesForContextByIds,
    listTreeNodes: (requestedProjectId) =>
      requestedProjectId === capturedProjectId ? treeNodes : [],
    getTemporalResolution: (requestedProjectId) => {
      if (requestedProjectId !== capturedProjectId) {
        throw new Error("scene context temporal project mismatch");
      }
      return temporalResolution;
    },
    listPhases: listPhasesByEntryIds,
    listPhaseDetailOverrides: listDetailOverridesByPhaseIds,
    listRawDetailValues: listRawDetailValuesByEntryIds,
    listContextDetails: listContextDetailsByEntryIds,
    findMentionedEntries: findMentionedEntriesAsync,
    listPinnedCodex: chatApi.listPinnedCodexEntries,
    listPinnedSnippets: (sessionId) => listPinnedSnippetEntries(sessionId),
    listPinnedStickies: (sessionId) => listPinnedStickyEntries(sessionId),
    getSnippet,
    getUnplacedBeats: (requestedSceneId) =>
      requestedSceneId === capturedSceneId ? unplacedBeats : [],
    listSummaries: chatApi.listSummaries,
    listNodeLabels,
    getSceneForeshadow: getSceneForeshadowContext,
    listOpenForeshadows: listOpenForeshadowsForContext,
    fetchSemanticRecall,
    fetchChatRecall,
    loadMentionedScenes: (requestedProjectId, ids, currentSceneId) =>
      requestedProjectId === capturedProjectId
        ? loadMentionedScenes([...ids], currentSceneId, treeNodes)
        : Promise.resolve([]),
    listCodexRelations,
    loadMapBoardMarkdown: (sourceRequest, entries) =>
      loadMapBoardMarkdown(entries, {
        enabled: sourceRequest.map.enabled,
        boardId: sourceRequest.map.boardId,
        activeBoardId: sourceRequest.map.activeBoardId,
        projectId: sourceRequest.projectId,
        treeNodes,
      }),
    buildChronicleSnapshot: ({
      request: sourceRequest,
      language,
      codexNames,
      sceneCodexIds,
      mentionedCodexIds,
    }) =>
      buildChronicleSnapshotTextForScene(
        sourceRequest.projectId,
        sourceRequest.sceneId,
        treeNodes,
        language,
        codexNames,
        sceneCodexIds,
        mentionedCodexIds,
        sourceRequest.settings.chronicleEnabled,
      ),
    buildPlotThreadScenes: (requestedProjectId, requestedSceneId) =>
      requestedProjectId === capturedProjectId &&
      requestedSceneId === capturedSceneId
        ? plotThreadScenes
        : undefined,
    markStart,
    markEnd,
  });
}

interface BuildSceneContextPromptOptions {
  purpose: ContextPlanningPurpose;
  authority: CapturedSceneTurnAuthority;
  sceneCtx: SceneContext;
  projectCtx: ProjectContext | null;
  activeSessionId: string | null;
  conversationMessages: ChatMessage[];
  commandInstruction?: string;
  prefetchedEntries?: CodexContextEntry[];
  /** @scene mention で per-message pin される scene ID 群。本関数内で
   * tree から本文を読み込み、buildSystemPrompt の mentionedScenes として
   * 注入される (eco モードでも必ず注入)。 */
  mentionedSceneIds?: string[];
  /** @scene と同様に @codex(人物) mention で per-message に指定された codex ID 群。
   * 作中年表スナップショットの人物プールへ最優先 seed として渡す（言及した人物の
   * 状態/年表を必ず載せる）。本文 L4 注入とは独立。 */
  mentionedCodexIds?: string[];
  /** semantic recall (Layer4 RAG) のクエリ seed に使う「これから送る本文」。
   * 送信 (sendMessage) は content、プレビュー / コピーは buildOutgoingScenePrompt
   * 経由で入力中テキスト(無ければ直近 user 発話 / 本文末尾)を渡す。未指定なら
   * semantic 検索は走らない — refreshContextLayers のライブ経路がこれに当たる。 */
  semanticRecallSeedMessage?: string;
  /** ユーザーが × で auto 注入から除外したエントリ ID。always 再収集と
   * mentioned（自動検出）の両方から取り除く — UI の × は detected/always を
   * 区別せず付くため、片方だけ除外すると detected の × が次の refresh で
   * 即復活する。pinned 経路には影響しない（pin は除外を解除する）。 */
  /** 実送信経路のみ true。chat episodic recall の「Codex に昇格」頻度を数えるのは
   * 実際に送ったターンだけ — プレビュー/コピー/ライブ更新では数えない。 */
  trackRecallPromote?: boolean;
  /** Guard planner-adjacent side effects against a stopped/replaced turn. */
  isAuthorized?: () => boolean;
}

async function buildSceneContextPrompt(
  opts: BuildSceneContextPromptOptions,
): Promise<SceneContextPayload> {
  const { authority } = opts;
  if (opts.sceneCtx.id !== authority.sceneId) {
    throw new Error("scene context authority mismatch");
  }
  const request = createSceneTurnContextRequest({
    requestId: crypto.randomUUID(),
    purpose: opts.purpose,
    projectId: authority.projectId,
    sessionId: opts.activeSessionId,
    sceneId: authority.sceneId,
    mode: authority.mode,
    route: authority.route,
    budget: authority.budget,
    messages: opts.conversationMessages,
    outgoingUserMessage: opts.semanticRecallSeedMessage ?? "",
    commandInstruction: opts.commandInstruction,
    mentionedSceneIds: opts.mentionedSceneIds ?? [],
    mentionedCodexIds: opts.mentionedCodexIds ?? [],
    inputPinnedEntryIds: authority.inputPinnedEntryIds,
    excludedAutoEntryIds: authority.excludedAutoEntryIds,
    sessionStableCodexIds: authority.sessionStableCodexIds,
    sessionStableContextInitialized: authority.sessionStableContextInitialized,
    includeBodies: authority.includeBodies,
    map: authority.map,
    activeTab: authority.activeTab,
    settings: authority.settings,
    trackRecallPromote: opts.trackRecallPromote ?? false,
    sourceSnapshot: {
      scene: opts.sceneCtx,
      project: opts.projectCtx,
      prefetchedCodexEntries: opts.prefetchedEntries,
    },
  });
  const sceneSourceDeps = authority.sourceDeps;

  markStart("buildSceneCtx.buildSystemPrompt");
  const result = await planChatContext(
    request,
    createDefaultContextPlannerDeps({
      collectRequiredSceneContext: (sourceRequest) =>
        collectSceneContext(sourceRequest, sceneSourceDeps),
    }),
  );
  markEnd("buildSceneCtx.buildSystemPrompt");

  if (
    request.trackRecallPromote &&
    (opts.isAuthorized?.() ?? true) &&
    result.recalledMessages.length > 0
  ) {
    const suggestion = trackRecallForPromote(
      recallPromoteTracker,
      result.recalledMessages,
    );
    if (suggestion) {
      useChatStore.setState({ chatRecallPromoteSuggestion: suggestion });
    }
  }

  return result;
}

/**
 * lastSystemPrompt の構築時スコープ構成を表すキー。送信側はこれを現在の
 * 構成と照合し、不一致なら refreshContextLayers を await してから流用する。
 * ChatPanel の refresh effect は非同期のため、スコープ切替直後の即送信では
 * 前の構成で組まれた lastSystemPrompt が残っていることがある。
 */
export function contextPromptKey(
  s: Pick<
    ChatState,
    | "chatScope"
    | "scopeAnchorId"
    | "activeSceneId"
    | "activeSessionId"
    | "threadFocusOverride"
  >,
): string {
  return [
    s.chatScope,
    s.scopeAnchorId ?? "",
    s.activeSceneId,
    s.activeSessionId ?? "",
    // Phase 3b: スレッド focus が変わったら stale 判定で再構築させる。
    s.threadFocusOverride?.threadId ?? "",
    // Phase 1 (chronicle): 年表編集後に preview/送信の stale prompt 流用を防ぐ。
    String(useChronicleStore.getState().revisionCounter),
  ].join("\u0000");
}

/**
 * Snapshot every mutable non-scene source selector before a send can yield.
 * Conversation messages may be replaced by the deterministic summarization
 * result later, but source membership/configuration never re-reads Zustand.
 */
function captureNonSceneContextAuthority(input: {
  state: ChatState;
  projectId: string;
  mode: "chat" | "agent";
  agentToolsAvailable: boolean;
  route: ResolvedChatTurnRoute | null;
  inputOverheadTokens?: number;
}): CapturedNonSceneContextAuthority {
  const { state, projectId, route } = input;
  const aiSettings = useAiSettingsStore.getState().settings;
  const model = route?.model ?? aiSettings?.model ?? "";
  const fallbackCapabilities = resolveModelCapabilities(
    model,
    aiSettings,
    getChatApiVariant(model),
  );
  const contextWindow =
    route?.contextWindow ?? fallbackCapabilities.contextWindow;
  const maxOutputTokens =
    route?.capabilities.maxOutputTokens ?? fallbackCapabilities.maxOutputTokens;
  const settingsState = useSettingsStore.getState();
  const mapState = useMapStore.getState();
  const treeNodes = useTreeStore
    .getState()
    .nodes.filter((node) => !node.projectId || node.projectId === projectId)
    .map((node) => (node.projectId ? { ...node } : { ...node, projectId }));
  const phaseState = usePhaseStore.getState();
  const plotThreadState = usePlotThreadStore.getState();
  const tabState = useTabStore.getState();
  const focusedTabs =
    tabState.activeGroupIndex === 1 ? tabState.secondaryTabs : tabState.tabs;
  const focusedTabId =
    tabState.activeGroupIndex === 1
      ? tabState.secondaryActiveTabId
      : tabState.activeTabId;
  const activeTab = focusedTabs.find((tab) => tab.nodeId === focusedTabId);

  let scope: Exclude<ContextScopeTarget, { kind: "scene" }>;
  if (state.threadFocusOverride) {
    scope = {
      kind: "thread",
      threadId: state.threadFocusOverride.threadId,
      title: state.threadFocusOverride.title,
    };
  } else if (state.chatScope === "folder" && state.scopeAnchorId) {
    scope = { kind: "folder", folderId: state.scopeAnchorId };
  } else if (state.chatScope === "project") {
    scope = { kind: "project" };
  } else if (state.chatScope === "codex" && state.scopeAnchorId) {
    scope = { kind: "codex", entryId: state.scopeAnchorId };
  } else if (state.chatScope === "snippet" && state.scopeAnchorId) {
    scope = { kind: "snippet", snippetId: state.scopeAnchorId };
  } else {
    scope = { kind: "global" };
  }

  return {
    requestSeed: {
      projectId,
      scope,
      containerScope: state.chatScope,
      scopeAnchorId: state.scopeAnchorId,
      activeSceneId: state.activeSceneId,
      activeProjectId: state.activeProjectId,
      agentToolsAvailable: input.agentToolsAvailable,
      mode: input.mode,
      route,
      budget: {
        contextWindow,
        maxOutputTokens,
        responseReservationTokens:
          route?.outputBudget.responseReservationTokens,
        inputOverheadTokens: input.inputOverheadTokens,
        deliveryMode:
          route && selectsCacheSystemDelivery(route) ? "cache" : "plain",
      },
      inputPinnedEntryIds: [...state.inputPinnedEntryIds],
      excludedAutoEntryIds: [...state.excludedAutoEntryIds],
      sessionStableCodexIds: [...state.sessionStableCodexIds],
      sessionStableContextInitialized: state.sessionStableContextInitialized,
      includeBodies: state.includeBodies,
      map: {
        enabled: state.includeMapBoard,
        boardId: state.mapBoardId,
        activeBoardId: mapState.activeBoardId,
      },
      activeTab:
        activeTab?.contentType === "codex" ||
        activeTab?.contentType === "snippet"
          ? { nodeId: activeTab.nodeId, contentType: activeTab.contentType }
          : null,
      settings: {
        injectBeats: settingsState.getBoolean("beat.injectIntoContext", true),
        chronicleEnabled: settingsState.getBoolean(
          "aiPrompt.chronicle.enabled",
          true,
        ),
        semanticRecallEnabled: settingsState.getBoolean(
          "ai.semanticRecall",
          true,
        ),
        episodicRecallEnabled: settingsState.getBoolean("ai.chatRecall", true),
        hybridRecallEnabled: settingsState.getBoolean("ai.hybridRecall", true),
        customChatInstruction: settingsState.get("aiPrompt.custom.chat", ""),
      },
      trackRecallPromote: false,
      sourceSnapshot: {
        treeNodes,
        plotThreadIds: plotThreadState.threads.map((thread) => thread.id),
        plotThreadLinks: plotThreadState.links.map(({ threadId, nodeId }) => ({
          threadId,
          nodeId,
        })),
      },
    },
    temporalResolution: {
      sceneTimeIndex: {
        ...phaseState.sceneTimeIndex,
        readingOrder: new Map(phaseState.sceneTimeIndex.readingOrder),
        explicitStoryOrder: new Map(
          phaseState.sceneTimeIndex.explicitStoryOrder,
        ),
        inheritedStoryOrder: new Map(
          phaseState.sceneTimeIndex.inheritedStoryOrder,
        ),
      },
      resolutionMode: phaseState.resolutionMode,
    },
  };
}

/**
 * chat episodic recall の「Codex に昇格しますか？」頻度トラッカー (per-session・
 * in-memory)。store 外の module 状態にして、毎ターンの recall カウントで store の
 * re-render を起こさない (提案が立った瞬間だけ store state を更新する)。
 */
const recallPromoteTracker = createRecallPromoteTracker();

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
  contextWindowSize: null,
  contextModel: null,
  contextLayers: [],
  contextPlan: null,
  lastSystemPrompt: "",
  lastSystemPromptKey: null,
  chatRecallPromoteSuggestion: null,
  pinsVersion: 0,
  projectOutline: undefined,
  chapterOutlines: [],
  detectedEntries: [],
  alwaysEntries: [],
  scopeAnchor: null,
  threadFocusOverride: null,
  excludedAutoEntryIds: [],
  inputPinnedEntryIds: [],
  agentMode: false,
  agentProgress: null,
  subAgentProgress: null,
  agentContinuation: null,
  pendingUserQuestion: null,
  ragEnabled: false,
  chatScope: "scene",
  scopeAnchorId: null,
  includeBodies: true,
  includeMapBoard: false,
  mapBoardId: null,
  pendingLookupText: null,
  summaryCount: 0,
  maxSummaryGeneration: 0,
  cacheInvalidatedReason: null,
  sessionStableCodexIds: [],
  sessionStableContextInitialized: false,
  sessionAgentToolsSnapshot: null,
  _lastCachedModel: null,

  resetForProject: (projectId) => {
    if (get().isStreaming) get().stopGeneration();
    set({
      activeSessionId: null,
      isLoadingSessions: false,
      isLoadingMessages: false,
      messages: [],
      sessions: [],
      isStreaming: false,
      activeProjectId: projectId,
      activeSceneId: "",
      error: null,
      contextTokenCount: 0,
      contextWindowSize: null,
      contextModel: null,
      contextLayers: [],
      contextPlan: null,
      lastSystemPrompt: "",
      lastSystemPromptKey: null,
      chatRecallPromoteSuggestion: null,
      pinsVersion: 0,
      projectOutline: undefined,
      chapterOutlines: [],
      detectedEntries: [],
      alwaysEntries: [],
      scopeAnchor: null,
      threadFocusOverride: null,
      excludedAutoEntryIds: [],
      inputPinnedEntryIds: [],
      agentMode: false,
      agentProgress: null,
      subAgentProgress: null,
      agentContinuation: null,
      pendingUserQuestion: null,
      ragEnabled: false,
      chatScope: "scene",
      scopeAnchorId: null,
      includeBodies: true,
      includeMapBoard: false,
      mapBoardId: null,
      pendingLookupText: null,
      summaryCount: 0,
      maxSummaryGeneration: 0,
      cacheInvalidatedReason: null,
      sessionStableCodexIds: [],
      sessionStableContextInitialized: false,
      sessionAgentToolsSnapshot: null,
      _lastCachedModel: null,
    });
  },

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
    const invocationState = get();
    if (invocationState.isStreaming) return;
    const authority = captureSessionMutationAuthority(invocationState);
    const ref = invocationState.sessions.find(
      (session) => session.id === invocationState.activeSessionId,
    );
    if (ref && !isSessionTargetForAuthority(ref, authority)) return;
    return enqueueSessionMutation(async () => {
      const queuedState = get();
      if (
        queuedState.isStreaming ||
        !isSessionMutationAuthorityCurrent(authority, queuedState) ||
        queuedState.activeSessionId !== (ref?.id ?? null)
      ) {
        return;
      }
      const { projectId, scopeKey } = authority;
      try {
        const session = await createSessionForCurrentRuntime(
          projectId,
          ref ? `Linked: ${ref.title}` : "New session",
          scopeKey.nodeId === null ? undefined : scopeKey.nodeId,
          scopeKey.codexAnchorId,
          scopeKey.snippetAnchorId,
        );
        if (
          get().isStreaming ||
          session.projectId !== projectId ||
          !isSessionTargetForAuthority(session, authority) ||
          !isSessionMutationAuthorityCurrent(authority, get()) ||
          get().activeSessionId !== (ref?.id ?? null)
        ) {
          return;
        }
        set((state) => ({
          sessions: [session, ...state.sessions],
          activeSessionId: session.id,
          messages: [],
          summaryCount: 0,
          maxSummaryGeneration: 0,
          sessionStableCodexIds: [],
          sessionStableContextInitialized: false,
          sessionAgentToolsSnapshot: snapshotAgentTools(),
          cacheInvalidatedReason: null,
          excludedAutoEntryIds: [],
          threadFocusOverride: null,
        }));
        if (ref) {
          if (
            !isSessionMutationAuthorityCurrent(authority, get()) ||
            get().activeSessionId !== session.id
          ) {
            return;
          }
          const linkMsg = await chatApi.addMessage(
            session.id,
            "system",
            i18next.t("chat.linkedSessionReference", {
              title: ref.title,
              sessionId: ref.id,
            }),
          );
          if (
            isSessionMutationAuthorityCurrent(authority, get()) &&
            get().activeSessionId === session.id
          ) {
            set({ messages: [linkMsg] });
          }
        }
      } catch (e) {
        toast.error(i18next.t("chat.createSessionFailed"));
        debugLog.error("ChatStore", "createLinkedSession", errorDetail(e));
      }
    });
  },

  removeEntryFromAuto: (entryId: string) => {
    set((state) => ({
      detectedEntries: state.detectedEntries.filter((e) => e.id !== entryId),
      alwaysEntries: state.alwaysEntries.filter((e) => e.id !== entryId),
    }));
  },

  excludeEntryFromAuto: (entryId: string) => {
    const wasExcluded = get().excludedAutoEntryIds.includes(entryId);
    set((state) => ({
      excludedAutoEntryIds: state.excludedAutoEntryIds.includes(entryId)
        ? state.excludedAutoEntryIds
        : [...state.excludedAutoEntryIds, entryId],
      detectedEntries: state.detectedEntries.filter((e) => e.id !== entryId),
      alwaysEntries: state.alwaysEntries.filter((e) => e.id !== entryId),
    }));
    // 除外を lastSystemPrompt に即時反映する（× の直後に送信しても
    // 旧プロンプト経由で注入されないように）。
    void get().refreshContextLayers();
    return !wasExcluded;
  },

  clearAutoExclusion: (entryId: string) => {
    set((state) =>
      state.excludedAutoEntryIds.includes(entryId)
        ? {
            excludedAutoEntryIds: state.excludedAutoEntryIds.filter(
              (id) => id !== entryId,
            ),
          }
        : state,
    );
  },

  onCodexAnchorDeleted: (entryId: string) => {
    const { chatScope, scopeAnchorId } = get();
    if (chatScope === "codex" && scopeAnchorId === entryId) {
      set({ chatScope: "scene", scopeAnchorId: null, includeBodies: true });
    }
  },

  onSnippetAnchorDeleted: (snippetId: string) => {
    const { chatScope, scopeAnchorId } = get();
    if (chatScope === "snippet" && scopeAnchorId === snippetId) {
      set({ chatScope: "scene", scopeAnchorId: null, includeBodies: true });
    }
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

  // Phase 3b: スレッド focus override。設定/解除で即座にプロンプトを再構築する
  // （chatScope は変えないので ChatPanel の scope-deps effect では拾えないため）。
  setThreadFocusOverride: (v) => {
    set({ threadFocusOverride: v });
    void get().refreshContextLayers();
  },
  clearThreadFocusOverride: () => {
    if (!get().threadFocusOverride) return;
    set({ threadFocusOverride: null });
    void get().refreshContextLayers();
  },

  // --- Session management ---

  loadSessions: async (
    nodeId?: string | null,
    codexAnchorId?: string | null,
    snippetAnchorId?: string | null,
  ) => {
    const generation = ++_sessionListGeneration;
    const projectId = get().activeProjectId ?? getCurrentProjectId();
    set({ isLoadingSessions: true });
    try {
      const sessions = await chatApi.listSessions(
        projectId,
        nodeId,
        codexAnchorId,
        snippetAnchorId,
      );
      if (
        generation !== _sessionListGeneration ||
        (get().activeProjectId ?? getCurrentProjectId()) !== projectId
      ) {
        return;
      }
      if (sessions.some((session) => session.projectId !== projectId)) {
        throw new Error("chat session project mismatch");
      }
      set({ sessions, isLoadingSessions: false });
    } catch (e) {
      if (
        generation !== _sessionListGeneration ||
        (get().activeProjectId ?? getCurrentProjectId()) !== projectId
      ) {
        return;
      }
      set({ isLoadingSessions: false });
      toast.error(i18next.t("chat.loadSessionsFailed"));
      debugLog.error("ChatStore", "loadSessions", errorDetail(e));
    }
  },

  selectSession: async (sessionId: string | null) => {
    const authority = captureSessionMutationAuthority(get());
    const { projectId } = authority;
    return enqueueSessionMutation(async () => {
      const generation = ++_sessionSelectionGeneration;
      if (!isSessionMutationAuthorityCurrent(authority, get())) {
        return;
      }
      if (get().isStreaming) get().stopGeneration();
      if (!isSessionMutationAuthorityCurrent(authority, get())) return;
      // セッションを切り替える前に、回答待ちの ask_user を sentinel 解決して
      // resolver リーク・別セッションでのカード誤表示を防ぐ（null/切替の両分岐共通）。
      get()._cancelPendingUserQuestion();
      // エピソード recall 昇格トラッカーは per-session。切替時にリセットして、前
      // セッションの頻度・dismiss を持ち越さない。
      resetRecallPromote(recallPromoteTracker);
      if (sessionId === null) {
        set({
          activeSessionId: null,
          messages: [],
          isLoadingMessages: false,
          summaryCount: 0,
          maxSummaryGeneration: 0,
          sessionStableCodexIds: [],
          sessionStableContextInitialized: false,
          sessionAgentToolsSnapshot: null,
          excludedAutoEntryIds: [],
          threadFocusOverride: null,
          chatRecallPromoteSuggestion: null,
          // 前セッションの「続行」/サブエージェント進捗を持ち越さない。
          agentContinuation: null,
          subAgentProgress: null,
        });
        return;
      }
      set({
        isLoadingMessages: true,
        activeSessionId: sessionId,
        messages: [],
        chatRecallPromoteSuggestion: null,
        // 前セッションの「続行」/サブエージェント進捗を持ち越さない。
        agentContinuation: null,
        subAgentProgress: null,
      });
      try {
        if (!isSessionMutationAuthorityCurrent(authority, get())) return;
        const session = await chatApi.getSessionForProject(
          sessionId,
          projectId,
        );
        if (
          generation !== _sessionSelectionGeneration ||
          !isSessionMutationAuthorityCurrent(authority, get()) ||
          get().activeSessionId !== sessionId
        ) {
          return;
        }
        if (!session) {
          throw new Error("chat session project mismatch");
        }
        if (!isSessionMutationAuthorityCurrent(authority, get())) return;
        const [messages, summaries] = await Promise.all([
          chatApi.listMessages(sessionId),
          chatApi.listSummaries(sessionId),
        ]);
        if (
          generation !== _sessionSelectionGeneration ||
          !isSessionMutationAuthorityCurrent(authority, get()) ||
          get().activeSessionId !== sessionId
        ) {
          return;
        }
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
          sessionStableContextInitialized: false,
          sessionAgentToolsSnapshot: snapshotAgentTools(),
          cacheInvalidatedReason: null,
          excludedAutoEntryIds: [],
          threadFocusOverride: null,
        });
      } catch (e) {
        if (
          generation !== _sessionSelectionGeneration ||
          !isSessionMutationAuthorityCurrent(authority, get()) ||
          get().activeSessionId !== sessionId
        ) {
          return;
        }
        set({ activeSessionId: null, messages: [], isLoadingMessages: false });
        toast.error(i18next.t("chat.loadMessagesFailed"));
        debugLog.error("ChatStore", "selectSession", errorDetail(e));
      }
    });
  },

  createNewSession: async (
    projectId: string,
    title: string,
    nodeId?: string,
    codexAnchorId?: string,
    snippetAnchorId?: string,
  ) => {
    const invocationState = get();
    if (invocationState.isStreaming) return;
    const authority = captureSessionMutationAuthority(invocationState);
    if (
      !isSessionTargetForAuthority(
        {
          projectId,
          nodeId: nodeId ?? null,
          codexAnchorId: codexAnchorId ?? null,
          snippetAnchorId: snippetAnchorId ?? null,
        },
        authority,
      )
    ) {
      return;
    }
    return enqueueSessionMutation(async () => {
      if (
        get().isStreaming ||
        !isSessionMutationAuthorityCurrent(authority, get())
      ) {
        return;
      }
      try {
        const session = await createSessionForCurrentRuntime(
          projectId,
          title,
          nodeId,
          codexAnchorId,
          snippetAnchorId,
        );
        if (
          get().isStreaming ||
          !isSessionTargetForAuthority(session, authority) ||
          !isSessionMutationAuthorityCurrent(authority, get())
        ) {
          return;
        }
        set((state) => ({
          sessions: [session, ...state.sessions],
          activeSessionId: session.id,
          messages: [],
          summaryCount: 0,
          maxSummaryGeneration: 0,
          sessionStableCodexIds: [],
          sessionStableContextInitialized: false,
          sessionAgentToolsSnapshot: snapshotAgentTools(),
          cacheInvalidatedReason: null,
          excludedAutoEntryIds: [],
          threadFocusOverride: null,
        }));
      } catch (e) {
        toast.error(i18next.t("chat.createSessionFailed"));
        debugLog.error("ChatStore", "createNewSession", errorDetail(e));
      }
    });
  },

  ensureSession: async () => {
    const invocationState = get();
    const authority = captureSessionMutationAuthority(invocationState);
    const capturedSessionId = invocationState.activeSessionId;
    const capturedSession = capturedSessionId
      ? invocationState.sessions.find(
          (session) => session.id === capturedSessionId,
        )
      : undefined;
    if (
      capturedSessionId &&
      (!capturedSession ||
        !isSessionTargetForAuthority(capturedSession, authority))
    ) {
      return null;
    }
    return enqueueSessionMutation(async () => {
      const queuedState = get();
      if (
        queuedState.isStreaming ||
        !isSessionMutationAuthorityCurrent(authority, queuedState) ||
        queuedState.activeSessionId !== capturedSessionId
      ) {
        return null;
      }
      if (capturedSessionId) return capturedSessionId;
      const { projectId, scopeKey } = authority;
      try {
        const session = await createSessionForCurrentRuntime(
          projectId,
          "New session",
          scopeKey.nodeId === null ? undefined : scopeKey.nodeId,
          scopeKey.codexAnchorId,
          scopeKey.snippetAnchorId,
        );
        if (
          get().isStreaming ||
          !isSessionTargetForAuthority(session, authority) ||
          !isSessionMutationAuthorityCurrent(authority, get()) ||
          get().activeSessionId !== capturedSessionId
        ) {
          return null;
        }
        set((state) => ({
          sessions: [session, ...state.sessions],
          activeSessionId: session.id,
        }));
        return session.id;
      } catch (e) {
        debugLog.error("ChatStore", "ensureSession", errorDetail(e));
        return null;
      }
    });
  },

  deleteSession: async (sessionId: string) => {
    const invocationState = get();
    if (invocationState.isStreaming) return;
    const authority = captureSessionMutationAuthority(invocationState);
    const capturedSession = invocationState.sessions.find(
      (session) => session.id === sessionId,
    );
    if (
      !capturedSession ||
      !isSessionTargetForAuthority(capturedSession, authority)
    ) {
      return;
    }
    return enqueueSessionMutation(async () => {
      if (
        get().isStreaming ||
        !isSessionMutationAuthorityCurrent(authority, get())
      ) {
        return;
      }
      try {
        const { projectId, workspaceIdentity } = authority;
        // `deleteSession` is id-only at the Drizzle boundary. Resolve ownership
        // in the captured project first, then re-check the full renderer
        // authority before issuing that unscoped mutation.
        const ownedSession = await chatApi.getSessionForProject(
          sessionId,
          projectId,
        );
        if (
          !ownedSession ||
          !isSameCapturedSession(ownedSession, capturedSession) ||
          !isSessionTargetForAuthority(ownedSession, authority) ||
          !isSessionMutationAuthorityCurrent(authority, get())
        ) {
          return;
        }
        if (workspaceIdentity) {
          // The local DB cascade removes the binding, but archive the external
          // thread first so a later Codex process cannot retain an orphaned turn.
          await codexAppApi
            .archiveCodexSessionThread({
              projectId,
              sessionId,
              expectedWorkspacePath: workspaceIdentity.path,
            })
            .catch((error: unknown) =>
              debugLog.warn(
                "ChatStore",
                "archive Codex session thread",
                errorDetail(error),
              ),
            );
        }
        if (
          get().isStreaming ||
          !isSessionMutationAuthorityCurrent(authority, get())
        ) {
          return;
        }
        await chatApi.deleteSession(sessionId);
        if (!isSessionMutationAuthorityCurrent(authority, get())) return;
        const { activeSessionId } = get();
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== sessionId),
          ...(activeSessionId === sessionId
            ? {
                activeSessionId: null,
                messages: [],
                // 他のセッションライフサイクル操作（select/create）と同じく
                // auto 除外をクリアする。残すと削除直後の refresh や送信時の
                // auto-create セッションに前セッションの除外がリークする。
                excludedAutoEntryIds: [],
                threadFocusOverride: null,
              }
            : {}),
        }));
      } catch (e) {
        toast.error(i18next.t("chat.deleteSessionFailed"));
        debugLog.error("ChatStore", "deleteSession", errorDetail(e));
      }
    });
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

  appendAdoptedAbTurn: async ({
    userDraft,
    basePrompt,
    mentionedSceneIds,
    assistantText,
    model,
  }) => {
    // A/B ダイアログはスコープを変えずに開くため、ensureSession は現在のスコープ
    // (scene/folder/project/codex/snippet) に対応する正しいセッションを返す。
    const sessionId = await get().ensureSession();
    if (!sessionId) {
      toast.error(i18next.t("chat.saveMessageFailed"));
      return false;
    }

    try {
      // user 下書き。@scene メンションは sendMessage と同じく metadata に残す。
      const userMetadata =
        mentionedSceneIds.length > 0
          ? JSON.stringify({ mentioned_scene_ids: mentionedSceneIds })
          : undefined;
      const userMsg = await chatApi.addMessage(sessionId, "user", userDraft, {
        ...(userMetadata ? { metadata: userMetadata } : {}),
      });

      // 制作過程開示: A/B 各構成へ実際に送ったフルプロンプトをスナップショット保存
      // (通常送信の saveMessagePrompt と同じ chat_message_prompts へ)。fire-and-forget。
      // 比較は単発 user メッセージで投げているため layers は空・tokens は不明。
      if (basePrompt) {
        void chatApi
          .saveMessagePrompt(userMsg.id, {
            systemPrompt: basePrompt,
            layers: [],
            totalTokens: null,
            model,
          })
          .catch((e) =>
            debugLog.warn(
              "ChatStore",
              "appendAdoptedAbTurn:saveMessagePrompt",
              errorDetail(e),
            ),
          );
      }

      // 採用応答。ab_adopted で provenance を残す (ライブ生成と区別)。
      // usage は A/B 実行時に recordAiUsage 済みなので二重記録しない。
      const assistantMsg = await chatApi.addMessage(
        sessionId,
        "assistant",
        assistantText,
        {
          ...(model ? { model } : {}),
          metadata: JSON.stringify({ ab_adopted: true }),
        },
      );

      set((state) => ({
        messages: [...state.messages, userMsg, assistantMsg],
      }));
      return true;
    } catch (e) {
      toast.error(i18next.t("chat.saveMessageFailed"));
      debugLog.error("ChatStore", "appendAdoptedAbTurn", errorDetail(e));
      return false;
    }
  },

  // --- Prompt preview for copy ---

  buildPromptForCopy: async (
    userInput: string,
    options?: { mentionedSceneIds?: string[]; mentionedCodexIds?: string[] },
  ): Promise<string> => {
    const {
      activeSceneId,
      chatScope,
      threadFocusOverride,
      messages: prevMessages,
    } = get();
    // Phase 3b: スレッド focus 中は scene 経路を使わない（refreshContextLayers と整合）。
    const effectiveSceneId =
      chatScope === "scene" && activeSceneId && !threadFocusOverride
        ? activeSceneId
        : null;

    const parts: string[] = [];
    let needsMentionCleanup = false;

    try {
      if (effectiveSceneId) {
        const built = await buildOutgoingScenePrompt(get, effectiveSceneId, {
          purpose: "copy",
          inputText: userInput,
          mentionedSceneIds: options?.mentionedSceneIds,
          mentionedCodexIds: options?.mentionedCodexIds,
        });
        if (built) {
          parts.push(`[system]\n${built.prompt}`);
        }
      } else {
        // Every non-scene scope builds a copy-specific immutable TurnRequest.
        // lastSystemPrompt は UI cache であり、copy correctness には流用しない。
        // mentions 込みで refresh すると lastSystemPrompt に @scene pin が焼き込まれ、
        // ユーザーが mention を消して送信した次回送信でも古い pin を吸う。Copy 後に
        // mentions 無しで refresh し直して state を巻き戻す（後段の finally で実行）。
        const hadMentions =
          !!options?.mentionedSceneIds && options.mentionedSceneIds.length > 0;
        const refreshed = await get().refreshContextLayers({
          purpose: "copy",
          conversationMessages: [
            ...prevMessages,
            {
              id: "copy-outgoing",
              sessionId: get().activeSessionId ?? "",
              role: "user",
              content: userInput,
              createdAt: new Date().toISOString(),
            },
          ],
          outgoingUserMessage: userInput,
          mentionedSceneIds: options?.mentionedSceneIds,
          mentionedCodexIds: options?.mentionedCodexIds,
          strict: true,
        });
        needsMentionCleanup = hadMentions;
        const prompt = refreshed?.prompt ?? "";
        if (prompt) {
          parts.push(`[system]\n${prompt}`);
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
      mentionedCodexIds?: string[];
      /** 429 リトライの内部カウンタ（外部呼び出しでは指定しない）。 */
      _rateLimitRetry?: number;
    },
  ) => {
    // Preserve Send's synchronous authority snapshot on the normal fast path.
    // Only yield when a session mutation was already requested; a mutation
    // requested after this check cannot interleave before `isStreaming` is set
    // because the code below has no await before publishing the placeholders.
    if (_pendingSessionMutationCount > 0) {
      await _sessionMutationTail;
    }
    const turnWorkspaceIdentity = getCurrentImeWorkspaceIdentity();
    const {
      isStreaming,
      isLoadingMessages,
      activeSceneId,
      activeProjectId,
      activeSessionId,
      chatScope,
      scopeAnchorId,
      threadFocusOverride,
      messages: initialMessages,
      sessions: initialSessions,
    } = get();
    if (isStreaming || isLoadingMessages) return;
    if (!content.trim()) return;
    // 新規送信が始まったら直前ターンの「続行」ボタンは無効化する
    // （ボタンは常に最新ターンに対してのみ出す）。
    if (get().agentContinuation) set({ agentContinuation: null });
    // Defense: chat がポリシーで OFF なら送信を弾く。Send ボタンは hide/disabled
    // になるが、Enter / Cmd+Enter / regenerate / agent 再入は全てこの sendMessage
    // に集約されるため、ここで塞げば UI を経由しない送信経路も封じられる。
    // 最初の set() より前に判定する。
    if (blockIfPolicyOff("chat")) return;
    if (blockIfUnlicensed()) return;

    const aiSettingsEarly = useAiSettingsStore.getState().settings;
    // チャット用一時モデル(あれば)を含めた実効モデル。これでチャットパネルでの
    // モデル切替も prefix cache 無効化バッジ・予算計算に正しく反映される。
    const chatModelEarly =
      useAiSettingsStore.getState().chatModelOverride ??
      aiSettingsEarly?.model ??
      "";
    // モデルが前回送信から変わっていれば prefix cache が無効化されるため
    // バッジを立て、変わっていなければ消灯する。消灯をここで一元化するのが要点:
    // agent / RAG / グローバルスコープ経路には後段のコンテキスト再構築 (=従来の
    // 唯一のクリア箇所) が無く、ここで揃えないとバッジが「1ターン」を超えて
    // 居座り続ける (同一モデルで送り続けても消えない)。chatModelEarly が空の
    // ときはモデル未選択でキャッシュの概念が無いので立てない。
    if (
      get()._lastCachedModel &&
      chatModelEarly &&
      get()._lastCachedModel !== chatModelEarly
    ) {
      set({ cacheInvalidatedReason: "model" });
    } else {
      set({ cacheInvalidatedReason: null });
    }
    const existingAgentToolsSnapshot = get().sessionAgentToolsSnapshot;
    const turnAgentToolsSnapshot = existingAgentToolsSnapshot
      ? structuredClone(existingAgentToolsSnapshot)
      : snapshotAgentTools();
    if (!existingAgentToolsSnapshot) {
      set({ sessionAgentToolsSnapshot: turnAgentToolsSnapshot });
    }
    set({ _lastCachedModel: chatModelEarly });

    // Phase 3b: スレッド focus 中は scene を主題にしない（非 scene 枝へ）。
    const effectiveSceneId =
      chatScope === "scene" && !threadFocusOverride ? activeSceneId : null;
    // 一回限りの Agent mode override (サジェストチップ / 再試行ボタンから)
    // ユーザーの永続トグルは変更しない。
    const agentModeForThisSend = options?.overrideAgentMode ?? get().agentMode;
    const aiSendState = useAiSettingsStore.getState();
    const xprov = getCrossProviderChatOverride();
    const composerModel = aiSendState.chatModelOverride;
    const resolveRouteForSurface = (surface: "chat" | "agent") => {
      if (!aiSendState.settings) return null;
      const role = resolveRolePathConfig(
        surface === "agent" ? "chat_agent_main" : "chat_stream_non_agent",
      );
      return resolveChatTurnRoute({
        surface,
        activeSettings: aiSendState.settings,
        activeApiVariant: getChatApiVariant(aiSendState.settings.model),
        composer: composerModel
          ? {
              model: composerModel,
              provider: xprov?.provider ?? null,
              apiVariant: xprov
                ? (xprov.variant ?? null)
                : (getChatApiVariant(composerModel) ?? null),
              endpointId: xprov?.endpointId ?? null,
            }
          : null,
        role: role
          ? {
              model: role.model,
              provider: role.provider,
              apiVariant: role.provider
                ? role.variant
                : getChatApiVariant(role.model),
              endpointId: role.endpointId,
            }
          : null,
        taskEffort: getEffortForTask(surface),
        thinkingDisplay: "summarized",
        thinkingEnabled: aiSendState.settings.thinkingEnabled,
        reasoningEffortOverride:
          aiSendState.settings.reasoningEffortOverride ?? undefined,
      });
    };

    // Route selection precedes all mode/transport decisions. RAG first checks
    // the conversation route, then switches once to the Agent role if that
    // provider can actually serve Web search.
    let turnRoute = resolveRouteForSurface(
      agentModeForThisSend ? "agent" : "chat",
    );
    let isFusionModel =
      (turnRoute?.model ??
        aiSendState.chatModelOverride ??
        aiSendState.settings?.model) === "openrouter/fusion";
    let ragActive =
      get().ragEnabled &&
      isRagCapableProvider(turnRoute?.provider) &&
      !isFusionModel;
    if (!agentModeForThisSend && ragActive) {
      turnRoute = resolveRouteForSurface("agent");
      isFusionModel = turnRoute?.model === "openrouter/fusion";
      ragActive =
        get().ragEnabled &&
        isRagCapableProvider(turnRoute?.provider) &&
        !isFusionModel;
    }
    // CLI is subprocess-only; Fusion is chat-completions-only. Both stay on
    // the plain path even when the Agent toggle is enabled.
    const useAgentPath =
      (agentModeForThisSend || ragActive) &&
      turnRoute?.provider !== "cli" &&
      !isFusionModel;
    const settingsStateAtTurnStart = useSettingsStore.getState();
    const webSearchControlsAtTurnStart = parseWebSearchControls({
      domainMode: settingsStateAtTurnStart.get(
        "ai.webSearch.domainMode",
        "off",
      ),
      domainsJson: settingsStateAtTurnStart.get("ai.webSearch.domains", "[]"),
      maxContentTokensRaw: settingsStateAtTurnStart.get(
        "ai.webSearch.maxContentTokens",
        "",
      ),
    });
    const configuredWebSearchConfigAtTurnStart: WebSearchConfig | null =
      buildWebSearchConfig(
        ragActive,
        agentModeForThisSend,
        webSearchControlsAtTurnStart,
      );
    const agentPrivacyPlan = resolveAgentPrivacyPlan({
      agentMode: agentModeForThisSend,
      ragActive,
      webSearchConfig: configuredWebSearchConfigAtTurnStart,
    });
    const webSearchConfigAtTurnStart = agentPrivacyPlan.webSearchConfig;
    const publicWebSearchPath = agentPrivacyPlan.contextMode === "public-web";
    const useHermesRagInstruction =
      publicWebSearchPath && turnRoute?.toolProtocol === "hermes";
    const ragInstructionTokenReserve = publicWebSearchPath
      ? Math.max(
          ...(["ja", "en"] as const).map((language) => {
            const control = getPromptCatalog(language).agentControl;
            const instruction = useHermesRagInstruction
              ? control.webSearchInstructionHermes
              : control.webSearchInstruction;
            return countTokens(`\n\n${instruction}`);
          }),
        )
      : 0;
    const publicCommandInstructionTokenReserve =
      publicWebSearchPath && commandInstruction
        ? countTokens(commandInstruction)
        : 0;
    const contextInputOverheadTokens =
      TURN_PAYLOAD_SAFETY_MARGIN_TOKENS +
      ragInstructionTokenReserve +
      publicCommandInstructionTokenReserve +
      (useAgentPath && turnRoute
        ? renderAgentToolPayloads(
            turnRoute,
            agentModeForThisSend ? turnAgentToolsSnapshot : [],
            webSearchConfigAtTurnStart,
          ).reduce((sum, payload) => sum + countTokens(payload), 0)
        : estimateMessageEnvelopeTokens([
            { role: "system", content: "" },
            ...initialMessages
              .filter((message) => !message.isSummarized)
              .map((message) => ({
                role: message.role,
                content: message.content,
              })),
            { role: "user", content },
          ]));
    const turnProjectId = activeProjectId ?? getCurrentProjectId();
    const activeSessionAtTurnStart = activeSessionId
      ? initialSessions.find((session) => session.id === activeSessionId)
      : undefined;
    if (
      activeSessionAtTurnStart &&
      activeSessionAtTurnStart.projectId !== turnProjectId
    ) {
      set({ error: "chat session project mismatch" });
      return;
    }
    const sceneTurnAuthority = effectiveSceneId
      ? captureSceneTurnAuthority({
          projectId: turnProjectId,
          sceneId: effectiveSceneId,
          agentMode: useAgentPath,
          turnRoute: turnRoute ?? undefined,
          inputOverheadTokens: contextInputOverheadTokens,
        })
      : null;
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
    const capturedNonSceneAuthority = effectiveSceneId
      ? undefined
      : captureNonSceneContextAuthority({
          state: get(),
          projectId: turnProjectId,
          mode: useAgentPath ? "agent" : "chat",
          agentToolsAvailable: useAgentPath && agentModeForThisSend,
          route: turnRoute,
          inputOverheadTokens: contextInputOverheadTokens,
        });
    const sendTurnId = crypto.randomUUID();
    const sendControl: SendTurnControl = {
      id: sendTurnId,
      projectId: turnProjectId,
      sessionId: activeSessionId,
      surface: useAgentPath ? "agent" : "chat",
      aborted: false,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      transportStarted: false,
      transport:
        turnRoute?.transport ??
        (turnRoute?.provider === "cli" ? "cli-exec" : "http"),
    };
    // A turn that starts without a persisted session is allowed to adopt the
    // session it creates below. Any other session transition invalidates it.
    let turnSessionId = activeSessionId;
    let transportStarted = false;
    _activeSendTurnId = sendTurnId;
    _activeSendControl = sendControl;
    _finalizeStoppedStream = null;
    const isCurrentTurn = (): boolean =>
      _activeSendTurnId === sendTurnId && _activeSendControl === sendControl;
    const capturedProjectIsCurrent = (): boolean => {
      const liveProjectIds = [
        get().activeProjectId,
        useTreeStore.getState().projectId,
        useProjectStore.getState().currentProjectId,
      ].filter((id): id is string => Boolean(id));
      return liveProjectIds.every((id) => id === turnProjectId);
    };
    const capturedChatAuthorityIsCurrent = (): boolean => {
      const current = get();
      const currentProjectId = current.activeProjectId ?? getCurrentProjectId();
      const sameThreadFocus =
        current.threadFocusOverride?.threadId === threadFocusOverride?.threadId;
      const sameTemporalAnchor =
        effectiveSceneId !== null
          ? turnSessionId !== null || current.activeSceneId === activeSceneId
          : current.activeSceneId === activeSceneId;
      return (
        currentProjectId === turnProjectId &&
        current.activeSessionId === turnSessionId &&
        current.chatScope === chatScope &&
        current.scopeAnchorId === scopeAnchorId &&
        sameThreadFocus &&
        sameTemporalAnchor
      );
    };
    const shouldAbortTurn = (): boolean =>
      sendControl.aborted ||
      !isCurrentTurn() ||
      !capturedProjectIsCurrent() ||
      !capturedChatAuthorityIsCurrent();
    const assertTurnAuthority = (): void => {
      if (shouldAbortTurn()) {
        sendControl.aborted = true;
        throw new Error("chat turn authority changed");
      }
    };
    const removeOwnedTurnMessages = (): void => {
      set((state) => ({
        messages: state.messages.filter(
          (message) =>
            message.id !== userMsg.id && message.id !== assistantMsg.id,
        ),
      }));
    };
    const cancelBeforeTransport = (): boolean => {
      if (!shouldAbortTurn()) return false;
      const ownedInvalidTurn = isCurrentTurn();
      if (ownedInvalidTurn) {
        sendControl.aborted = true;
        _activeSendTurnId = null;
        _activeSendControl = null;
      }
      removeOwnedTurnMessages();
      if (ownedInvalidTurn) set({ isStreaming: false });
      if (_activeTurnRoute === turnRoute) _activeTurnRoute = null;
      return true;
    };
    const failBeforeTransport = (error: unknown): void => {
      if (shouldAbortTurn()) {
        cancelBeforeTransport();
        return;
      }
      sendControl.aborted = true;
      removeOwnedTurnMessages();
      set({
        isStreaming: false,
        error: error instanceof Error ? error.message : String(error),
      });
      if (_activeTurnRoute === turnRoute) _activeTurnRoute = null;
      _activeSendTurnId = null;
      _activeSendControl = null;
    };
    const prevMessages = initialMessages;
    // Guard concurrent sends before tokenizer initialization yields control.
    set({
      messages: [...prevMessages, userMsg, assistantMsg],
      isStreaming: true,
      error: null,
    });
    // Route + every mutable context input are fixed before this first await.
    try {
      await ensureTokenizer();
    } catch (error) {
      if (isCurrentTurn()) {
        set({
          messages: prevMessages,
          isStreaming: false,
          error: error instanceof Error ? error.message : String(error),
        });
        _activeSendTurnId = null;
        _activeSendControl = null;
      } else {
        cancelBeforeTransport();
      }
      return;
    }
    if (cancelBeforeTransport()) return;
    _activeTurnRoute = turnRoute;

    // Session-scoped pins and summaries are keyed only by session id. Validate
    // ownership against persisted state before any such source is read.
    if (turnSessionId) {
      try {
        const persistedSession = await chatApi.getSessionForProject(
          turnSessionId,
          turnProjectId,
        );
        if (!persistedSession) {
          throw new Error("chat session project mismatch");
        }
      } catch (error) {
        failBeforeTransport(error);
        return;
      }
      if (cancelBeforeTransport()) return;
    }

    // -----------------------------------------------------------------------
    // セッションが未作成の場合は自動作成 (P0-2)
    // -----------------------------------------------------------------------
    let sessionIdForPersist = activeSessionId;
    if (!sessionIdForPersist) {
      const { nodeId, codexAnchorId, snippetAnchorId } = resolveScopeSessionKey(
        chatScope,
        effectiveSceneId,
        scopeAnchorId,
      );
      try {
        const session = await createSessionForCurrentRuntime(
          turnProjectId,
          "New session",
          nodeId === null ? undefined : nodeId,
          codexAnchorId,
          snippetAnchorId,
        );
        if (cancelBeforeTransport()) return;
        if (session.projectId !== turnProjectId) {
          throw new Error("chat session project mismatch");
        }
        sessionIdForPersist = session.id;
        turnSessionId = session.id;
        sendControl.sessionId = session.id;
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
        failBeforeTransport(e);
        return;
      }
    }
    if (cancelBeforeTransport()) return;

    // -----------------------------------------------------------------------
    // Agent mode path — tool-use loop
    //
    // 通常モードと同じ buildSceneContextPrompt / refreshContextLayers 経由で
    // L1〜L4（自動検出 Codex の summary + Spotlight された Codex/Snippet の content）
    // を注入する。Agent はその上で必要に応じて search_codex / get_codex_entry を
    // 叩いて未注入エントリの探索や詳細深掘りを行う、という階層的アクセス前提。
    // -----------------------------------------------------------------------
    if (useAgentPath) {
      let systemPromptForAgent = "";
      let sentSystemPromptForAgent = "";
      let sentAgentContextLayers: LayerBreakdown[] = [];
      let sentAgentContextTokenCount: number | null = null;
      let currentAgentModel = "";
      const canFinalizeStoppedAgentTurn = (): boolean =>
        sendControl.aborted && isCurrentTurn() && transportStarted;
      const finalizeStoppedAgentTurnAfterTransport =
        async (): Promise<boolean> => {
          if (!canFinalizeStoppedAgentTurn()) return false;

          const assistant = get().messages.find(
            (message) => message.id === assistantMsg.id,
          );
          let metadata: Record<string, unknown> = {};
          if (assistant?.metadata) {
            try {
              const parsed = JSON.parse(assistant.metadata);
              if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
              ) {
                metadata = parsed as Record<string, unknown>;
              }
            } catch {
              metadata = {};
            }
          }
          const stoppedMetadata = JSON.stringify({
            ...metadata,
            stopped: true,
          });
          set((s) => ({
            messages: s.messages.map((message) =>
              message.id === assistantMsg.id
                ? { ...message, metadata: stoppedMetadata }
                : message,
            ),
          }));

          if (!sessionIdForPersist) return true;

          try {
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

            const promptSnapshot =
              sentSystemPromptForAgent || systemPromptForAgent;
            if (promptSnapshot) {
              void chatApi
                .saveMessagePrompt(userMsg.id, {
                  systemPrompt: promptSnapshot,
                  layers: sentAgentContextLayers,
                  totalTokens: sentAgentContextTokenCount,
                  model: currentAgentModel || null,
                })
                .catch((error) =>
                  debugLog.warn(
                    "ChatStore",
                    "saveMessagePrompt",
                    errorDetail(error),
                  ),
                );
            }

            const latestAssistant = get().messages.find(
              (message) => message.id === assistantMsg.id,
            );
            if (
              latestAssistant?.role === "assistant" &&
              latestAssistant.content
            ) {
              await chatApi.addMessage(
                sessionIdForPersist,
                "assistant",
                latestAssistant.content,
                {
                  id: assistantMsg.id,
                  model: currentAgentModel || undefined,
                  metadata: stoppedMetadata,
                },
              );
            }
          } catch (error) {
            debugLog.warn(
              "ChatStore",
              "persist stopped agent turn",
              errorDetail(error),
            );
          }
          return true;
        };
      try {
        // Public RAG is a separate agent: it must not load scene/project
        // context or conversation history before sending the search request.
        const sceneCtx = publicWebSearchPath
          ? null
          : effectiveSceneId
            ? await fetchSceneContext(effectiveSceneId, turnProjectId)
            : null;
        if (!publicWebSearchPath && effectiveSceneId && !sceneCtx) {
          throw new Error("required scene context is unavailable");
        }
        const projectCtx = await fetchRequiredProjectContext(turnProjectId);
        if (cancelBeforeTransport()) return;

        const projectCtxLang = projectCtx?.language ?? "ja";
        let agentMessages = publicWebSearchPath ? [] : prevMessages;
        if (sessionIdForPersist && !publicWebSearchPath) {
          const agentApiVariant = turnRoute
            ? turnRoute.apiVariant
            : xprov
              ? xprov.variant
              : getChatApiVariant(chatModelEarly);
          const fallbackCaps = resolveModelCapabilities(
            chatModelEarly,
            aiSettingsEarly,
            agentApiVariant,
          );
          const contextWindow =
            turnRoute?.contextWindow ?? fallbackCaps.contextWindow;
          const maxOutputTokens =
            turnRoute?.capabilities.maxOutputTokens ??
            fallbackCaps.maxOutputTokens;
          const budgets = allocateLayerBudgets(contextWindow, {
            maxOutputTokens,
            responseReservationTokens:
              turnRoute?.outputBudget.responseReservationTokens,
          });
          agentMessages = await maybeRunSummarization(
            sessionIdForPersist,
            prevMessages,
            budgets.l5,
            projectCtxLang,
            set,
            () => !shouldAbortTurn(),
          );
          if (cancelBeforeTransport()) return;
        }
        const summarizedAgentHistory = agentMessages.filter(
          (message) =>
            message.id !== userMsg.id &&
            message.id !== assistantMsg.id &&
            !message.isSummarized,
        );

        const agentMsgs: AgentMessagePayload[] = [];
        let systemCacheSegmentsForAgent: string[] | undefined;
        let systemVolatileTailForAgent: string | undefined;
        // Spotlight された (= L4 に full body + custom details + aliases が
        // 揃って注入された) エントリの ID 集合。`get_codex_entry` が
        // この集合の ID で呼ばれた場合は executor を呼ばずスタブを返す
        // (LLM はプロンプト指示に従わず再 fetch しがちなため)。
        let fullyInjectedIds: Set<string> = new Set();
        if (sceneCtx) {
          const messagesForCtx: ChatMessage[] = [
            ...summarizedAgentHistory,
            userMsg,
          ];
          const ctxResult = await buildSceneContextPrompt({
            purpose: "send",
            authority: sceneTurnAuthority!,
            sceneCtx,
            projectCtx,
            activeSessionId: sessionIdForPersist ?? activeSessionId,
            conversationMessages: messagesForCtx,
            commandInstruction,
            mentionedSceneIds: options?.mentionedSceneIds,
            mentionedCodexIds: options?.mentionedCodexIds,
            semanticRecallSeedMessage: content,
            trackRecallPromote: true,
            isAuthorized: () => !shouldAbortTurn(),
          });
          if (cancelBeforeTransport()) return;
          systemPromptForAgent = ctxResult.prompt;
          systemCacheSegmentsForAgent = ctxResult.cacheSegments;
          systemVolatileTailForAgent = ctxResult.volatileTail;
          sentAgentContextLayers = ctxResult.layers.map((layer) => ({
            ...layer,
          }));
          sentAgentContextTokenCount = ctxResult.totalTokens;
          fullyInjectedIds = new Set(ctxResult.fullyInjectedIds);
          if (!get().sessionStableContextInitialized) {
            set({
              sessionStableCodexIds: ctxResult.stableCodexIds,
              sessionStableContextInitialized: true,
            });
          }
          set({
            contextTokenCount: ctxResult.totalTokens,
            contextWindowSize: turnRoute?.contextWindow ?? null,
            contextModel: turnRoute?.model ?? null,
            contextLayers: ctxResult.layers,
            contextPlan: ctxResult.contextPlan,
            lastSystemPrompt: ctxResult.prompt,
            lastSystemPromptKey: contextPromptKey(get()),
            detectedEntries: ctxResult.detectedEntries,
            alwaysEntries: ctxResult.alwaysEntries,
            scopeAnchor: null,
          });
        } else if (!publicWebSearchPath) {
          // グローバルチャット: refreshContextLayers が事前に組んだ
          // L1 + Spotlight L4 (codex/snippet) + always エントリ込みの prompt を流用。
          // 入力側で新たに Spotlight された場合に備え再計算してから使う。
          // @scene mention は per-send の一時 pin として渡す。
          if (cancelBeforeTransport()) return;
          const refreshed = await get().refreshContextLayers({
            purpose: "send",
            conversationMessages: [...summarizedAgentHistory, userMsg],
            outgoingUserMessage: content,
            commandInstruction,
            mentionedSceneIds: options?.mentionedSceneIds,
            mentionedCodexIds: options?.mentionedCodexIds,
            // 一回限り override で送るときも、その agentMode で集約 tier を組む
            // （永続トグル基準で組むと pull 委譲が override 送信に効かない）。
            agentModeOverride: useAgentPath,
            turnRoute: turnRoute ?? undefined,
            strict: true,
            capturedNonSceneAuthority,
          });
          systemPromptForAgent = refreshed?.prompt ?? "";
          systemCacheSegmentsForAgent = refreshed?.cacheSegments;
          systemVolatileTailForAgent = refreshed?.volatileTail;
          sentAgentContextLayers = (refreshed?.layers ?? []).map((layer) => ({
            ...layer,
          }));
          sentAgentContextTokenCount = refreshed?.totalTokens ?? null;
          fullyInjectedIds = new Set(refreshed?.fullyInjectedIds ?? []);
        }
        if (cancelBeforeTransport()) return;

        // Public RAG ターンだけ Web 検索の安全指示を system 末尾へ付与する。
        // Private Agent ターンには Web 検索設定自体を渡さないため、指示も不要。
        // (本文をクエリに混入させない / 引用捏造の抑止 / 取得指示の無視)。
        // cacheSegments がある経路は system を cache blocks + volatileTail から
        // 再構築するため、安全指示を tail にも付与する。Public RAG は private
        // context を持たず cacheSegments もないので fallback system 本文を使う。
        if (publicWebSearchPath) {
          // 公開検索へ private scene/history は渡さないが、スラッシュコマンドから
          // 生成した信頼済みの system 指示はこのターンの意図として保持する。
          systemPromptForAgent = commandInstruction ?? "";
          // Public RAG は client tools を宣言しないため、標準版の指示を使う。
          // Hermes 用指示は private Agent と Web 検索を併用する旧経路を残さないため
          // 到達しないが、wire 互換のため条件は保持する。
          const ragAgentControl = getPromptCatalog(
            projectCtx?.language ?? "ja",
          ).agentControl;
          const useHermesRag =
            agentModeForThisSend && turnRoute?.toolProtocol === "hermes";
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
            systemVolatileTailForAgent = systemVolatileTailForAgent
              ? `${systemVolatileTailForAgent}\n\n${ragInstruction}`
              : ragInstruction;
          }
          // PromptPreview / Copy が実送信内容 (RAG 指示込み) を表示できるよう更新。
          set({ lastSystemPrompt: systemPromptForAgent });
        }

        if (systemPromptForAgent) {
          agentMsgs.push({ role: "system", content: systemPromptForAgent });
        }

        // Convert conversation history
        for (const msg of summarizedAgentHistory) {
          if (msg.role === "system") continue;
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
        // チャットパネルで一時選択したモデル(あれば)。role 未設定時に既定より優先する。
        const chatModelOverride =
          useAiSettingsStore.getState().chatModelOverride;
        // agent ロールの override を実モデルとして解決し、API variant / トークン予算 /
        // thinking パラメータ / usage 記録を全て実モデルから導出する。これにより
        // send_agent_message に渡す override（resolveModelForPath / 一時モデル）と
        // thinking 等が一致する（未設定なら既定モデル = byte-identical）。
        // agent ロールの横断割り当て（別プロバイダ/別エンドポイント）。chat_agent_main /
        // agent_research_subagent は同一 "agent" ロールなので、ここで解決した
        // provider/endpoint/variant をサブエージェント送信にも流用する。
        const agentRole = resolveRolePathConfig("chat_agent_main");
        const currentModel =
          turnRoute?.model ??
          (xprov
            ? xprov.model
            : (agentRole?.model ??
              chatModelOverride ??
              aiSettings?.model ??
              ""));
        currentAgentModel = currentModel;
        const currentProvider =
          turnRoute?.provider ??
          xprov?.provider ??
          agentRole?.provider ??
          aiSettings?.provider ??
          "unknown";
        const agentUsageRoute = turnRoute
          ? snapshotInputTokenRoute(turnRoute)
          : null;
        const tokenEstimatorFamily = getTokenEstimatorFamily();
        const agentContextPlanDigest = get().contextPlan?.digest ?? null;
        const agentApiVariant = turnRoute
          ? turnRoute.apiVariant
          : xprov
            ? xprov.variant
            : agentRole?.provider
              ? agentRole.variant
              : getChatApiVariant(currentModel);
        const tokenBudget = getToolTokenBudget(currentModel);
        // model-aware なツール呼び出し上限。大窓モデルほど多段探索を許す。
        const parentMaxToolCalls = getAgentToolCallBudget(currentModel);
        // run_research（サブエージェント）の 1 ターンあたり呼び出し上限。
        // 各サブエージェントは独立したループ（高コスト）なので、親予算とは別枠で
        // 厳しめに絞る。各呼び出しは parentMaxToolCalls も 1 消費する。
        const MAX_SUBAGENT_CALLS = 4;
        let subAgentCallCount = 0;
        const agentThinkingParams =
          turnRoute?.thinking ??
          buildThinkingParams(
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
          assertTurnAuthority();
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
            const sessionId = sessionIdForPersist ?? activeSessionId;
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
          // run_research: 読み取り専用のサブエージェントを別ループで起動し、
          // 要約だけを tool_result として親に返す。親のツール予算を温存しつつ
          // 大規模な調査を1呼び出しに圧縮する。子は read-only ツールのみ宣言され、
          // executeReadOnlyTool で dispatch されるため、書き込み・質問・再帰
          // （run_research 自身）は構造的に不可（depth=1）。
          if (name === RESEARCH_SUBAGENT_TOOL) {
            const task = String(params?.["task"] ?? "").trim();
            if (!task) {
              const msg = "run_research requires a non-empty 'task'.";
              return {
                toolCallId,
                name,
                content: null,
                summary: msg,
                tokensUsed: 0,
                error: msg,
              };
            }
            if (subAgentCallCount >= MAX_SUBAGENT_CALLS) {
              const msg = `Research sub-agent limit reached (${MAX_SUBAGENT_CALLS} per turn). Summarize with the information you already have.`;
              return {
                toolCallId,
                name,
                content: null,
                summary: msg,
                tokensUsed: 0,
                error: msg,
              };
            }
            subAgentCallCount++;

            // 予算分割: 子は親の半分（トークン / 呼び出し）。子の重い文脈は
            // 親予算を消費せず、返す要約のみが親に積まれる。
            const childTokenBudget = Math.max(
              2_000,
              Math.floor(tokenBudget * 0.5),
            );
            const childMaxCalls = Math.max(
              3,
              Math.floor(parentMaxToolCalls / 2),
            );
            const childMessages: AgentMessagePayload[] = [
              { role: "system", content: agentControl.researchSubagentSystem },
              { role: "user", content: task },
            ];

            let researchInputTokenDrift = createInputTokenDriftTotals();
            let childResult;
            try {
              childResult = await runAgentLoop({
                messages: childMessages,
                tools: getResearchSubagentTools(),
                tokenBudget: childTokenBudget,
                maxToolCalls: childMaxCalls,
                // 親 Stop / セッション切替を子にも伝播させる。
                shouldAbort: shouldAbortTurn,
                // 子内部の上限メッセージは「続行」ボタン案内を含まない専用文言。
                // 子に Continue ボタンは無く、その案内を要約へ取り込んで親へ
                // 漏らさないようにする。
                callLimitMessage: agentControl.researchLimitMessage,
                tokenBudgetMessage: agentControl.researchLimitMessage,
                sendToLLM: async (msgs, tools) => {
                  const finalized = turnRoute
                    ? finalizeChatTurnPayload({
                        route: turnRoute,
                        fallbackSystemPrompt: msgs
                          .filter((message) => message.role === "system")
                          .map((message) => message.content)
                          .join("\n"),
                        messages: msgs,
                        tools,
                      })
                    : null;
                  const response = await chatApi.sendAgentMessage(
                    msgs,
                    tools,
                    agentThinkingParams,
                    // 子は親の cacheSegments / volatileTail を使わず、専用の
                    // system prompt を持つ。Web 検索も無効（null）。
                    finalized?.transport.systemCacheSegments,
                    agentApiVariant,
                    null,
                    finalized?.transport.systemVolatileTail,
                    turnRoute?.model ??
                      (xprov
                        ? xprov.model
                        : (agentRole?.model ??
                          resolveModelForPath("agent_research_subagent"))),
                    turnRoute
                      ? turnRoute.providerOverride
                      : (xprov?.provider ?? agentRole?.provider ?? null),
                    turnRoute
                      ? turnRoute.endpointId
                      : (xprov?.endpointId ?? agentRole?.endpointId ?? null),
                    turnRoute?.outputBudget.requestMaxOutputTokens ?? null,
                    turnRoute?.provider ?? null,
                    turnRoute?.resolvedEndpointId ?? null,
                    turnRoute?.toolProtocol ?? null,
                  );
                  researchInputTokenDrift = accumulateInputTokenDrift(
                    researchInputTokenDrift,
                    currentProvider,
                    {
                      estimatedInputTokens:
                        finalized?.usage.inputTokens ?? null,
                      safetyMarginTokens:
                        finalized?.usage.safetyMarginTokens ?? null,
                      inputTokens: response.inputTokens,
                      cacheReadTokens: response.cacheReadTokens,
                      cacheWriteTokens: response.cacheWriteTokens,
                    },
                  );
                  return response;
                },
                executeTool: async (name, toolCallId, params) => {
                  assertTurnAuthority();
                  return executeReadOnlyTool(name, toolCallId, params);
                },
                onProgress: (p) => {
                  if (isCurrentTurn()) set({ subAgentProgress: p });
                },
                onTextChunk: () => {},
              });
            } catch (e) {
              // 子の LLM / ネットワーク失敗で親ターン全体を破棄しない。
              // error ToolResult として返し、親 LLM が回復・継続できるようにする
              // （他ツールと同じ「失敗は tool_result 化」契約に揃える）。
              const msg = e instanceof Error ? e.message : String(e);
              return {
                toolCallId,
                name,
                content: null,
                summary: `Research sub-agent failed: ${msg}`,
                tokensUsed: 0,
                error: msg,
              };
            } finally {
              if (isCurrentTurn()) set({ subAgentProgress: null });
            }

            // 子の LLM usage（input/output/コスト）は親メッセージと同じ traceId で
            // 台帳に記録する（同一論理ターンにロールアップ）。
            void recordAiUsage({
              surface: "agent",
              model: currentModel,
              provider: currentProvider,
              projectId: turnProjectId,
              tokensIn: childResult.tokensIn,
              tokensOut: childResult.tokensOut,
              cacheReadTokens: researchInputTokenDrift.cacheReadTokens,
              cacheWriteTokens: researchInputTokenDrift.cacheWriteTokens,
              costUsd: childResult.cost,
              traceId: assistantMsg.id,
              refId: assistantMsg.id,
              metadata: agentUsageRoute
                ? buildInputTokenDriftMetadata({
                    scope: "agent-research",
                    projectId: turnProjectId,
                    route: agentUsageRoute,
                    estimatorFamily: tokenEstimatorFamily,
                    language: projectCtxLang,
                    contextPlanDigest: null,
                    totals: researchInputTokenDrift,
                  })
                : null,
            });

            const findings = childResult.finalText.trim() || "(no findings)";
            const content = {
              findings,
              toolCalls: childResult.toolCallRecords.length,
            };
            return {
              toolCallId,
              name,
              content,
              summary: `Research sub-agent completed (${childResult.toolCallRecords.length} read calls)`,
              tokensUsed: countTokens(JSON.stringify(content)),
            };
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

        // クライアントツールは private Agent のときだけ渡す。Public RAG は
        // tools=[] とし、Web検索だけを使う分離済み経路にする。
        const agentTools = agentModeForThisSend ? turnAgentToolsSnapshot : [];
        // Web検索設定はpublic RAGにだけ渡す。private Agentでは常にnull。
        // Phase 2: 永続設定 (settingsStore の ai.webSearch.*) のドメイン制御 /
        // content cap を載せる。
        const webSearchConfig = webSearchConfigAtTurnStart;
        let parentInputTokenDrift = createInputTokenDriftTotals();
        const agentTextBatcher = createAgentTextBatcher((text) => {
          if (!isCurrentTurn() || sendControl.aborted) return;
          set((s) => {
            const msgs = [...s.messages];
            const index = msgs.findIndex(
              (message) => message.id === assistantMsg.id,
            );
            const assistant = index >= 0 ? msgs[index] : undefined;
            if (assistant?.role === "assistant") {
              msgs[index] = {
                ...assistant,
                content: assistant.content + text,
              };
            }
            return { messages: msgs };
          });
        });
        let agentLoopResult!: Awaited<ReturnType<typeof runAgentLoop>>;
        try {
          agentLoopResult = await runAgentLoop({
            messages: agentMsgs,
            tools: agentTools,
            tokenBudget,
            maxToolCalls: parentMaxToolCalls,
            shouldAbort: shouldAbortTurn,
            callLimitMessage: agentControl.callLimitMessage,
            tokenBudgetMessage: agentControl.tokenBudgetMessage,
            userQuestionLimitMessage: agentControl.userQuestionLimitMessage,
            sendToLLM: async (msgs, tools) => {
              assertTurnAuthority();
              const finalized = turnRoute
                ? finalizeChatTurnPayload({
                    route: turnRoute,
                    fallbackSystemPrompt: systemPromptForAgent,
                    cacheSegments: systemCacheSegmentsForAgent,
                    volatileTail: systemVolatileTailForAgent,
                    messages: msgs,
                    tools,
                    webSearch: webSearchConfig,
                  })
                : null;
              if (finalized) {
                sentSystemPromptForAgent =
                  materializeSystemDeliverySnapshot(finalized);
                sentAgentContextTokenCount = finalized.usage.inputTokens;
                set({
                  contextTokenCount: finalized.usage.inputTokens,
                  contextWindowSize: finalized.route.contextWindow,
                  contextModel: finalized.route.model,
                  ...(finalized.cacheDowngradeReason === "budget"
                    ? { cacheInvalidatedReason: "budget" as const }
                    : {}),
                });
              }
              transportStarted = true;
              sendControl.transportStarted = true;
              const response = await chatApi.sendAgentMessage(
                msgs,
                tools,
                agentThinkingParams,
                finalized
                  ? finalized.transport.systemCacheSegments
                  : systemCacheSegmentsForAgent,
                agentApiVariant,
                webSearchConfig,
                finalized
                  ? finalized.transport.systemVolatileTail
                  : systemVolatileTailForAgent,
                turnRoute?.model ??
                  (xprov
                    ? xprov.model
                    : (agentRole?.model ?? chatModelOverride ?? null)),
                turnRoute
                  ? turnRoute.providerOverride
                  : (xprov?.provider ?? agentRole?.provider ?? null),
                turnRoute
                  ? turnRoute.endpointId
                  : (xprov?.endpointId ?? agentRole?.endpointId ?? null),
                turnRoute?.outputBudget.requestMaxOutputTokens ?? null,
                turnRoute?.provider ?? null,
                turnRoute?.resolvedEndpointId ?? null,
                turnRoute?.toolProtocol ?? null,
              );
              parentInputTokenDrift = accumulateInputTokenDrift(
                parentInputTokenDrift,
                currentProvider,
                {
                  estimatedInputTokens: finalized?.usage.inputTokens ?? null,
                  safetyMarginTokens:
                    finalized?.usage.safetyMarginTokens ?? null,
                  inputTokens: response.inputTokens,
                  cacheReadTokens: response.cacheReadTokens,
                  cacheWriteTokens: response.cacheWriteTokens,
                },
              );
              return response;
            },
            executeTool: guardedExecuteTool,
            onProgress: (progress) => {
              if (isCurrentTurn() && !sendControl.aborted) {
                set({ agentProgress: progress });
              }
            },
            onToolComplete: (record) => {
              if (!isCurrentTurn() || sendControl.aborted) return;
              accToolCalls.push(record);
              set((s) => {
                const msgs = [...s.messages];
                const index = msgs.findIndex(
                  (message) => message.id === assistantMsg.id,
                );
                const assistant = index >= 0 ? msgs[index] : undefined;
                if (assistant?.role === "assistant") {
                  msgs[index] = {
                    ...assistant,
                    metadata: JSON.stringify({ tool_calls: accToolCalls }),
                  };
                }
                return { messages: msgs };
              });
            },
            onTextChunk: (text) => {
              if (!isCurrentTurn() || sendControl.aborted) return;
              agentTextBatcher.push(text);
            },
          });
        } finally {
          agentTextBatcher.flush();
          agentTextBatcher.dispose();
        }
        const {
          toolCallRecords,
          finalThinkingBlocks,
          citations,
          cost,
          tokensIn: agentTokensIn,
          tokensOut: agentTokensOut,
          stoppedReason: agentStoppedReason,
        } = agentLoopResult;

        const stoppedAgentTurnCanFinalize = canFinalizeStoppedAgentTurn();
        if (shouldAbortTurn() && !stoppedAgentTurnCanFinalize) return;

        // 上限で打ち切られたターンには「続行」ボタンを出す。質問上限(ask_user)は
        // 続行対象外（ユーザー回答待ちで止まる性質なので新予算で再開しても無意味）。
        if (
          agentStoppedReason === "limit_calls" ||
          agentStoppedReason === "limit_tokens"
        ) {
          set({ agentContinuation: { sessionId: sessionIdForPersist } });
        }

        // 引用の事後検証: 不正 URL を排除 + 本文中の裏付けなし URL を検出。
        const safeCitations = sanitizeCitations(citations);
        const answerForCheck =
          get().messages.find((message) => message.id === assistantMsg.id)
            ?.content ?? "";
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
          ...(stoppedAgentTurnCanFinalize ? { stopped: true } : {}),
          ...(finalThinkingBlocks.length > 0
            ? { thinking_blocks: finalThinkingBlocks }
            : {}),
          ...(safeCitations.length > 0 ? { citations: safeCitations } : {}),
          ...(cost != null ? { cost } : {}),
        });
        set((s) => {
          const msgs = [...s.messages];
          const index = msgs.findIndex(
            (message) => message.id === assistantMsg.id,
          );
          const assistant = index >= 0 ? msgs[index] : undefined;
          if (assistant?.role === "assistant") {
            msgs[index] = { ...assistant, metadata: finalAgentMetadata };
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
          // 過去メッセージのプロンプト確認用スナップショット (fire-and-forget)。
          // Cache/plain のうち、最後の Agent iteration が実際に送った system
          // representation を保存する。canonical fallback は次 iteration の
          // budget downgrade 用に不変で保持する。
          const promptSnapshot =
            sentSystemPromptForAgent || systemPromptForAgent;
          if (promptSnapshot) {
            void chatApi
              .saveMessagePrompt(userMsg.id, {
                systemPrompt: promptSnapshot,
                layers: sentAgentContextLayers,
                totalTokens: sentAgentContextTokenCount,
                model: currentModel || null,
              })
              .catch((e) =>
                debugLog.warn("ChatStore", "saveMessagePrompt", errorDetail(e)),
              );
          }
          const lastMsg = get().messages.find(
            (message) => message.id === assistantMsg.id,
          );
          if (lastMsg?.role === "assistant" && lastMsg.content) {
            // 実際に使用したモデル（xprov / agent ロール / chat 一時 override を
            // 反映した currentModel）で永続化・usage 記録する。既定モデルを再読み
            // すると override 時に chat_messages.model と ai_usage が誤ったモデルへ
            // ひも付き、コスト推定もずれる（streaming 経路 / research サブエージェント
            // は既に実モデルで記録している）。currentModel が空文字なら undefined。
            const agentModel = currentModel || undefined;
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
              provider: currentProvider,
              projectId: turnProjectId,
              tokensIn: agentTokensIn,
              tokensOut: agentTokensOut,
              cacheReadTokens: parentInputTokenDrift.cacheReadTokens,
              cacheWriteTokens: parentInputTokenDrift.cacheWriteTokens,
              costUsd: cost,
              traceId: assistantMsg.id,
              refId: assistantMsg.id,
              metadata: agentUsageRoute
                ? buildInputTokenDriftMetadata({
                    scope: "agent-parent",
                    projectId: turnProjectId,
                    route: agentUsageRoute,
                    estimatorFamily: tokenEstimatorFamily,
                    language: projectCtxLang,
                    contextPlanDigest: agentContextPlanDigest,
                    totals: parentInputTokenDrift,
                  })
                : null,
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
        if (shouldAbortTurn()) {
          if (await finalizeStoppedAgentTurnAfterTransport()) {
            return;
          }
          cancelBeforeTransport();
          return;
        }
        const kind = classifyError(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (!transportStarted) removeOwnedTurnMessages();
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
        if (isCurrentTurn()) {
          get()._cancelPendingUserQuestion();
          if (_activeTurnRoute === turnRoute) {
            _activeTurnRoute = null;
          }
          _activeSendTurnId = null;
          _activeSendControl = null;
          set({
            isStreaming: false,
            agentProgress: null,
            subAgentProgress: null,
          });
        } else if (_activeSendControl === sendControl) {
          _activeSendControl = null;
        }
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Normal mode path (existing)
    // -----------------------------------------------------------------------
    try {
      const sceneCtx = effectiveSceneId
        ? await fetchSceneContext(effectiveSceneId, turnProjectId)
        : null;
      if (effectiveSceneId && !sceneCtx) {
        throw new Error("required scene context is unavailable");
      }
      const projectCtx = await fetchRequiredProjectContext(turnProjectId);
      if (cancelBeforeTransport()) return;

      const aiSettings = useAiSettingsStore.getState().settings;
      // チャットパネルで一時選択したモデル(あれば)。role 未設定時に既定より優先する。
      const chatModelOverride = useAiSettingsStore.getState().chatModelOverride;
      // conversation ロールの override を実モデルとして解決し、API variant / コンテキスト
      // 予算 / thinking パラメータ / 記録を実モデルから導出する（transport に渡す
      // override と一致。未設定なら既定モデル = byte-identical）。
      // conversation ロールの横断割り当て（別プロバイダ/別エンドポイント）。provider
      // 未設定なら従来どおり model のみ（active provider）。composer の一時 override
      // (xprov) が最優先。
      const convRole = resolveRolePathConfig("chat_stream_non_agent");
      const chatModel =
        turnRoute?.model ??
        (xprov
          ? xprov.model
          : (convRole?.model ?? chatModelOverride ?? aiSettings?.model ?? ""));
      const chatProvider =
        turnRoute?.provider ??
        xprov?.provider ??
        convRole?.provider ??
        aiSettings?.provider ??
        "unknown";
      const chatUsageRoute = turnRoute
        ? snapshotInputTokenRoute(turnRoute)
        : null;
      const tokenEstimatorFamily = getTokenEstimatorFamily();
      const chatApiVariant = turnRoute
        ? turnRoute.apiVariant
        : xprov
          ? xprov.variant
          : convRole?.provider
            ? convRole.variant
            : getChatApiVariant(chatModel);
      const fallbackCaps = resolveModelCapabilities(
        chatModel,
        aiSettings,
        chatApiVariant,
      );
      const contextWindow =
        turnRoute?.contextWindow ?? fallbackCaps.contextWindow;
      const maxOutputTokens =
        turnRoute?.capabilities.maxOutputTokens ?? fallbackCaps.maxOutputTokens;
      const budgets = allocateLayerBudgets(contextWindow, {
        maxOutputTokens,
        responseReservationTokens:
          turnRoute?.outputBudget.responseReservationTokens,
      });

      let currentMessages = prevMessages;
      if (sessionIdForPersist) {
        currentMessages = await maybeRunSummarization(
          sessionIdForPersist,
          prevMessages,
          budgets.l5,
          projectCtx?.language ?? "ja",
          set,
          () => !shouldAbortTurn(),
        );
        if (cancelBeforeTransport()) return;
      }
      // Summarization publishes its result through the live store, which also
      // contains this turn's optimistic user/assistant pair. Keep a single
      // explicit pre-turn projection for App Server bootstrap and revision
      // hashing so the current user message is never imported and sent twice.
      const priorHistoryMessages = currentMessages.filter(
        (message) =>
          message.id !== userMsg.id && message.id !== assistantMsg.id,
      );

      // APIペイロードを構築（要約済みメッセージを除外）
      const messagesForApi: ChatMessage[] = [
        ...priorHistoryMessages.filter((message) => !message.isSummarized),
        userMsg,
      ];

      let systemCacheSegments: string[] | undefined;
      let systemVolatileTail: string | undefined;
      // 過去メッセージのプロンプト確認用: このターンで実際に送った system
      // プロンプトを退避し、persist 時に userMsg.id へひも付けて保存する。
      // 空 = この経路では system メッセージを送らなかった (スナップショット不要)。
      let sentSystemPrompt = "";
      let sentContextLayers: LayerBreakdown[] = [];
      let sentContextTokenCount: number | null = null;

      if (sceneCtx) {
        const ctxResult = await buildSceneContextPrompt({
          purpose: "send",
          authority: sceneTurnAuthority!,
          sceneCtx,
          projectCtx,
          activeSessionId: sessionIdForPersist ?? activeSessionId,
          conversationMessages: messagesForApi,
          commandInstruction,
          mentionedSceneIds: options?.mentionedSceneIds,
          mentionedCodexIds: options?.mentionedCodexIds,
          semanticRecallSeedMessage: content,
          trackRecallPromote: true,
          isAuthorized: () => !shouldAbortTurn(),
        });
        if (cancelBeforeTransport()) return;

        if (!get().sessionStableContextInitialized) {
          set({
            sessionStableCodexIds: ctxResult.stableCodexIds,
            sessionStableContextInitialized: true,
          });
        }
        systemCacheSegments = ctxResult.cacheSegments;
        systemVolatileTail = ctxResult.volatileTail;
        sentContextLayers = ctxResult.layers.map((layer) => ({ ...layer }));
        sentContextTokenCount = ctxResult.totalTokens;

        set({
          contextTokenCount: ctxResult.totalTokens,
          contextWindowSize: turnRoute?.contextWindow ?? null,
          contextModel: turnRoute?.model ?? null,
          contextLayers: ctxResult.layers,
          contextPlan: ctxResult.contextPlan,
          lastSystemPrompt: ctxResult.prompt,
          lastSystemPromptKey: contextPromptKey(get()),
          detectedEntries: ctxResult.detectedEntries,
          alwaysEntries: ctxResult.alwaysEntries,
          scopeAnchor: null,
          // cacheInvalidatedReason はここではクリアしない: モデル変更で立てた
          // バッジを同一ターン内 (=変更直後の送信) で消してしまい、scene 経路だけ
          // バッジが見えなくなる非対称を生むため。消灯は sendMessage 冒頭の
          // モデル一致判定に一元化した。
        });
        sentSystemPrompt = ctxResult.prompt;

        const systemMsg: ChatMessage = {
          id: "system",
          sessionId,
          role: "system",
          content: ctxResult.prompt,
          createdAt: new Date().toISOString(),
        };
        messagesForApi.unshift(systemMsg);
      } else {
        // Non-scene send always creates a fresh immutable TurnRequest. The UI
        // `lastSystemPrompt` remains a display cache and is never a correctness
        // input: its source revisions cannot be represented by a small key.
        if (cancelBeforeTransport()) return;
        const refreshed = await get().refreshContextLayers({
          purpose: "send",
          conversationMessages: messagesForApi,
          outgoingUserMessage: content,
          commandInstruction,
          mentionedSceneIds: options?.mentionedSceneIds,
          mentionedCodexIds: options?.mentionedCodexIds,
          agentModeOverride: useAgentPath,
          turnRoute: turnRoute ?? undefined,
          strict: true,
          capturedNonSceneAuthority,
        });
        const fallbackPrompt = refreshed?.prompt ?? "";
        systemCacheSegments = refreshed?.cacheSegments;
        systemVolatileTail = refreshed?.volatileTail;
        sentContextLayers = (refreshed?.layers ?? []).map((layer) => ({
          ...layer,
        }));
        sentContextTokenCount = refreshed?.totalTokens ?? null;
        if (fallbackPrompt) {
          const fallbackSystemMsg: ChatMessage = {
            id: "system",
            sessionId,
            role: "system",
            content: fallbackPrompt,
            createdAt: new Date().toISOString(),
          };
          messagesForApi.unshift(fallbackSystemMsg);
          sentSystemPrompt = fallbackPrompt;
        }
      }

      const chatThinkingParams =
        turnRoute?.thinking ??
        buildThinkingParams(
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
      const chatContextPlanDigest = get().contextPlan?.digest ?? null;
      const turnTransport =
        turnRoute?.transport ??
        (turnRoute?.provider === "cli" ? "cli-exec" : "http");
      const isCodexAppServer = turnTransport === "codex-app-server";
      const codexExpectedWorkspacePath = isCodexAppServer
        ? turnWorkspaceIdentity?.path
        : undefined;
      if (isCodexAppServer && !codexExpectedWorkspacePath) {
        throw new Error("Active workspace is unavailable for Codex App Server");
      }
      let estimatedChatInputTokens: number | null = null;
      let chatSafetyMarginTokens: number | null = null;
      if (turnRoute) {
        const finalized =
          turnTransport === "cli-exec"
            ? finalizeTurnPayload(
                {
                  route: turnRoute,
                  system: { fallback: "" },
                  messages: [],
                  renderedToolPayloads: [flattenMessagesForCli(apiPayload)],
                  envelopeTokens: 0,
                  safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
                },
                countTokens,
              )
            : finalizeChatTurnPayload({
                route: turnRoute,
                fallbackSystemPrompt:
                  sentSystemPrompt ||
                  apiPayload
                    .filter((message) => message.role === "system")
                    .map((message) => message.content)
                    .join("\n"),
                cacheSegments: systemCacheSegments,
                volatileTail: systemVolatileTail,
                messages: apiPayload,
              });
        systemCacheSegments = finalized.transport.systemCacheSegments;
        systemVolatileTail = finalized.transport.systemVolatileTail;
        estimatedChatInputTokens = finalized.usage.inputTokens;
        chatSafetyMarginTokens = finalized.usage.safetyMarginTokens;
        sentContextTokenCount = finalized.usage.inputTokens;
        if (turnTransport !== "cli-exec") {
          sentSystemPrompt = materializeSystemDeliverySnapshot(finalized);
        }
        set({
          contextTokenCount: finalized.usage.inputTokens,
          contextWindowSize: finalized.route.contextWindow,
          contextModel: finalized.route.model,
          ...(finalized.cacheDowngradeReason === "budget"
            ? { cacheInvalidatedReason: "budget" as const }
            : {}),
        });
      }
      if (cancelBeforeTransport()) return;
      const chatStartTime = performance.now();

      // Accumulate thinking text locally during streaming
      let thinkingAccumulator = "";
      const isFirstResponse =
        prevMessages.filter((m) => m.role === "assistant").length === 0;

      // CLI プロバイダ選択時は subprocess 経由のストリームに切り替える。
      // CLI は単一プロンプトしか受け付けないので、会話履歴は role タグ付きで
      // 平坦化する。
      // 別プロバイダ override 中は HTTP 経路(別プロバイダは cli 非対象)に流すため、
      // active provider が cli でも cli subprocess 経路には落とさない。
      const isCliExec = turnRoute
        ? turnTransport === "cli-exec"
        : !xprov && aiSettings?.provider === "cli";
      const cliConfig = turnRoute?.effectiveSettings.cli ??
        aiSettings?.cli ?? {
          kind: "claude" as const,
          binaryPath: "",
          model: "",
        };
      const codexTransport = cliConfig.codexTransport ?? "exec";
      const codexHistoryRevision = isCodexAppServer
        ? await computeChatHistoryRevision(priorHistoryMessages)
        : null;
      const codexBootstrapHistory = isCodexAppServer
        ? buildCodexBootstrapHistory(priorHistoryMessages)
        : undefined;
      // Web Crypto yields while hashing the imported history. Stop/session
      // changes during that await must be observed before start_turn is issued.
      if (cancelBeforeTransport()) return;
      let codexThreadId: string | undefined;
      let codexTurnId: string | undefined;
      const codexItems = new Map<string, codexAppApi.CodexAppItem>();
      const codexWarnings: string[] = [];

      // Start streaming — returns a Promise<cleanup_fn>
      await new Promise<void>((resolve, reject) => {
        // delta coalesce: provider が 1:1 で emit する SSE delta(秒間 20〜40)を
        // requestAnimationFrame でまとめて flush し、streaming bubble の
        // ReactMarkdown 再パース頻度を frame rate に抑える（所見#1b）。
        // onDone/onError/stop では必ず同期 flush して末尾を取りこぼさない。
        let pendingDelta = "";
        let flushHandle: number | null = null;
        let callbacksSettled = false;
        let turnStreamCleanup: (() => void) | null = null;
        const flushDelta = () => {
          if (flushHandle !== null) {
            if (typeof cancelAnimationFrame === "function") {
              cancelAnimationFrame(flushHandle);
            }
            flushHandle = null;
          }
          if (!isCurrentTurn()) {
            pendingDelta = "";
            return;
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

        const callbacks: chatApi.StreamCallbacks = {
          onTextDelta: (delta: string) => {
            if (!isCurrentTurn()) return;
            pendingDelta += delta;
            scheduleFlush();
          },
          onThinkingDelta: (delta: string) => {
            if (!isCurrentTurn()) return;
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
            if (callbacksSettled) return;
            callbacksSettled = true;
            if (_finalizeStoppedStream === finalizeStoppedStream) {
              _finalizeStoppedStream = null;
            }
            if (!isCurrentTurn()) {
              pendingDelta = "";
              if (flushHandle !== null) {
                if (typeof cancelAnimationFrame === "function") {
                  cancelAnimationFrame(flushHandle);
                }
                flushHandle = null;
              }
              turnStreamCleanup?.();
              resolve();
              return;
            }
            // 末尾の buffered delta を確定前に同期反映。
            flushDelta();
            if (_flushPendingDelta === flushDelta) {
              _flushPendingDelta = null;
            }
            const chatDurationMs = Math.round(
              performance.now() - chatStartTime,
            );
            const chatInputTokenDrift = accumulateInputTokenDrift(
              createInputTokenDriftTotals(),
              chatProvider,
              {
                estimatedInputTokens: estimatedChatInputTokens,
                safetyMarginTokens: chatSafetyMarginTokens,
                inputTokens: info.inputTokens,
                cacheReadTokens: info.cacheReadTokens,
                cacheWriteTokens: info.cacheWriteTokens,
              },
            );

            // N4: 通常チャットの usage を台帳に記録 (chat_messages.tokens_* とは
            // 別に、集計用の単一台帳に集約する。cost は OpenRouter streaming 実値)。
            void recordAiUsage({
              surface: "chat",
              model: chatModel || undefined,
              provider: chatProvider,
              projectId: turnProjectId,
              tokensIn: info.inputTokens,
              tokensOut: info.outputTokens,
              costUsd: info.cost ?? null,
              cacheReadTokens: info.cacheReadTokens,
              cacheWriteTokens: info.cacheWriteTokens,
              durationMs: chatDurationMs,
              traceId: assistantMsg.id,
              refId: assistantMsg.id,
              metadata: chatUsageRoute
                ? buildInputTokenDriftMetadata({
                    scope: "chat",
                    projectId: turnProjectId,
                    route: chatUsageRoute,
                    estimatorFamily: tokenEstimatorFamily,
                    language: projectCtx?.language ?? null,
                    contextPlanDigest: chatContextPlanDigest,
                    totals: chatInputTokenDrift,
                  })
                : null,
            });

            // Build metadata: thinking blocks + stopped flag
            const metadataObj: Record<string, unknown> = {};
            if (thinkingAccumulator) {
              metadataObj.thinking_blocks = [{ thinking: thinkingAccumulator }];
            }
            if (sendControl.transport === "codex-app-server") {
              metadataObj.runtime = "codex-app-server";
              metadataObj.usage_source = "app-server";
              metadataObj.stop_reason = info.stopReason;
              if (codexThreadId) metadataObj.codex_thread_id = codexThreadId;
              if (codexTurnId) metadataObj.codex_turn_id = codexTurnId;
              if (codexItems.size > 0) {
                metadataObj.codex_item_ids = [...codexItems.keys()];
                metadataObj.codex_items = [...codexItems.values()].map(
                  (item) => {
                    const safeItem = { ...item };
                    delete safeItem.raw;
                    return safeItem;
                  },
                );
              }
              if (codexWarnings.length > 0) {
                metadataObj.codex_warnings = codexWarnings;
              }
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

            // A binding stores the history that existed before this turn. Once
            // both messages are durable, advance it to the exact active-history
            // projection that the next turn will hash. Synthetic local Stop and
            // exec fallback deliberately leave the old revision in place, which
            // forces a safe new thread on the next send.
            const completedCodexBinding =
              sendControl.transport === "codex-app-server" &&
              info.stopReason !== "stopped" &&
              codexHistoryRevision !== null &&
              codexThreadId &&
              codexTurnId &&
              get().messages.some(
                (message) =>
                  message.id === assistantMsg.id &&
                  message.role === "assistant" &&
                  message.content.length > 0,
              )
                ? {
                    threadId: codexThreadId,
                    turnId: codexTurnId,
                    expectedHistoryRevision: codexHistoryRevision,
                    // Hash the exact pre-turn projection plus only the two
                    // messages owned by this turn. A live-store mutation must
                    // not become the revision of an already-running thread.
                    nextHistoryRevision: computeChatHistoryRevision([
                      ...priorHistoryMessages.map((message) => ({
                        ...message,
                      })),
                      { ...userMsg },
                      {
                        ...assistantMsg,
                        content:
                          get().messages.find(
                            (message) => message.id === assistantMsg.id,
                          )?.content ?? "",
                      },
                    ]),
                  }
                : null;

            // Persist to DB
            const persistToDb = async () => {
              if (!sessionIdForPersist) return;
              const lastMsg = get().messages.find(
                (message) => message.id === assistantMsg.id,
              );
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
              // 過去メッセージのプロンプト確認用スナップショット (fire-and-forget)。
              // user メッセージ行が存在してから FK 付きで保存する。
              if (sentSystemPrompt) {
                void chatApi
                  .saveMessagePrompt(userMsg.id, {
                    systemPrompt: sentSystemPrompt,
                    layers: sentContextLayers,
                    totalTokens: sentContextTokenCount,
                    model: chatModel || null,
                  })
                  .catch((e) =>
                    debugLog.warn(
                      "ChatStore",
                      "saveMessagePrompt",
                      errorDetail(e),
                    ),
                  );
              }
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

              if (completedCodexBinding) {
                try {
                  const nextHistoryRevision =
                    await completedCodexBinding.nextHistoryRevision;
                  const liveHistoryRevision = await computeChatHistoryRevision(
                    get().messages.map((message) => ({ ...message })),
                  );
                  if (liveHistoryRevision !== nextHistoryRevision) {
                    debugLog.warn(
                      "ChatStore",
                      "skip Codex history revision after concurrent history mutation",
                    );
                  } else {
                    await codexAppApi.advanceCodexHistoryRevision({
                      projectId: turnProjectId,
                      sessionId: sessionIdForPersist,
                      grimodexTurnId: sendTurnId,
                      codexThreadId: completedCodexBinding.threadId,
                      codexTurnId: completedCodexBinding.turnId,
                      expectedHistoryRevision:
                        completedCodexBinding.expectedHistoryRevision,
                      nextHistoryRevision,
                    });
                  }
                } catch (error: unknown) {
                  // Persistence already succeeded. Keeping the old revision is
                  // the fail-safe: the next send archives instead of resuming a
                  // thread whose local history could be stale.
                  debugLog.warn(
                    "ChatStore",
                    "advance Codex history revision",
                    errorDetail(error),
                  );
                }
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
                      if (isCodexAppServer && turnWorkspaceIdentity) {
                        void codexAppApi
                          .setCodexSessionThreadName({
                            projectId: turnProjectId,
                            sessionId: sessionIdForPersist,
                            expectedWorkspacePath: turnWorkspaceIdentity.path,
                            name: title,
                          })
                          .catch((error: unknown) =>
                            debugLog.warn(
                              "ChatStore",
                              "sync Codex thread title",
                              errorDetail(error),
                            ),
                          );
                      }
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
                turnStreamCleanup?.();
                if (_streamCleanup === turnStreamCleanup) {
                  _streamCleanup = null;
                }
                if (isCurrentTurn()) set({ isStreaming: false });
                resolve();
              });
          },
          onError: (message: string) => {
            if (callbacksSettled) return;
            callbacksSettled = true;
            if (_finalizeStoppedStream === finalizeStoppedStream) {
              _finalizeStoppedStream = null;
            }
            if (!isCurrentTurn()) {
              pendingDelta = "";
              turnStreamCleanup?.();
              resolve();
              return;
            }
            // エラー時も partial content を保持するため同期 flush。
            flushDelta();
            if (_flushPendingDelta === flushDelta) {
              _flushPendingDelta = null;
            }
            turnStreamCleanup?.();
            if (_streamCleanup === turnStreamCleanup) {
              _streamCleanup = null;
            }
            if (sendControl.transport === "codex-app-server") {
              const runtimeMetadata = {
                runtime: "codex-app-server",
                runtime_error: message,
                ...(codexThreadId ? { codex_thread_id: codexThreadId } : {}),
                ...(codexTurnId ? { codex_turn_id: codexTurnId } : {}),
              };
              set((s) => ({
                messages: s.messages.map((messageItem) =>
                  messageItem.id === assistantMsg.id
                    ? {
                        ...messageItem,
                        metadata: JSON.stringify(runtimeMetadata),
                      }
                    : messageItem,
                ),
              }));
            }
            reject(new Error(message));
          },
        };

        const codexCallbacks: codexAppApi.CodexAppStreamCallbacks = {
          ...callbacks,
          onTurnStarted: ({ threadId, turnId }) => {
            if (threadId) codexThreadId = threadId;
            if (turnId) codexTurnId = turnId;
          },
          onItemStarted: (item) => {
            codexItems.set(item.id, item);
          },
          onItemCompleted: (item) => {
            codexItems.set(item.id, item);
          },
          onWarning: (message) => {
            if (codexWarnings.length < 32) codexWarnings.push(message);
          },
          onFallback: () => {
            sendControl.transport = "cli-exec";
          },
        };

        const finalizeStoppedStream = () => {
          callbacks.onDone({ stopReason: "stopped" });
        };
        _finalizeStoppedStream = finalizeStoppedStream;

        transportStarted = true;
        sendControl.transportStarted = true;
        const streamPromise = isCodexAppServer
          ? codexAppApi.sendCodexAppTurn(
              {
                projectId: turnProjectId,
                sessionId: sessionIdForPersist,
                expectedWorkspacePath: codexExpectedWorkspacePath!,
                grimodexTurnId: sendTurnId,
                clientUserMessageId: userMsg.id,
                model: turnRoute?.model || cliConfig.model || undefined,
                effort: turnRoute?.thinking.effort ?? undefined,
                contextPacket:
                  sentSystemPrompt ||
                  systemCacheSegments?.join("\n\n") ||
                  "No additional Grimodex context is available.",
                bootstrapHistory: codexBootstrapHistory,
                historyRevision: codexHistoryRevision ?? "empty",
                userMessage: content,
                transport: codexTransport === "auto" ? "auto" : "app-server",
                ...(codexTransport === "auto"
                  ? {
                      fallbackCli: {
                        cli: cliConfig.kind,
                        binaryPath: cliConfig.binaryPath || undefined,
                        model: turnRoute?.model || cliConfig.model || undefined,
                        prompt: flattenMessagesForCli(apiPayload),
                      },
                    }
                  : {}),
              },
              codexCallbacks,
            )
          : isCliExec
            ? cliApi.sendCliChatStream(
                {
                  cli: cliConfig.kind,
                  binaryPath: cliConfig.binaryPath || undefined,
                  model:
                    (turnRoute?.provider === "cli"
                      ? turnRoute.model
                      : cliConfig.model) || undefined,
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
                systemVolatileTail,
                // role 未設定なら一時モデル(あれば)を送る。両方無ければ null=既定で
                // byte-identical(キャッシュ温存)。agent 経路と同契約。別プロバイダ override 最優先。
                turnRoute?.model ??
                  (xprov
                    ? xprov.model
                    : (convRole?.model ?? chatModelOverride ?? null)),
                // 別プロバイダ override 時のみ provider を渡す(同一プロバイダは null=既定)。
                // role に横断割り当てがあればそれを送る。
                turnRoute
                  ? turnRoute.providerOverride
                  : (xprov?.provider ?? convRole?.provider ?? null),
                // OpenAI 互換の別エンドポイント override（同一 provider でも送信先を切替）。
                turnRoute
                  ? turnRoute.endpointId
                  : (xprov?.endpointId ?? convRole?.endpointId ?? null),
                turnRoute?.outputBudget.requestMaxOutputTokens ?? null,
                turnRoute?.provider ?? null,
                turnRoute?.resolvedEndpointId ?? null,
              );

        streamPromise
          .then((cleanup) => {
            turnStreamCleanup = cleanup;
            if (callbacksSettled || !isCurrentTurn()) {
              cleanup();
            } else {
              _streamCleanup = cleanup;
            }
          })
          .catch((error) => {
            if (isCurrentTurn()) reject(error);
            else resolve();
          });
      });
    } catch (e) {
      if (shouldAbortTurn()) {
        cancelBeforeTransport();
        return;
      }
      const kind = classifyError(e);
      const msg = e instanceof Error ? e.message : String(e);
      if (!transportStarted) removeOwnedTurnMessages();

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
        toast.warning(i18next.t("chat.rateLimited"));
        // 失敗した placeholder（user + 空 assistant）を除去し、再送時の重複
        // バブル（同じ user メッセージが 2 通 + 宙に浮いた空 assistant）を防ぐ。
        set((s) => ({
          messages: s.messages.filter(
            (m) => m.id !== userMsg.id && m.id !== assistantMsg.id,
          ),
          isStreaming: false,
        }));
        // 永続 429 での無限リトライ（10 秒ごとに API を叩き続け、messages が
        // 2 通/回で無限増殖）を防ぐため上限を設ける。新規送信は
        // _rateLimitRetry=undefined から始まるのでカウンタは自然にリセットされる。
        const attempt = (options?._rateLimitRetry ?? 0) + 1;
        if (attempt > MAX_RATE_LIMIT_RETRIES) {
          set({ error: msg });
          return;
        }
        // 送信先セッションを pin。待機中にユーザーがセッション/シーンを切り替えて
        // いたら再送を中止する（別会話への誤送信防止）。
        const retrySessionId = get().activeSessionId;
        setTimeout(() => {
          if (get().activeSessionId !== retrySessionId) return;
          void get().sendMessage(content, commandInstruction, {
            ...options,
            _rateLimitRetry: attempt,
          });
        }, 10_000);
        return;
      } else if (kind === "network") {
        toast.error(i18next.t("chat.networkError"));
      } else {
        toast.error(i18next.t("chat.sendFailed", { message: msg }));
      }

      set({ error: msg });
    } finally {
      if (isCurrentTurn()) {
        // isStreaming is set to false inside onDone/onError callbacks
        // but guard here in case of early exit.
        if (get().isStreaming) set({ isStreaming: false });
        if (_activeTurnRoute === turnRoute) _activeTurnRoute = null;
        _activeSendTurnId = null;
        _activeSendControl = null;
      } else if (_activeSendControl === sendControl) {
        _activeSendControl = null;
      }
    }
  },

  refreshContextLayers: async (opts) => {
    const refreshGeneration = ++_contextRefreshGeneration;
    const {
      activeSceneId,
      activeProjectId,
      activeSessionId,
      chatScope,
      scopeAnchorId,
      threadFocusOverride,
      sessions,
    } = get();
    const conversationMessages = (
      opts?.conversationMessages ?? get().messages
    ).map((message) => ({ ...message }));
    const sceneConversationMessages = opts?.conversationMessages
      ? conversationMessages
      : conversationMessages.filter((message) => !message.isSummarized);
    // 構築開始時点のスコープ構成キー。完了時に lastSystemPrompt とペアで保存し、
    // 送信側の stale 判定（構成が変わったプロンプトの流用防止）に使う。
    const promptKey = contextPromptKey({
      chatScope,
      scopeAnchorId,
      activeSceneId,
      activeSessionId,
      threadFocusOverride,
    });
    // 一回限りの Agent mode override（送信経路から渡る）を優先。無ければ永続トグル。
    const effectiveAgentMode = opts?.agentModeOverride ?? get().agentMode;
    const refreshTurnRoute = opts?.turnRoute;
    // synopsis の pull 委譲は「実際にツールループが走る」provider でのみ安全。
    // CLI はツール無しで非 agent 経路に落ちる（useAgentPath の aiProvider !== "cli"）。
    // CLI で pull 委譲すると outline + 使えない取得ツール指示 + synopsis 皆無となり、
    // pull 委譲前（全 synopsis push）より文脈が悪化する。よって CLI では push を維持する。
    const xprov = getCrossProviderChatOverride();
    const aiProvider =
      refreshTurnRoute?.provider ??
      xprov?.provider ??
      useAiSettingsStore.getState().settings?.provider;
    const agentPullWillRunTools = effectiveAgentMode && aiProvider !== "cli";
    // Phase 3b: スレッド focus 中は scene を主題にしない（縦糸を <focus_subject>
    // へ載せる非 scene 枝へ落とす）。chatScope は変えない＝session 保存先不変。
    const effectiveSceneId = opts?.capturedNonSceneAuthority
      ? null
      : chatScope === "scene" && !threadFocusOverride
        ? activeSceneId
        : null;
    const sceneAuthority = effectiveSceneId
      ? captureSceneTurnAuthority({
          projectId: activeProjectId ?? getCurrentProjectId(),
          sceneId: effectiveSceneId,
          agentMode: effectiveAgentMode,
          turnRoute: refreshTurnRoute,
        })
      : null;
    const refreshProjectId =
      opts?.capturedNonSceneAuthority?.requestSeed.projectId ??
      sceneAuthority?.projectId ??
      activeProjectId ??
      getCurrentProjectId();
    const refreshAuthorityIsCurrent = (): boolean => {
      const current = get();
      return (
        refreshGeneration === _contextRefreshGeneration &&
        (current.activeProjectId ?? getCurrentProjectId()) ===
          refreshProjectId &&
        contextPromptKey(current) === promptKey
      );
    };
    const activeSessionAtRefresh = activeSessionId
      ? sessions.find((session) => session.id === activeSessionId)
      : undefined;
    if (
      activeSessionAtRefresh &&
      activeSessionAtRefresh.projectId !== refreshProjectId
    ) {
      const error = new Error("chat session project mismatch");
      set({
        contextTokenCount: 0,
        contextWindowSize: null,
        contextModel: null,
        contextLayers: [],
        contextPlan: null,
        lastSystemPrompt: "",
        lastSystemPromptKey: null,
      });
      if (opts?.strict) throw error;
      return null;
    }
    // All mutable turn inputs above (and the non-scene request below) are
    // captured synchronously before this promise is awaited.
    markStart("refreshContextLayers.ensureTokenizer");
    const tokenizerReady = ensureTokenizer();
    if (!effectiveSceneId) {
      const nonSceneAuthority =
        opts?.capturedNonSceneAuthority ??
        captureNonSceneContextAuthority({
          state: get(),
          projectId: refreshProjectId,
          mode: effectiveAgentMode ? "agent" : "chat",
          agentToolsAvailable: agentPullWillRunTools,
          route: refreshTurnRoute ?? null,
        });
      const temporalResolution = nonSceneAuthority.temporalResolution;
      const request = createNonSceneTurnContextRequest({
        ...nonSceneAuthority.requestSeed,
        requestId: crypto.randomUUID(),
        purpose: opts?.purpose ?? "live",
        sessionId: activeSessionId,
        messages: conversationMessages,
        outgoingUserMessage: opts?.outgoingUserMessage ?? "",
        commandInstruction: opts?.commandInstruction,
        mentionedSceneIds: opts?.mentionedSceneIds ?? [],
        mentionedCodexIds: opts?.mentionedCodexIds ?? [],
      });

      try {
        await tokenizerReady;
        markEnd("refreshContextLayers.ensureTokenizer");
        if (
          activeSessionId &&
          !(await chatApi.getSessionForProject(
            activeSessionId,
            refreshProjectId,
          ))
        ) {
          throw new Error("chat session project mismatch");
        }
        const planned = await planNonSceneChatContext(
          request,
          createNonSceneContextPlannerDeps({
            // refreshContextLayers initializes it before capturing the request.
            ensureTokenizer: async () => {},
            renderPrompt: renderLegacyPrompt,
            source: {
              fetchProjectContext: fetchRequiredProjectContext,
              listCodexEntries: listCodexEntriesForContext,
              listCodexContextMetadata,
              listCodexEntriesByIds: listCodexEntriesForContextByIds,
              getTemporalResolution: (sourceProjectId) => {
                if (sourceProjectId !== request.projectId) {
                  throw new Error("non-scene temporal project mismatch");
                }
                return temporalResolution;
              },
              listPhases: listPhasesByEntryIds,
              listPhaseDetailOverrides: listDetailOverridesByPhaseIds,
              listRawDetailValues: listRawDetailValuesByEntryIds,
              findMentionedEntries: findMentionedEntriesAsync,
              listCodexRelations,
              loadMentionedScenes: (sourceProjectId, ids) => {
                if (sourceProjectId !== request.projectId) {
                  throw new Error("non-scene mentioned scene project mismatch");
                }
                return loadMentionedScenes(
                  [...ids],
                  null,
                  request.sourceSnapshot.treeNodes,
                );
              },
              getSnippet,
              buildAggregatedScene,
              listPinnedCodex: chatApi.listPinnedCodexEntries,
              listPinnedSnippets: listPinnedSnippetEntries,
              listContextDetails: listContextDetailsByEntryIds,
              loadMapBoardMarkdown: (sourceRequest, entries) =>
                loadMapBoardMarkdown(entries, {
                  enabled: sourceRequest.map.enabled,
                  boardId: sourceRequest.map.boardId,
                  activeBoardId: sourceRequest.map.activeBoardId,
                  projectId: sourceRequest.projectId,
                  treeNodes: sourceRequest.sourceSnapshot.treeNodes,
                }),
            },
          }),
        );
        if (refreshAuthorityIsCurrent()) {
          const initializeStableContext =
            opts?.purpose === "send" && !get().sessionStableContextInitialized;
          set({
            contextTokenCount: planned.totalTokens,
            contextWindowSize: refreshTurnRoute?.contextWindow ?? null,
            contextModel: refreshTurnRoute?.model ?? null,
            contextLayers: planned.layers,
            contextPlan: planned.contextPlan,
            lastSystemPrompt: planned.prompt,
            lastSystemPromptKey: promptKey,
            detectedEntries: planned.detectedEntries,
            alwaysEntries: planned.alwaysEntries,
            scopeAnchor: planned.scopeAnchor,
            projectOutline: planned.projectOutline,
            chapterOutlines: planned.chapterOutlines,
            ...(initializeStableContext
              ? {
                  sessionStableCodexIds: planned.stableContextIds,
                  sessionStableContextInitialized: true,
                }
              : {}),
          });
        }
        return planned;
      } catch (error) {
        if (refreshAuthorityIsCurrent()) {
          set({
            contextTokenCount: 0,
            contextWindowSize: null,
            contextModel: null,
            contextLayers: [],
            contextPlan: null,
            lastSystemPrompt: "",
            lastSystemPromptKey: null,
            scopeAnchor: null,
            projectOutline: undefined,
            chapterOutlines: [],
          });
        }
        if (opts?.strict) throw error;
        return null;
      }
    }
    try {
      await tokenizerReady;
      markEnd("refreshContextLayers.ensureTokenizer");
      if (
        activeSessionId &&
        !(await chatApi.getSessionForProject(
          activeSessionId,
          sceneAuthority!.projectId,
        ))
      ) {
        throw new Error("chat session project mismatch");
      }
      const [sceneCtx, projectCtx] = await Promise.all([
        fetchSceneContext(effectiveSceneId, sceneAuthority!.projectId),
        fetchRequiredProjectContext(sceneAuthority!.projectId),
      ]);
      if (!sceneCtx) {
        throw new Error("required scene context is unavailable");
      }

      const ctxResult = await buildSceneContextPrompt({
        purpose: opts?.purpose ?? "live",
        authority: sceneAuthority!,
        sceneCtx,
        projectCtx,
        activeSessionId,
        conversationMessages: sceneConversationMessages,
        commandInstruction: opts?.commandInstruction,
        mentionedSceneIds: opts?.mentionedSceneIds,
        mentionedCodexIds: opts?.mentionedCodexIds,
        semanticRecallSeedMessage: opts?.outgoingUserMessage,
      });

      if (refreshAuthorityIsCurrent()) {
        set({
          contextTokenCount: ctxResult.totalTokens,
          contextWindowSize: refreshTurnRoute?.contextWindow ?? null,
          contextModel: refreshTurnRoute?.model ?? null,
          contextLayers: ctxResult.layers,
          contextPlan: ctxResult.contextPlan,
          lastSystemPrompt: ctxResult.prompt,
          lastSystemPromptKey: promptKey,
          detectedEntries: ctxResult.detectedEntries,
          alwaysEntries: ctxResult.alwaysEntries,
          scopeAnchor: null,
          projectOutline: ctxResult.projectOutline,
          chapterOutlines: ctxResult.chapterOutlines,
          pinsVersion: get().pinsVersion + 1,
        });
      }
      return ctxResult;
    } catch (error) {
      if (refreshAuthorityIsCurrent()) {
        set({
          contextTokenCount: 0,
          contextWindowSize: null,
          contextModel: null,
          contextLayers: [],
          contextPlan: null,
          lastSystemPrompt: "",
          lastSystemPromptKey: null,
        });
      }
      if (opts?.strict) throw error;
      return null;
    }
  },

  buildPreviewPrompt: async () => {
    const {
      activeSceneId,
      chatScope,
      threadFocusOverride,
      lastSystemPrompt,
      contextLayers,
      contextTokenCount,
    } = get();
    let draft: {
      markdown: string;
      mentionedSceneIds: string[];
      mentionedCodexIds: string[];
    } = {
      markdown: "",
      mentionedSceneIds: [],
      mentionedCodexIds: [],
    };
    try {
      draft = _inputDraftProvider?.() ?? draft;
    } catch {
      // provider getter が throw(エディタ teardown 中など)した場合は空ドラフトで継続。
    }
    // ライブ値フォールバック(RAG 非対象スコープ / 取得失敗時)。
    const live = {
      prompt: lastSystemPrompt,
      layers: contextLayers,
      totalTokens: contextTokenCount,
      userMessage: draft.markdown,
    };
    // semantic recall は scene スコープ限定。非 scene でも preview 固有の
    // immutable TurnRequest を作り、UI cache の stale prompt は使わない。
    const effectiveSceneId =
      chatScope === "scene" && !threadFocusOverride ? activeSceneId : null;
    if (!effectiveSceneId) {
      try {
        const previewMessages = [
          ...get().messages,
          ...(draft.markdown
            ? [
                {
                  id: "preview-outgoing",
                  sessionId: get().activeSessionId ?? "",
                  role: "user" as const,
                  content: draft.markdown,
                  createdAt: new Date().toISOString(),
                },
              ]
            : []),
        ];
        const refreshed = await get().refreshContextLayers({
          purpose: "preview",
          conversationMessages: previewMessages,
          outgoingUserMessage: draft.markdown,
          mentionedSceneIds: draft.mentionedSceneIds,
          mentionedCodexIds: draft.mentionedCodexIds,
          strict: true,
        });
        return {
          prompt: refreshed?.prompt ?? "",
          layers: refreshed?.layers ?? [],
          totalTokens: refreshed?.totalTokens ?? 0,
          userMessage: draft.markdown,
        };
      } catch {
        // refresh clears stale prompt state before rethrowing.
        return {
          prompt: "",
          layers: [],
          totalTokens: 0,
          userMessage: draft.markdown,
        };
      }
    }

    try {
      const built = await buildOutgoingScenePrompt(get, effectiveSceneId, {
        purpose: "preview",
        inputText: draft.markdown,
        mentionedSceneIds: draft.mentionedSceneIds,
        mentionedCodexIds: draft.mentionedCodexIds,
      });
      if (!built) return live;
      return {
        prompt: built.prompt,
        layers: built.layers,
        totalTokens: built.totalTokens,
        userMessage: draft.markdown,
      };
    } catch {
      return live;
    }
  },

  registerInputDraftProvider: (provider) => {
    _inputDraftProvider = provider;
  },

  setAgentMode: (on: boolean) => set({ agentMode: on }),

  continueAgentRun: async () => {
    const cont = get().agentContinuation;
    if (!cont || get().isStreaming) return;
    // 続行は別セッションへ切り替わっていたら無効（最新ターン専用）。
    if (cont.sessionId && cont.sessionId !== get().activeSessionId) {
      set({ agentContinuation: null });
      return;
    }
    set({ agentContinuation: null });
    const lang =
      (await fetchProjectContext(get().activeProjectId))?.language ?? "ja";
    const continuePrompt = getPromptCatalog(lang).agentControl.continuePrompt;
    // agent パスを強制（続行は常にエージェントターンの再開）。
    await get().sendMessage(continuePrompt, undefined, {
      overrideAgentMode: true,
    });
  },

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
    if (_activeSendControl) _activeSendControl.aborted = true;
    if (_resolveUserQuestion) {
      // 非自発的キャンセル（Stop / セッション切替 / error）の単一ファネル。
      // Promise を sentinel 解決するだけでは、再開したループが tool_result を
      // 積んで次ターンを発火し、別セッションへ stream を漏らす。ここで中断
      // フラグも立て、resolve で再開したループが shouldAbort を見て即 return
      // するようにする。自発的な Answer/dismiss は resolveUserQuestion 経由で
      // この関数を通らないため、フラグは立たずループは正常継続する。
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
    if (get().isStreaming) get().stopGeneration();
    // scope === "folder" / "codex" / "snippet" のとき anchorId 必須。空指定なら scene に fallback。
    // includeBodies は scope ごとのデフォルトに揃え直す: scene=true, それ以外=false。
    // project では本文集約しないので値自体は影響しないが false に揃える。
    // スコープ切替で非永続のスレッド focus はクリア（別スコープへ leak させない）。
    if (scope === "folder" || scope === "codex" || scope === "snippet") {
      if (!anchorId) {
        set({
          chatScope: "scene",
          scopeAnchorId: null,
          includeBodies: true,
          threadFocusOverride: null,
        });
        return;
      }
      set({
        chatScope: scope,
        scopeAnchorId: anchorId,
        includeBodies: false,
        threadFocusOverride: null,
      });
      return;
    }
    set({
      chatScope: scope,
      scopeAnchorId: null,
      includeBodies: scope === "scene",
      threadFocusOverride: null,
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
    const stoppedControl = _activeSendControl;
    const stoppedTurnId = _activeSendTurnId;
    const stoppedSessionId = stoppedControl?.sessionId ?? get().activeSessionId;
    const stoppedProjectId =
      stoppedControl?.projectId ??
      get().activeProjectId ??
      getCurrentProjectId();
    if (stoppedControl) {
      stoppedControl.aborted = true;
      if (!stoppedControl.transportStarted) {
        set((state) => ({
          messages: state.messages.filter(
            (message) =>
              message.id !== stoppedControl.userMessageId &&
              message.id !== stoppedControl.assistantMessageId,
          ),
        }));
      }
    }
    // Flush while this turn still owns the identity; flushDelta deliberately
    // rejects stale owners, so clearing the id first would drop the final frame.
    _flushPendingDelta?.();
    _flushPendingDelta = null;
    const agentTransportWillFinalize = Boolean(
      stoppedControl?.transportStarted && stoppedControl.surface === "agent",
    );
    if (stoppedControl?.transportStarted && stoppedControl.surface === "chat") {
      _finalizeStoppedStream?.();
    }
    if (!agentTransportWillFinalize) {
      _activeSendTurnId = null;
      _activeSendControl = null;
    }
    // Stop は送信開始時に凍結した transport を使う。Codex App Server は
    // subprocess 全体を終了せず、対象 Thread/Turn だけを interrupt する。
    const stoppedTransport =
      stoppedControl?.transport ?? _activeTurnRoute?.transport ?? "http";
    if (
      stoppedTransport === "codex-app-server" &&
      stoppedTurnId &&
      stoppedSessionId
    ) {
      void codexAppApi
        .abortCodexAppTurn({
          projectId: stoppedProjectId,
          sessionId: stoppedSessionId,
          grimodexTurnId: stoppedTurnId,
        })
        .catch(() => {});
    } else if (stoppedTransport === "cli-exec") {
      void cliApi.abortCliChatStream().catch(() => {});
    } else {
      void chatApi.abortChatStream().catch(() => {});
    }
    if (!agentTransportWillFinalize) {
      _streamCleanup?.();
      _streamCleanup = null;
    }
    get()._cancelPendingUserQuestion();
    set({
      isStreaming: agentTransportWillFinalize,
      agentProgress: null,
    });
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
    set({ messages: messages.slice(0, idx) });
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

  clearMessages: () => {
    if (get().isStreaming) return;
    set({ messages: [], agentContinuation: null });
  },
  clearError: () => set({ error: null }),
  dismissChatRecallPromote: (messageId: string) => {
    dismissRecallPromote(recallPromoteTracker, messageId);
    if (get().chatRecallPromoteSuggestion?.messageId === messageId) {
      set({ chatRecallPromoteSuggestion: null });
    }
  },
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
          if (get().isStreaming) get().stopGeneration();
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
  setActiveProjectId: (id: string | null) => {
    if (get().activeProjectId !== id && get().isStreaming) {
      get().stopGeneration();
    }
    set({ activeProjectId: id });
  },
}));

// Snippet 削除 → snippet スコープを scene へ戻す。snippetStore からの直接 import は
// module graph 汚染になるため leaf DI (anchorNotify) 経由で受ける。
setSnippetDeletedHandler((id) =>
  useChatStore.getState().onSnippetAnchorDeleted(id),
);
