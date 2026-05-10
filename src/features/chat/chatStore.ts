import { create } from "zustand";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
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
} from "./contextBuilder";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { runAgentLoop } from "./agent/agentLoop";
import { executeTool } from "./agent/toolExecutors";
import { AGENT_TOOLS } from "./agent/toolDefinitions";
import {
  getToolTokenBudget,
  buildThinkingParams,
  getEffortForTask,
  resolveModelCapabilities,
} from "./agent/modelLimits";
import { useAiSettingsStore } from "./store";
import * as cliApi from "./cliApi";

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
} from "./agent/agentTypes";
import { useTreeStore } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { loadSceneContent, getNode } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { getProject } from "@/features/project/api";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { listCodexEntries } from "@/features/codex/api";
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
} from "./summarization";
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
import { listPinnedSnippetEntries } from "./chatApi";
import type { PinnedSnippetContext } from "./contextBuilder";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { buildPendingBeatsSection } from "@/features/editor/beat/pendingBeatsContext";
import { getPromptCatalog } from "@/prompts/index";

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
 * codex_entries.tags_cache (JSON 配列) を string[] に展開する。
 * Spotlight エントリにのみ詰めて注入する想定。auto-detected には含めない
 * （L4 の render 側で `pinnedIds.has()` ゲートにより無害化されるが、
 * 不要なデータ流通を避ける目的でも builder 側で分岐する）。
 */
function parseTags(json: string | null | undefined): string[] | undefined {
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

  // Messages & streaming
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  activeSceneId: string;
  activeProjectId: string | null;
  contextTokenCount: number;
  contextLayers: LayerBreakdown[];
  lastSystemPrompt: string;

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

  // Global chat (project scope, no scene context)
  isGlobalChat: boolean;
  setIsGlobalChat: (on: boolean) => void;

  // Existing actions
  sendMessage: (content: string, commandInstruction?: string) => Promise<void>;
  buildPromptForCopy: (userInput: string) => Promise<string>;
  stopGeneration: () => void;
  deleteMessage: (messageId: string) => Promise<void>;
  editUserMessage: (messageId: string) => string;
  regenerate: (assistantMessageId: string) => Promise<void>;
  refreshContextLayers: () => Promise<void>;
  clearMessages: () => void;
  clearError: () => void;
  setActiveSceneId: (id: string) => void;
  setActiveProjectId: (id: string | null) => void;
  /** G17: スターのトグル（要約対象外フラグ） */
  starMessage: (messageId: string, starred: boolean) => Promise<void>;
  /** G20: stores old message content when editing, to detect removed @mentions */
  _editingOldContent: string | null;
  /** autoリストから特定エントリを即時除去（ピン直後のBug#1修正用） */
  removeEntryFromAuto: (entryId: string) => void;

  /** C: エディタの「チャットで調べる」が pre-fill するテキスト（consumed-once） */
  pendingLookupText: string | null;
  setPendingLookupText: (text: string | null) => void;
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
      contentJson: content ?? undefined,
    };
  } catch {
    return null;
  }
}

async function fetchProjectContext(
  projectId: string | null,
): Promise<ProjectContext | null> {
  const effectiveId = projectId ?? useTreeStore.getState().projectId;
  if (!effectiveId) return null;
  try {
    const project = await getProject(effectiveId);
    if (!project) return null;
    return {
      title: project.title,
      genre: project.genre,
      pov: project.pov,
      tense: project.tense,
      styleGuide: project.styleGuide,
      aiInstructions: project.aiInstructions,
      language: project.language,
    };
  } catch {
    return null;
  }
}

// Module-level cleanup function for the active stream
let _streamCleanup: (() => void) | null = null;
// Debounce timer for refreshContextLayers when input-detected entry IDs change.
// Token counting (WASM tiktoken) は同期で長文 scene でも数百 ms。打鍵が落ち着いてから走らせる。
let _inputPinnedRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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
  const allEntries = opts.prefetchedEntries ?? (await listCodexEntries());

  const aiSettings = useAiSettingsStore.getState().settings;
  const chatModel = aiSettings?.model ?? "";
  const { contextWindow, maxOutputTokens } = resolveModelCapabilities(
    chatModel,
    aiSettings,
  );
  const budgets = allocateLayerBudgets(contextWindow, { maxOutputTokens });
  const L4_TOTAL_BUDGET = budgets.l4;

  // G12: context_mode filter
  const detectableEntries = allEntries.filter(
    (e) => e.contextMode !== "hidden" && e.contextMode !== "suppress",
  );
  const alwaysEntries = allEntries.filter((e) => e.contextMode === "always");

  markStart("buildSceneCtx.findMentionedEntriesAsync");
  const mentioned = await findMentionedEntriesAsync(
    sceneCtx.content,
    detectableEntries,
  );
  markEnd("buildSceneCtx.findMentionedEntriesAsync");

  const mentionedIds = new Set(mentioned.map((e) => e.id));
  const alwaysNotMentioned = alwaysEntries.filter(
    (e) => !mentionedIds.has(e.id),
  );
  const rawCodexEntries = [...mentioned, ...alwaysNotMentioned];

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
  const alwaysNotPinned = alwaysEntries.filter(
    (e) => !pinnedIdSet.has(e.id) && !mentionedIds.has(e.id),
  );

  // Story so far
  const allNodes = useTreeStore.getState().nodes;
  markStart("buildSceneCtx.buildStorySoFar");
  const storySoFar = buildStorySoFar(sceneCtx.id, allNodes, budgets.l2);
  markEnd("buildSceneCtx.buildStorySoFar");

  // G11: previousScene
  const currentScene = allNodes.find((n) => n.id === sceneCtx.id);
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

  // G16: pinned snippets
  let pinnedSnippets: PinnedSnippetContext[] = [];
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
  }

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
      const snippet = await getSnippet(activeTab.nodeId).catch(() => undefined);
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
      });
    } catch {
      // 無視
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
    activeTabContent,
    commandInstruction,
    conversationTokens,
    contextWindow,
    maxOutputTokens,
    conversationSummary,
    pendingBeatsSection,
    lang: projectCtx?.language ?? "ja",
    agentMode: opts.agentMode,
  });
  markEnd("buildSceneCtx.buildSystemPrompt");

  return {
    prompt: promptResult.prompt,
    totalTokens: promptResult.totalTokens,
    layers: promptResult.layers,
    detectedEntries: detectedNotPinned,
    alwaysEntries: alwaysNotPinned,
    fullyInjectedIds: pinnedCodexEntries.map((e) => e.id),
  };
}

export const useChatStore = create<ChatState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoadingSessions: false,
  messages: [],
  isStreaming: false,
  error: null,
  activeSceneId: "",
  activeProjectId: null,
  contextTokenCount: 0,
  contextLayers: [],
  lastSystemPrompt: "",
  detectedEntries: [],
  alwaysEntries: [],
  inputPinnedEntryIds: [],
  agentMode: false,
  agentProgress: null,
  isGlobalChat: false,
  _editingOldContent: null,
  pendingLookupText: null,

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
    if (sessionId === null) {
      set({ activeSessionId: null, messages: [] });
      return;
    }
    try {
      const messages = await chatApi.listMessages(sessionId);
      set({ activeSessionId: sessionId, messages });
    } catch (e) {
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
      }));
    } catch (e) {
      toast.error(i18next.t("chat.createSessionFailed"));
      debugLog.error("ChatStore", "createNewSession", errorDetail(e));
    }
  },

  ensureSession: async () => {
    const { activeSessionId, activeProjectId, activeSceneId, isGlobalChat } =
      get();
    if (activeSessionId) return activeSessionId;
    const effectiveNodeId = isGlobalChat
      ? undefined
      : (activeSceneId ?? undefined);
    try {
      const session = await chatApi.createSession(
        activeProjectId ?? "default-project",
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

  buildPromptForCopy: async (userInput: string): Promise<string> => {
    await ensureTokenizer();
    const {
      activeSceneId,
      activeProjectId,
      activeSessionId,
      isGlobalChat,
      agentMode,
      messages: prevMessages,
      inputPinnedEntryIds,
    } = get();
    const effectiveSceneId = isGlobalChat ? null : activeSceneId;

    const parts: string[] = [];
    let contextLoaded = false;

    try {
      const [sceneCtx, projectCtx] = await Promise.all([
        effectiveSceneId ? fetchSceneContext(effectiveSceneId) : null,
        fetchProjectContext(activeProjectId),
      ]);

      if (sceneCtx || projectCtx) {
        // Agent モードでも通常モードと同じコンテキスト（L1〜L4）を組む。
        // 違いは送信時に AGENT_TOOLS が付くかどうかだけで、system prompt は共通。
        if (sceneCtx) {
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
          });
          parts.push(`[system]\n${prompt}`);
        } else if (projectCtx) {
          // Global chat: project context only (no scene)
          const { prompt } = buildSystemPrompt({
            scene: { id: "", title: "", content: "" },
            project: projectCtx,
            lang: projectCtx.language ?? "ja",
            agentMode,
          });
          parts.push(`[system]\n${prompt}`);
        }
        contextLoaded = true;
      }
    } catch (e) {
      console.error("[buildPromptForCopy] context fetch failed:", e);
    }

    // シーン/プロジェクトコンテキストが取得できなかった場合は
    // refreshContextLayers が計算済みの lastSystemPrompt をフォールバックとして使用
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

  sendMessage: async (content: string, commandInstruction?: string) => {
    const {
      isStreaming,
      activeSceneId,
      activeProjectId,
      activeSessionId,
      isGlobalChat,
    } = get();
    if (isStreaming) return;
    await ensureTokenizer();
    if (!content.trim()) return;
    const effectiveSceneId = isGlobalChat ? null : activeSceneId;

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
      error: null,
    });

    // -----------------------------------------------------------------------
    // セッションが未作成の場合は自動作成 (P0-2)
    // -----------------------------------------------------------------------
    let sessionIdForPersist = activeSessionId;
    if (!sessionIdForPersist) {
      const effectiveNodeId = isGlobalChat
        ? undefined
        : (effectiveSceneId ?? undefined);
      try {
        const session = await chatApi.createSession(
          activeProjectId ?? "default-project",
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
    if (get().agentMode) {
      try {
        const sceneCtx = effectiveSceneId
          ? await fetchSceneContext(effectiveSceneId)
          : null;
        const projectCtx = await fetchProjectContext(activeProjectId);

        // 通常モードと同じく、@言及/CodexHighlight 経由でメッセージ内に検出された
        // Codex エントリを送信時に自動 Spotlight する。
        // listCodexEntries の結果は buildSceneContextPrompt に prefetchedEntries
        // として渡し、二重 fetch を避ける。
        const allEntriesForCtx = sceneCtx ? await listCodexEntries() : [];
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

        const agentMsgs: AgentMessagePayload[] = [];
        let systemPromptForAgent = "";
        // Spotlight された (= L4 に full body + custom details + aliases が
        // 揃って注入された) エントリの ID 集合。`get_codex_entry` が
        // この集合の ID で呼ばれた場合は executor を呼ばずスタブを返す
        // (LLM はプロンプト指示に従わず再 fetch しがちなため)。
        let fullyInjectedIds: Set<string> = new Set();
        if (sceneCtx) {
          const messagesForCtx: ChatMessage[] = [
            ...prevMessages.filter((m) => !m.isSummarized),
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
          });
          systemPromptForAgent = ctxResult.prompt;
          fullyInjectedIds = new Set(ctxResult.fullyInjectedIds);
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
          await get().refreshContextLayers();
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
            agentMsgs.push({ role: "assistant", content: msg.content });
          }
        }
        agentMsgs.push({ role: "user", content });

        // Token budget + thinking params
        const aiSettings = useAiSettingsStore.getState().settings;
        const currentModel = aiSettings?.model ?? "";
        const tokenBudget = getToolTokenBudget(currentModel);
        const agentThinkingParams = buildThinkingParams(
          currentModel,
          getEffortForTask("agent"),
          "summarized",
          aiSettings?.thinkingEnabled ?? true,
        );

        // Accumulate tool calls for live metadata update
        const accToolCalls: ToolCallRecord[] = [];

        // 短絡: get_codex_entry が「事前に full body + custom details +
        // aliases が注入されているエントリ」に対して呼ばれた場合は、
        // executor (DB アクセス) を呼ばずスタブを返す。LLM はプロンプト
        // 指示に従わず再 fetch しがちなため、ランタイム側で受け止める。
        const guardedExecuteTool: typeof executeTool = async (
          name,
          toolCallId,
          params,
        ) => {
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

        const agentControl = getPromptCatalog(
          projectCtx?.language ?? "ja",
        ).agentControl;
        const { toolCallRecords, finalThinkingBlocks } = await runAgentLoop({
          messages: agentMsgs,
          tools: AGENT_TOOLS,
          tokenBudget,
          callLimitMessage: agentControl.callLimitMessage,
          tokenBudgetMessage: agentControl.tokenBudgetMessage,
          sendToLLM: (msgs, tools) =>
            chatApi.sendAgentMessage(msgs, tools, agentThinkingParams),
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

        // Persist
        if (sessionIdForPersist) {
          await chatApi.addMessage(sessionIdForPersist, "user", content, {
            id: userMsg.id,
          });
          const finalMessages = get().messages;
          const lastMsg = finalMessages[finalMessages.length - 1];
          if (lastMsg?.role === "assistant" && lastMsg.content) {
            await chatApi.addMessage(
              sessionIdForPersist,
              "assistant",
              lastMsg.content,
              {
                id: assistantMsg.id,
                metadata: JSON.stringify({
                  tool_calls: toolCallRecords,
                  ...(finalThinkingBlocks.length > 0
                    ? { thinking_blocks: finalThinkingBlocks }
                    : {}),
                }),
              },
            );

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
        set({ isStreaming: false, agentProgress: null });
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

      // G17: 要約トリガーチェック
      let currentMessages = get().messages;
      if (sessionIdForPersist && shouldSummarize(prevMessages)) {
        try {
          const candidates = selectSummarizationCandidates(prevMessages);
          if (candidates.length > 0) {
            const summaryText = await runSummarization(
              candidates,
              chatApi.sendChatMessageWithThinking,
              projectCtx?.language ?? "ja",
            );
            const candidateIds = candidates.map((m) => m.id);
            const chatSummary = await chatApi.addSummary(
              sessionIdForPersist,
              summaryText,
              candidateIds,
            );
            await chatApi.markMessagesSummarized(candidateIds);
            // Update in-memory state: mark candidates as summarized, inject summary into messages
            set((s) => {
              const updatedMessages = s.messages.map((m) =>
                candidateIds.includes(m.id) ? { ...m, isSummarized: 1 } : m,
              );
              const summaryMarkerMsg: ChatMessage = {
                id: `summary-${chatSummary.id}`,
                sessionId: sessionIdForPersist ?? "",
                role: "assistant",
                content: summaryText,
                metadata: JSON.stringify({ summary_id: chatSummary.id }),
                createdAt: chatSummary.createdAt,
                isSummarized: 0,
              };
              // Insert summary marker after the last summarized message
              const lastCandidateIdx = updatedMessages.reduce(
                (acc, m, idx) => (candidateIds.includes(m.id) ? idx : acc),
                -1,
              );
              const withSummary = [
                ...updatedMessages.slice(0, lastCandidateIdx + 1),
                summaryMarkerMsg,
                ...updatedMessages.slice(lastCandidateIdx + 1),
              ];
              return { messages: withSummary };
            });
            currentMessages = get().messages;
          }
        } catch (e) {
          debugLog.error("ChatStore", "summarization", errorDetail(e));
          // 要約失敗は警告のみ、チャットは続行
        }
      }

      // G17: 要約済みメッセージを除外（starred は保持）し、APIペイロードを構築
      const messagesForApi: ChatMessage[] = [
        ...currentMessages.filter(
          (m) =>
            m.id !== userMsg.id && m.id !== assistantMsg.id && !m.isSummarized,
        ),
        userMsg,
      ];

      if (sceneCtx) {
        const allEntries = await listCodexEntries();

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
        });

        set({
          contextTokenCount: ctxResult.totalTokens,
          contextLayers: ctxResult.layers,
          lastSystemPrompt: ctxResult.prompt,
          detectedEntries: ctxResult.detectedEntries,
          alwaysEntries: ctxResult.alwaysEntries,
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
        // refreshContextLayers が計算済みの lastSystemPrompt をシステムメッセージとして注入
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

      const aiSettings = useAiSettingsStore.getState().settings;
      const chatModel = aiSettings?.model ?? "";
      const chatThinkingParams = buildThinkingParams(
        chatModel,
        getEffortForTask("chat"),
        "summarized",
        aiSettings?.thinkingEnabled ?? true,
      );
      const apiPayload = messagesForApi.map((m) => ({
        role: m.role,
        content: m.content,
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
      const cliConfig = aiSettings?.cli;

      // Start streaming — returns a Promise<cleanup_fn>
      await new Promise<void>((resolve, reject) => {
        const callbacks = {
          onTextDelta: (delta: string) => {
            set((s) => {
              const msgs = [...s.messages];
              const idx = msgs.findIndex((m) => m.id === assistantMsg.id);
              if (idx >= 0) {
                msgs[idx] = {
                  ...msgs[idx],
                  content: msgs[idx].content + delta,
                };
              }
              return { messages: msgs };
            });
          },
          onThinkingDelta: (delta: string) => {
            thinkingAccumulator += delta;
          },
          onDone: (info: {
            stopReason: string;
            inputTokens?: number;
            outputTokens?: number;
          }) => {
            const chatDurationMs = Math.round(
              performance.now() - chatStartTime,
            );

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
              await chatApi.addMessage(sessionIdForPersist, "user", content, {
                id: userMsg.id,
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
            _streamCleanup?.();
            _streamCleanup = null;
            reject(new Error(message));
          },
        };

        const streamPromise =
          isCliProvider && cliConfig
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

  refreshContextLayers: async () => {
    markStart("refreshContextLayers.ensureTokenizer");
    await ensureTokenizer();
    markEnd("refreshContextLayers.ensureTokenizer");
    const { activeSceneId, activeProjectId, activeSessionId, isGlobalChat } =
      get();
    const effectiveSceneId = isGlobalChat ? null : activeSceneId;
    if (!effectiveSceneId) {
      // グローバルチャット: L1(project) + L4(pinned + always) のみ計算
      try {
        const [projectCtx, allEntries] = await Promise.all([
          fetchProjectContext(activeProjectId),
          listCodexEntries(),
        ]);

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
        const globalCodexEntries: CodexContext[] = alwaysNotPinned.map((e) => {
          const aliases = parseAliases(e.aliases);
          return {
            id: e.id,
            type: e.type,
            name: e.name,
            summary: e.summary ?? "",
            ...(aliases ? { aliases } : {}),
          };
        });

        const promptResult = buildSystemPrompt({
          scene: { id: "", title: "", content: "" },
          project: projectCtx ?? undefined,
          codexEntries:
            globalCodexEntries.length > 0 ? globalCodexEntries : undefined,
          pinnedCodexEntries:
            mergedGlobalPinnedCodex.length > 0
              ? mergedGlobalPinnedCodex
              : undefined,
          pinnedSnippets:
            globalPinnedSnippets.length > 0 ? globalPinnedSnippets : undefined,
          lang: projectCtx?.language ?? "ja",
          agentMode: get().agentMode,
        });

        set({
          contextTokenCount: promptResult.totalTokens,
          contextLayers: promptResult.layers,
          lastSystemPrompt: promptResult.prompt,
          detectedEntries: [],
          alwaysEntries: alwaysNotPinned,
        });
      } catch {
        set({ contextTokenCount: 0, contextLayers: [] });
      }
      return;
    }
    try {
      const [sceneCtx, projectCtx] = await Promise.all([
        fetchSceneContext(effectiveSceneId),
        fetchProjectContext(activeProjectId),
      ]);
      if (!sceneCtx) return;

      const ctxResult = await buildSceneContextPrompt({
        sceneCtx,
        projectCtx,
        activeSessionId,
        effectiveSceneId,
        inputPinnedEntryIds: get().inputPinnedEntryIds,
        conversationMessages: get().messages.filter((m) => !m.isSummarized),
        agentMode: get().agentMode,
      });

      set({
        contextTokenCount: ctxResult.totalTokens,
        contextLayers: ctxResult.layers,
        lastSystemPrompt: ctxResult.prompt,
        detectedEntries: ctxResult.detectedEntries,
        alwaysEntries: ctxResult.alwaysEntries,
      });
    } catch {
      // コンテキスト計算失敗は無視（送信時に再計算される）
    }
  },

  setAgentMode: (on: boolean) => set({ agentMode: on }),
  setIsGlobalChat: (on: boolean) => set({ isGlobalChat: on }),

  // --- P2-1: ストリーミング中断 ---
  stopGeneration: () => {
    // CLI subprocess と HTTP ベースのストリームは別系統なので、
    // 現在のプロバイダに合わせた abort を発火する。両方発火しても害は無いが、
    // CLI 用フラグはアプリ全体で 1 つしかないため不要な reset を避ける。
    const provider = useAiSettingsStore.getState().settings?.provider;
    if (provider === "cli") {
      void cliApi.abortCliChatStream().catch(() => {});
    } else {
      void chatApi.abortChatStream().catch(() => {});
    }
    _streamCleanup?.();
    _streamCleanup = null;
    set({ isStreaming: false, agentProgress: null });
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

  // --- G17: スターのトグル ---
  starMessage: async (messageId: string, starred: boolean) => {
    try {
      await chatApi.toggleStarMessage(messageId, starred);
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId ? { ...m, isStarred: starred ? 1 : 0 } : m,
        ),
      }));
    } catch (e) {
      toast.error(i18next.t("chat.starUpdateFailed"));
      debugLog.error("ChatStore", "starMessage", errorDetail(e));
    }
  },

  // --- P2-2: ユーザーメッセージ編集 (内容を返し、以降を削除) ---
  editUserMessage: (messageId: string) => {
    const { activeSessionId, messages } = get();
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return "";
    const content = messages[idx].content;
    const toDelete = messages.slice(idx).filter((m) => m.role !== "system");
    if (activeSessionId) {
      Promise.all(toDelete.map((m) => chatApi.deleteMessage(m.id))).catch((e) =>
        debugLog.error("ChatStore", "editUserMessage", errorDetail(e)),
      );
    }
    // G20: save old content to detect removed @mentions on re-send
    set({ messages: messages.slice(0, idx), _editingOldContent: content });
    return content;
  },

  // --- P2-2: AIメッセージ再生成 ---
  regenerate: async (assistantMessageId: string) => {
    const { messages, activeSessionId } = get();
    const assIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (assIdx === -1) return;

    // 直前のユーザーメッセージを探す
    const userMsg = [...messages]
      .slice(0, assIdx)
      .reverse()
      .find((m) => m.role === "user");
    if (!userMsg) return;

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
    await get().sendMessage(userMsg.content);
  },

  clearMessages: () => set({ messages: [] }),
  clearError: () => set({ error: null }),
  setActiveSceneId: (id: string) => {
    const { activeSceneId } = get();
    // シーンが実際に変わったときのみグローバルモードをOFF + セッションをクリア
    if (id !== activeSceneId) {
      set({
        activeSceneId: id,
        isGlobalChat: false,
        activeSessionId: null,
        messages: [],
      });
    } else {
      set({ activeSceneId: id });
    }
  },
  setActiveProjectId: (id: string | null) => set({ activeProjectId: id }),
}));
