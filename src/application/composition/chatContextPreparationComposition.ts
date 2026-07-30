import i18next from "@/lib/i18n";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { markEnd, markStart } from "@/lib/perfLog";
import { prosemirrorToText } from "@/lib/prosemirror";
import {
  type ChatContextPreparationInput,
  type ChatContextPreparationPort,
  type ChatContextPreparationAuthority,
  type ChatContextPreparationSnapshot,
  type ChatContextPreparationSnapshotInput,
  type PreparedChatContext,
} from "@/application/chat/chatContextPreparation";
import { createContextPlan } from "@/features/ai-context/types";
import {
  buildSystemPrompt,
  countTokens,
  ensureTokenizer,
  type BuildSystemPromptInput,
  type ProjectContext,
  type SceneContext,
} from "@/features/chat/contextBuilder";
import * as chatApi from "@/features/chat/chatApi";
import {
  fetchSemanticRecall,
  SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS,
} from "@/features/chat/semanticRecall";
import { fetchChatRecall } from "@/features/chat/chatRecall";
import { planChatContext } from "@/features/chat/context/chatContextPlanner";
import { createDefaultContextPlannerDeps } from "@/features/chat/context/defaultContextPlannerDeps";
import {
  createNonSceneContextPlannerDeps,
  planNonSceneChatContext,
} from "@/features/chat/context/nonSceneContextPlanner";
import {
  createNonSceneTurnContextRequest,
  createSceneTurnContextRequest,
  prepareTurn,
  type ContextScopeTarget,
  type NonSceneTurnContextRequest,
  type SceneTurnContextRequest,
} from "@/features/chat/context/prepareTurn";
import {
  collectSceneContext,
  createSceneContextSourceDeps,
  type SceneContextSourceDeps,
} from "@/features/chat/context/sources/sceneContextSource";
import {
  createNonSceneContextSourceDeps,
  type NonSceneContextSourceDeps,
} from "@/features/chat/context/sources/nonSceneContextSource";
import type { ChatContextPlan } from "@/features/chat/context/types";
import { fetchProjectContext as fetchProjectContextAtom } from "@/features/project/contextAtoms";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  getNode,
  loadSceneContent,
  loadSceneContents,
  loadScenesFull,
} from "@/features/tree/api";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import {
  listCodexContextMetadata,
  listCodexEntriesForContext,
  listCodexEntriesForContextByIds,
  type CodexContextEntry,
} from "@/features/codex/api";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import {
  listContextDetailsByEntryIds,
  listRawDetailValuesByEntryIds,
} from "@/features/codex/detailApi";
import {
  listDetailOverridesByPhaseIds,
  listPhasesByEntryIds,
} from "@/features/codex/phaseApi";
import { usePhaseStore } from "@/features/codex/phaseStore";
import {
  computeGlobalSceneOrder,
  type PhaseResolutionMode,
  type SceneTimeIndex,
} from "@/features/codex/phaseResolver";
import { listCodexRelations } from "@/features/codex/codexRelationApi";
import { getSnippet } from "@/features/snippets/api";
import { useTabStore } from "@/features/editor/tabStore";
import {
  useUnplacedBeatsStore,
  type UnplacedBeat,
} from "@/features/editor/beat/unplacedBeatsStore";
import { buildPendingBeatsSection } from "@/features/editor/beat/pendingBeatsContext";
import { useMapStore } from "@/features/map/mapStore";
import {
  getMapBoard,
  listAiBranches as listMapAiBranches,
  listFrames as listMapFrames,
  listNodePositions as listMapNodePositions,
  listStickies as listMapStickies,
  listUserEdges as listMapUserEdges,
} from "@/features/map/mapApi";
import {
  buildMapContextMarkdown,
  type ResolvedLabel,
} from "@/features/map/mapToContextPrompt";
import {
  getProjectCalendar,
  listEventParticipantsForProject,
  listEventRelations,
  listEvents,
  listSceneEventsForProject,
} from "@/features/chronicle/api";
import { assembleChronicleSnapshotText } from "@/features/chronicle/chronicleSnapshot";
import type { SceneChronicle } from "@/features/chronicle/resolveSceneAnchor";
import { calendarFromRow } from "@/features/chronicle/chronicleTime";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import {
  PLOT_PHASE_TYPES,
  type EventPrecision,
  type PlotPhaseType,
} from "@/db/schema";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { computeSceneThreadContext } from "@/features/plot-threads/sceneThreadTracks";
import {
  getSceneForeshadowContext,
  listOpenForeshadowsForContext,
} from "@/features/foreshadow/api";
import { listNodeLabels } from "@/features/labels/labelApi";
import { getPromptCatalog } from "@/prompts/index";

const PLOT_THREAD_MAX_MARKERS = 24;

interface CapturedSceneContext {
  request: Pick<SceneTurnContextRequest, "map" | "activeTab" | "settings">;
  sourceDeps: SceneContextSourceDeps;
}

interface CapturedNonSceneContext {
  scope: Exclude<ContextScopeTarget, { kind: "scene" }>;
  map: NonSceneTurnContextRequest["map"];
  activeTab: NonSceneTurnContextRequest["activeTab"];
  settings: NonSceneTurnContextRequest["settings"];
  sourceSnapshot: NonSceneTurnContextRequest["sourceSnapshot"];
  temporalResolution: {
    sceneTimeIndex: SceneTimeIndex;
    resolutionMode: PhaseResolutionMode;
  };
}

function authoritySnapshot(): ChatContextPreparationAuthority {
  return Object.freeze({
    chronicleRevision: useChronicleStore.getState().revisionCounter,
  });
}

function isAuthorityCurrent(
  authority: ChatContextPreparationAuthority,
): boolean {
  return (
    useChronicleStore.getState().revisionCounter === authority.chronicleRevision
  );
}

function emptyPlan(requestId: string): ChatContextPlan {
  return createContextPlan({
    requestId,
    items: [],
    decisions: [],
    usage: {
      candidateTokens: 0,
      selectedTokens: 0,
      trimmedTokens: 0,
      budgetTokens: null,
    },
  }) as ChatContextPlan;
}

function focusedContextTab(): SceneTurnContextRequest["activeTab"] {
  const tabState = useTabStore.getState();
  const tabs =
    tabState.activeGroupIndex === 1 ? tabState.secondaryTabs : tabState.tabs;
  const activeId =
    tabState.activeGroupIndex === 1
      ? tabState.secondaryActiveTabId
      : tabState.activeTabId;
  const active = tabs.find((tab) => tab.nodeId === activeId);
  return active?.contentType === "codex" || active?.contentType === "snippet"
    ? { nodeId: active.nodeId, contentType: active.contentType }
    : null;
}

function contextSettings(): SceneTurnContextRequest["settings"] {
  const settings = useSettingsStore.getState();
  return {
    injectBeats: settings.getBoolean("beat.injectIntoContext", true),
    chronicleEnabled: settings.getBoolean("aiPrompt.chronicle.enabled", true),
    semanticRecallEnabled: settings.getBoolean("ai.semanticRecall", true),
    episodicRecallEnabled: settings.getBoolean("ai.chatRecall", true),
    hybridRecallEnabled: settings.getBoolean("ai.hybridRecall", true),
    customChatInstruction: settings.get("aiPrompt.custom.chat", ""),
  };
}

function mapSelection(
  input: Pick<
    ChatContextPreparationSnapshotInput,
    "includeMapBoard" | "mapBoardId"
  >,
): SceneTurnContextRequest["map"] {
  return {
    enabled: input.includeMapBoard,
    boardId: input.mapBoardId,
    activeBoardId: useMapStore.getState().activeBoardId,
  };
}

function cloneTemporalResolution(): CapturedNonSceneContext["temporalResolution"] {
  const phaseState = usePhaseStore.getState();
  return {
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

async function fetchRequiredProjectContext(
  projectId: string,
): Promise<ProjectContext> {
  const project = await fetchProjectContextAtom(projectId);
  if (!project) {
    throw new Error("required project context is unavailable");
  }
  return project;
}

async function assertSessionProject(
  input: ChatContextPreparationInput,
): Promise<void> {
  if (
    input.sessionId &&
    !(await chatApi.getSessionForProject(input.sessionId, input.projectId))
  ) {
    throw new Error("chat session project mismatch");
  }
}

function buildPublicWebSearchSystemPrompt(input: {
  language: string;
  commandInstruction?: string;
  useHermes: boolean;
}): string {
  const control = getPromptCatalog(input.language).agentControl;
  const instruction = input.useHermes
    ? control.webSearchInstructionHermes
    : control.webSearchInstruction;
  const command = input.commandInstruction?.trim();
  return command ? `${command}\n\n${instruction}` : instruction;
}

async function preparePublicWebContext(
  input: ChatContextPreparationInput,
  authority: ChatContextPreparationAuthority,
): Promise<PreparedChatContext> {
  await ensureTokenizer();
  await assertSessionProject(input);
  const project = await fetchRequiredProjectContext(input.projectId);
  const prompt = buildPublicWebSearchSystemPrompt({
    language: project.language ?? "ja",
    commandInstruction: input.commandInstruction,
    useHermes: input.mode === "agent" && input.route?.toolProtocol === "hermes",
  });
  return {
    privacy: "public-web",
    prompt,
    totalTokens: countTokens(prompt),
    layers: [],
    contextPlan: emptyPlan(input.requestId),
    detectedEntries: [],
    alwaysEntries: [],
    fullyInjectedIds: [],
    stableContextIds: [],
    recalledMessages: [],
    scopeAnchor: null,
    projectOutline: undefined,
    chapterOutlines: [],
    authority,
  };
}

function scopeForInput(
  input: Pick<
    ChatContextPreparationSnapshotInput,
    "threadFocus" | "chatScope" | "scopeAnchorId"
  >,
): Exclude<ContextScopeTarget, { kind: "scene" }> {
  if (input.threadFocus) {
    return {
      kind: "thread",
      threadId: input.threadFocus.threadId,
      title: input.threadFocus.title,
    };
  }
  if (input.chatScope === "folder" && input.scopeAnchorId) {
    return { kind: "folder", folderId: input.scopeAnchorId };
  }
  if (input.chatScope === "project") return { kind: "project" };
  if (input.chatScope === "codex" && input.scopeAnchorId) {
    return { kind: "codex", entryId: input.scopeAnchorId };
  }
  if (input.chatScope === "snippet" && input.scopeAnchorId) {
    return { kind: "snippet", snippetId: input.scopeAnchorId };
  }
  return { kind: "global" };
}

function preparedSceneResult(
  result: Awaited<ReturnType<typeof planChatContext>>,
  authority: ChatContextPreparationAuthority,
): PreparedChatContext {
  return {
    privacy: "private",
    prompt: result.prompt,
    totalTokens: result.totalTokens,
    layers: result.layers,
    contextPlan: result.contextPlan,
    cacheSegments: result.cacheSegments,
    volatileTail: result.volatileTail,
    detectedEntries: result.detectedEntries,
    alwaysEntries: result.alwaysEntries,
    fullyInjectedIds: result.fullyInjectedIds,
    stableContextIds: result.stableCodexIds,
    recalledMessages: result.recalledMessages,
    scopeAnchor: null,
    projectOutline: result.projectOutline,
    chapterOutlines: result.chapterOutlines,
    authority,
  };
}

function preparedNonSceneResult(
  result: Awaited<ReturnType<typeof planNonSceneChatContext>>,
  authority: ChatContextPreparationAuthority,
): PreparedChatContext {
  return {
    privacy: "private",
    prompt: result.prompt,
    totalTokens: result.totalTokens,
    layers: result.layers,
    contextPlan: result.contextPlan,
    cacheSegments: result.cacheSegments,
    volatileTail: result.volatileTail,
    detectedEntries: result.detectedEntries,
    alwaysEntries: result.alwaysEntries,
    fullyInjectedIds: result.fullyInjectedIds,
    stableContextIds: result.stableContextIds,
    recalledMessages: [],
    scopeAnchor: result.scopeAnchor,
    projectOutline: result.projectOutline,
    chapterOutlines: result.chapterOutlines,
    authority,
  };
}

async function prepareCapturedScene(
  input: ChatContextPreparationInput,
  captured: CapturedSceneContext,
  authority: ChatContextPreparationAuthority,
): Promise<PreparedChatContext> {
  const sceneId = input.effectiveSceneId;
  if (!sceneId) throw new Error("scene context authority mismatch");
  await assertSessionProject(input);
  const [scene, project] = await Promise.all([
    fetchSceneContext(sceneId, input.projectId),
    fetchRequiredProjectContext(input.projectId),
  ]);
  if (!scene) throw new Error("required scene context is unavailable");

  const outgoing = input.outgoingUserMessage.trim();
  const latestUser = [...input.messages]
    .reverse()
    .find((message) => message.role === "user" && !message.isSummarized)
    ?.content.trim();
  const recallSeed =
    outgoing ||
    (input.allowSceneRecallSeedFallback
      ? latestUser || scene.content.slice(-SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS)
      : "");
  const request = createSceneTurnContextRequest({
    requestId: input.requestId,
    purpose: input.purpose,
    projectId: input.projectId,
    ...(input.workspaceIdentity
      ? { workspaceIdentity: { ...input.workspaceIdentity } }
      : {}),
    sessionId: input.sessionId,
    sceneId,
    mode: input.mode,
    route: input.route,
    budget: input.budget,
    messages: input.messages,
    outgoingUserMessage: recallSeed,
    commandInstruction: input.commandInstruction,
    mentionedSceneIds: input.mentionedSceneIds,
    mentionedCodexIds: input.mentionedCodexIds,
    inputPinnedEntryIds: input.inputPinnedEntryIds,
    excludedAutoEntryIds: input.excludedAutoEntryIds,
    sessionStableCodexIds: input.sessionStableCodexIds,
    sessionStableContextInitialized: input.sessionStableContextInitialized,
    includeBodies: input.includeBodies,
    map: captured.request.map,
    activeTab: captured.request.activeTab,
    settings: captured.request.settings,
    trackRecallPromote: input.trackRecallPromote,
    sourceSnapshot: { scene, project },
  });
  const result = await prepareTurn(
    request,
    {
      scene: createDefaultContextPlannerDeps({
        collectRequiredSceneContext: (sourceRequest) =>
          collectSceneContext(sourceRequest, captured.sourceDeps),
      }),
    },
    {
      planScene: planChatContext,
      planNonScene: planNonSceneChatContext,
    },
  );
  return preparedSceneResult(result, authority);
}

async function prepareCapturedNonScene(
  input: ChatContextPreparationInput,
  captured: CapturedNonSceneContext,
  authority: ChatContextPreparationAuthority,
): Promise<PreparedChatContext> {
  await assertSessionProject(input);
  const request = createNonSceneTurnContextRequest({
    requestId: input.requestId,
    purpose: input.purpose,
    projectId: input.projectId,
    sessionId: input.sessionId,
    mode: input.mode,
    route: input.route,
    budget: input.budget,
    messages: input.messages,
    outgoingUserMessage: input.outgoingUserMessage,
    commandInstruction: input.commandInstruction,
    mentionedSceneIds: input.mentionedSceneIds,
    mentionedCodexIds: input.mentionedCodexIds,
    inputPinnedEntryIds: input.inputPinnedEntryIds,
    excludedAutoEntryIds: input.excludedAutoEntryIds,
    sessionStableCodexIds: input.sessionStableCodexIds,
    sessionStableContextInitialized: input.sessionStableContextInitialized,
    includeBodies: input.includeBodies,
    map: captured.map,
    activeTab: captured.activeTab,
    settings: captured.settings,
    trackRecallPromote: input.trackRecallPromote,
    scope: captured.scope,
    containerScope: input.chatScope,
    scopeAnchorId: input.scopeAnchorId,
    activeSceneId: input.activeSceneId,
    activeProjectId: input.activeProjectId,
    agentToolsAvailable: input.agentToolsAvailable,
    sourceSnapshot: captured.sourceSnapshot,
  });
  const result = await prepareTurn(
    request,
    {
      nonScene: createNonSceneContextPlannerDeps({
        ensureTokenizer,
        renderPrompt: buildSystemPrompt,
        source: createProductionNonSceneSourceDeps(
          request,
          captured.temporalResolution,
        ),
      }),
    },
    {
      planScene: planChatContext,
      planNonScene: planNonSceneChatContext,
    },
  );
  return preparedNonSceneResult(result, authority);
}

async function loadMentionedScenes(
  ids: readonly string[],
  currentSceneId: string | null,
  treeNodes: readonly TreeNodeData[],
): Promise<Array<{ id: string; title: string; content: string }>> {
  if (ids.length === 0) return [];
  const nodesById = new Map(treeNodes.map((node) => [node.id, node]));
  const candidates: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (currentSceneId && id === currentSceneId) continue;
    const node = nodesById.get(id);
    if (!node || node.nodeType !== "scene") continue;
    candidates.push({ id, title: node.title });
  }
  const contents = await loadSceneContents(
    candidates.map((candidate) => candidate.id),
  ).catch(() => new Map<string, string>());
  return candidates.flatMap((candidate) => {
    const content = prosemirrorToText(contents.get(candidate.id) ?? "");
    return content ? [{ ...candidate, content }] : [];
  });
}

type AggregatedPrefacePolicy = "folder" | "project";

function buildChildrenByParentIndex(
  nodes: TreeNodeData[],
): Map<string | null, TreeNodeData[]> {
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const node of nodes) {
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => cmpKeys(left.sortOrder, right.sortOrder));
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
  const header = `--- ${scene.title}${
    scene.id === activeSceneId ? " [current edit]" : ""
  } ---`;
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
  const header = `--- ${scene.title}${
    scene.id === activeSceneId ? " [current edit]" : ""
  } ---`;
  const synopsis = scene.synopsis?.trim();
  const synopsisLine = synopsis ? `Synopsis: ${synopsis}\n\n` : "";
  return `${header}\n${synopsisLine}${body}`;
}

function formatTopLevelScenesSection(
  scenes: TreeNodeData[],
  activeSceneId: string | null,
): string {
  return `=== (top level) ===\n${scenes
    .map(
      (scene) =>
        `- ${scene.title}${
          scene.id === activeSceneId ? " [current edit]" : ""
        }`,
    )
    .join("\n")}`;
}

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
  const children = childrenByParent.get(parentId) ?? [];
  if (parentId === null && mode === "foldersOnly") {
    const topLevelScenes = children.filter((node) => node.nodeType === "scene");
    if (topLevelScenes.length > 0) {
      parts.push(formatTopLevelScenesSection(topLevelScenes, activeSceneId));
    }
  }

  for (const node of children) {
    if (node.nodeType === "scene") {
      if (mode === "foldersOnly") continue;
      parts.push(
        mode === "tier1"
          ? formatAggregatedSceneWithBody(
              node,
              (bodyBySceneId.get(node.id) ?? "").trim(),
              activeSceneId,
            )
          : formatAggregatedSceneSynopsis(
              node,
              activeSceneId,
              beatSectionBySceneId.get(node.id),
            ),
      );
      continue;
    }
    if (node.nodeType !== "folder" || guard.has(node.id)) continue;
    guard.add(node.id);
    parts.push(formatAggregatedFolderSection(node));
    appendProjectGroupedParts(
      node.id,
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

async function buildAggregatedScene(input: {
  anchorId: string;
  anchorTitle: string;
  descendants: TreeNodeData[];
  includeBodies: boolean;
  activeSceneId: string | null;
  prefacePolicy: AggregatedPrefacePolicy;
  allEntries: CodexContextEntry[];
  detectableEntries?: CodexContextEntry[];
  allNodes?: TreeNodeData[];
  injectBeats: boolean;
  agentMode: boolean;
}): Promise<{
  aggregatedScene: { id: string; title: string; content: string };
  aggregatedDetected: CodexContextEntry[];
} | null> {
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
    injectBeats,
    agentMode,
  } = input;
  const isProjectGrouped = prefacePolicy === "project" && !!allNodes?.length;
  const hasScenes = descendants.length > 0;
  if (!hasScenes && !isProjectGrouped) return null;

  const totalChars = descendants.reduce(
    (sum, scene) => sum + (scene.charCount ?? 0),
    0,
  );
  const agentPullProject = agentMode && isProjectGrouped;
  const canTier1 =
    hasScenes &&
    includeBodies &&
    descendants.length <= 30 &&
    totalChars <= 100_000;
  const canTier2 = hasScenes && descendants.length <= 200 && !agentPullProject;
  const tier1Preface =
    prefacePolicy === "folder"
      ? `[この章「${anchorTitle}」配下のシーンを reading order (sortOrder) で集約しています。各シーンは「--- {タイトル} ---」区切りで列挙され、Synopsis 行があるシーンはその要約、[current edit] マーカー付きが現在編集中のシーンです]`
      : `[このプロジェクト「${anchorTitle}」の全シーンをフォルダ階層（=== フォルダ名 ===）ごとに集約しています。フォルダ見出しの Outline は各フォルダの synopsis、配下シーンは「--- {タイトル} ---」区切りで reading order に並び、[current edit] マーカー付きが現在編集中のシーンです]`;
  const tier2BodyNote = includeBodies
    ? "シーン数または総文字数が本文集約の上限を超えたため、本文は注入されていません"
    : "eco モード: 本文は注入されていません";
  const tier2Preface =
    prefacePolicy === "folder"
      ? `[この章「${anchorTitle}」配下のシーンを synopsis 単位で集約しています（${tier2BodyNote}）。各シーンは「--- {タイトル} ---」区切りで reading order に並んでおり、[current edit] マーカー付きが現在編集中のシーンです]`
      : `[このプロジェクト「${anchorTitle}」の全シーンをフォルダ階層（=== フォルダ名 ===）ごとに synopsis 単位で集約しています（${tier2BodyNote}）。フォルダ見出しの Outline は各フォルダの synopsis、配下シーンは「--- {タイトル} ---」区切りです]`;
  const tier3ProjectPreface = agentPullProject
    ? `[このプロジェクト「${anchorTitle}」のフォルダ階層 Outline（=== フォルダ名 ===）のみを事前注入しています。個別シーンの synopsis / 本文はトークン節約のため事前注入していません。必要に応じて get_chapter_summaries（全シーンのあらすじ一覧）、list_chapters（章・シーン構成）、search_scenes（本文横断検索）、get_scene（個別シーンの本文）で取得してください]`
    : descendants.length === 0
      ? `[このプロジェクト「${anchorTitle}」のフォルダ階層の Outline（=== フォルダ名 ===）を注入しています。シーンはまだ作成されていません]`
      : `[このプロジェクト「${anchorTitle}」はシーン数が多いため、フォルダ階層の Outline のみを注入しています（=== フォルダ名 ===）。個別シーンの synopsis / 本文は省略されています]`;

  const detectFromJoined = async (
    joined: string,
  ): Promise<CodexContextEntry[]> => {
    try {
      const detectable = (detectableEntries ?? allEntries).filter(
        (entry) =>
          entry.contextMode !== "hidden" && entry.contextMode !== "suppress",
      );
      const matched = await findMentionedEntriesAsync(joined, detectable);
      const matchedIds = new Set(matched.map((entry) => entry.id));
      return detectable.filter((entry) => matchedIds.has(entry.id));
    } catch {
      return [];
    }
  };

  const buildProjectParts = (
    mode: "tier1" | "tier2" | "foldersOnly",
    bodyBySceneId: Map<string, string>,
    beatSectionBySceneId: Map<string, string>,
  ): string[] => {
    const parts: string[] = [];
    appendProjectGroupedParts(
      null,
      buildChildrenByParentIndex(allNodes!),
      new Set(),
      parts,
      mode,
      activeSceneId,
      bodyBySceneId,
      beatSectionBySceneId,
    );
    return parts;
  };

  if (canTier1) {
    const rawBodies = await loadSceneContents(
      descendants.map((scene) => scene.id),
    ).catch((cause) => {
      debugLog.warn(
        "ChatContextPreparation",
        "loadSceneContents failed in aggregate",
        errorDetail(cause),
      );
      return new Map<string, string>();
    });
    const bodyBySceneId = new Map(
      descendants.map((scene) => [
        scene.id,
        prosemirrorToText(rawBodies.get(scene.id) ?? ""),
      ]),
    );
    const parts = isProjectGrouped
      ? buildProjectParts("tier1", bodyBySceneId, new Map())
      : descendants.map((scene) =>
          formatAggregatedSceneWithBody(
            scene,
            (bodyBySceneId.get(scene.id) ?? "").trim(),
            activeSceneId,
          ),
        );
    if (parts.length === 0) return null;
    const joined = `${tier1Preface}\n\n${parts.join("\n\n")}`;
    return {
      aggregatedScene: { id: anchorId, title: anchorTitle, content: joined },
      aggregatedDetected: await detectFromJoined(joined),
    };
  }

  if (canTier2) {
    const beatSectionBySceneId = new Map<string, string>();
    if (injectBeats && descendants.length > 0) {
      const loaded = await loadScenesFull(
        descendants.map((scene) => scene.id),
      ).catch(
        () => new Map<string, { content: string; unplacedBeatsDoc: string }>(),
      );
      const resolveCharacterName = (id: string): string | null =>
        allEntries.find((entry) => entry.id === id)?.name ?? null;
      for (const scene of descendants) {
        const { content, unplacedBeatsDoc } = loaded.get(scene.id) ?? {
          content: "",
          unplacedBeatsDoc: "[]",
        };
        const sceneDocument: unknown = (() => {
          try {
            return content ? JSON.parse(content) : null;
          } catch {
            return null;
          }
        })();
        let unplacedBeats: UnplacedBeat[] = [];
        try {
          const parsed: unknown = JSON.parse(unplacedBeatsDoc);
          if (Array.isArray(parsed)) {
            unplacedBeats = parsed as UnplacedBeat[];
          }
        } catch {
          unplacedBeats = [];
        }
        const section = buildPendingBeatsSection({
          sceneDocJson: sceneDocument,
          unplacedBeats,
          resolveCharacterName,
          currentBeatId: null,
          scenePovCharacterId: scene.povCharacterId ?? null,
        });
        if (section) beatSectionBySceneId.set(scene.id, section);
      }
    }
    const parts = isProjectGrouped
      ? buildProjectParts("tier2", new Map(), beatSectionBySceneId)
      : descendants.map((scene) =>
          formatAggregatedSceneSynopsis(
            scene,
            activeSceneId,
            beatSectionBySceneId.get(scene.id),
          ),
        );
    if (parts.length === 0) return null;
    const joined = `${tier2Preface}\n\n${parts.join("\n\n")}`;
    return {
      aggregatedScene: { id: anchorId, title: anchorTitle, content: joined },
      aggregatedDetected: await detectFromJoined(joined),
    };
  }

  if (!isProjectGrouped) return null;
  const parts = buildProjectParts("foldersOnly", new Map(), new Map());
  if (parts.length === 0) return null;
  const joined = `${tier3ProjectPreface}\n\n${parts.join("\n\n")}`;
  return {
    aggregatedScene: { id: anchorId, title: anchorTitle, content: joined },
    aggregatedDetected: await detectFromJoined(joined),
  };
}

async function loadMapBoardMarkdown(
  allEntries: Array<Pick<CodexContextEntry, "id" | "name">>,
  selection: {
    enabled: boolean;
    boardId: string | null;
    activeBoardId: string | null;
    projectId: string;
    treeNodes: readonly TreeNodeData[];
  },
): Promise<string | undefined> {
  if (!selection.enabled) return undefined;
  const boardId = selection.boardId ?? selection.activeBoardId;
  if (!boardId) return undefined;
  try {
    const [board, stickies, edges, frames, positions, aiBranches] =
      await Promise.all([
        getMapBoard(boardId),
        listMapStickies(boardId),
        listMapUserEdges(boardId),
        listMapFrames(boardId),
        listMapNodePositions(boardId),
        listMapAiBranches(boardId),
      ]);
    if (!board || board.projectId !== selection.projectId) return undefined;

    const treeNodesById = new Map(
      selection.treeNodes.map((node) => [node.id, node] as const),
    );
    const codexById = new Map(
      allEntries.map((entry) => [entry.id, entry] as const),
    );
    const aiBranchById = new Map(
      aiBranches.map((branch) => [branch.id, branch] as const),
    );
    const snippetCache = new Map<string, string>();
    const fillSnippetTitle = (id: string): string | null => {
      const cached = snippetCache.get(id);
      if (cached !== undefined) return cached;
      getSnippet(selection.projectId, id)
        .then((snippet) => {
          if (snippet) snippetCache.set(id, snippet.title);
        })
        .catch(() => {});
      return null;
    };
    const resolveLabel = (
      position: (typeof positions)[number],
    ): ResolvedLabel | null => {
      if (position.nodeRefType === "scene" || position.nodeRefType === "note") {
        if (!position.treeNodeId) return null;
        const node = treeNodesById.get(position.treeNodeId);
        if (!node) return null;
        return {
          kind: position.nodeRefType,
          title: node.title || "(untitled)",
        };
      }
      if (position.nodeRefType === "codex") {
        if (!position.codexEntryId) return null;
        const entry = codexById.get(position.codexEntryId);
        if (!entry) return null;
        return { kind: "codex", title: entry.name || "(untitled)" };
      }
      if (position.nodeRefType === "snippet") {
        if (!position.snippetId) return null;
        const title = fillSnippetTitle(position.snippetId);
        return {
          kind: "snippet",
          title: title ?? "(snippet)",
        };
      }
      if (position.nodeRefType === "ai_branch") {
        if (!position.aiBranchId) return null;
        const branch = aiBranchById.get(position.aiBranchId);
        if (!branch) return null;
        return {
          kind: "ai_branch",
          title: branch.prompt.trim().slice(0, 40) || "(AI branch)",
        };
      }
      return null;
    };

    return buildMapContextMarkdown({
      boardTitle: board.title,
      stickies,
      edges,
      frames,
      positions,
      resolveLabel,
    });
  } catch {
    return undefined;
  }
}

async function buildChronicleSnapshotTextForScene(
  projectId: string,
  sceneId: string,
  treeNodes: readonly TreeNodeData[],
  language: string,
  codexNames: Map<string, string>,
  sceneCodexIds: string[],
  mentionedCodexIds: string[],
  enabled: boolean,
): Promise<string | undefined> {
  if (!enabled) return undefined;
  const events = await listEvents(projectId);
  const sceneChronicle = new Map<string, SceneChronicle>();
  for (const node of treeNodes) {
    if (node.nodeType !== "scene") continue;
    sceneChronicle.set(node.id, {
      startTime: node.chronicleStartTime ?? null,
      startMinute: node.chronicleStartMinute ?? null,
      startGranularity: node.chronicleStartGranularity ?? "none",
      precision: (node.chroniclePrecision ?? "exact") as EventPrecision,
    });
  }
  const current = sceneChronicle.get(sceneId);
  const currentHasDate =
    !!current &&
    current.startGranularity !== "none" &&
    current.startTime != null;
  if (events.length === 0 && !currentHasDate) return undefined;

  const [participants, sceneEvents, calendarRow, relations] = await Promise.all(
    [
      listEventParticipantsForProject(projectId),
      listSceneEventsForProject(projectId),
      getProjectCalendar(projectId),
      listEventRelations(projectId),
    ],
  );
  return assembleChronicleSnapshotText({
    sceneId,
    events,
    participants,
    relations,
    sceneEvents,
    calendar: calendarRow ? calendarFromRow(calendarRow) : null,
    readingOrder: computeGlobalSceneOrder([...treeNodes]),
    codexNames,
    sceneCodexIds,
    mentionedCodexIds,
    sceneChronicle,
    lang: language,
  });
}

function snapshotPlotThreadScenes(
  sceneId: string,
  treeNodes: readonly TreeNodeData[],
): BuildSystemPromptInput["plotThreadScenes"] {
  const plotState = usePlotThreadStore.getState();
  const memberships = computeSceneThreadContext(plotState.links, sceneId);
  if (memberships.length === 0) return undefined;

  const titleById = new Map(
    treeNodes.map((node) => [node.id, node.title] as const),
  );
  const threadById = new Map(
    plotState.threads.map((thread) => [thread.id, thread] as const),
  );
  const phaseLabel = (phase: PlotPhaseType) =>
    i18next.t(`plotThread.phaseType.${phase}`);
  const phaseRank = (phase: PlotPhaseType) =>
    (PLOT_PHASE_TYPES as readonly string[]).indexOf(phase);
  const unnamed = i18next.t("plotThread.unnamed", "（無名）");

  return [...memberships]
    .sort((left, right) =>
      cmpKeys(
        threadById.get(left.threadId)?.sortOrder ?? "",
        threadById.get(right.threadId)?.sortOrder ?? "",
      ),
    )
    .map((membership) => ({
      threadName: threadById.get(membership.threadId)?.name?.trim() || unnamed,
      currentPhases: membership.currentPhases.map(phaseLabel),
      markers: [...membership.others]
        .sort(
          (left, right) =>
            phaseRank(left.phaseType) - phaseRank(right.phaseType),
        )
        .slice(0, PLOT_THREAD_MAX_MARKERS)
        .map((other) => ({
          title: titleById.get(other.nodeId) ?? unnamed,
          phaseLabel: phaseLabel(other.phaseType),
        })),
    }));
}

function captureTreeNodes(
  projectId: string,
  normalizeMissingProjectId: boolean,
): TreeNodeData[] {
  return useTreeStore
    .getState()
    .nodes.filter(
      (node) =>
        node.projectId === projectId ||
        (normalizeMissingProjectId && !node.projectId),
    )
    .map((node) =>
      normalizeMissingProjectId && !node.projectId
        ? { ...node, projectId }
        : { ...node },
    );
}

function createProductionSceneSourceDeps(input: {
  projectId: string;
  sceneId: string;
  treeNodes: TreeNodeData[];
  temporalResolution: CapturedNonSceneContext["temporalResolution"];
  plotThreadScenes: BuildSystemPromptInput["plotThreadScenes"];
  unplacedBeats: UnplacedBeat[];
}): SceneContextSourceDeps {
  return createSceneContextSourceDeps({
    listCodexEntries: listCodexEntriesForContext,
    listCodexContextMetadata,
    listCodexEntriesByIds: listCodexEntriesForContextByIds,
    listTreeNodes: (projectId) =>
      projectId === input.projectId ? input.treeNodes : [],
    getTemporalResolution: (projectId) => {
      if (projectId !== input.projectId) {
        throw new Error("scene context temporal project mismatch");
      }
      return input.temporalResolution;
    },
    listPhases: listPhasesByEntryIds,
    listPhaseDetailOverrides: listDetailOverridesByPhaseIds,
    listRawDetailValues: listRawDetailValuesByEntryIds,
    listContextDetails: listContextDetailsByEntryIds,
    findMentionedEntries: findMentionedEntriesAsync,
    listPinnedCodex: chatApi.listPinnedCodexEntries,
    listPinnedSnippets: chatApi.listPinnedSnippetEntries,
    listPinnedStickies: chatApi.listPinnedStickyEntries,
    getSnippet,
    getUnplacedBeats: (sceneId) =>
      sceneId === input.sceneId ? input.unplacedBeats : [],
    listSummaries: chatApi.listSummaries,
    listNodeLabels,
    getSceneForeshadow: getSceneForeshadowContext,
    listOpenForeshadows: listOpenForeshadowsForContext,
    fetchSemanticRecall,
    fetchChatRecall,
    loadMentionedScenes: (projectId, ids, currentSceneId) =>
      projectId === input.projectId
        ? loadMentionedScenes([...ids], currentSceneId, input.treeNodes)
        : Promise.resolve([]),
    listCodexRelations,
    loadMapBoardMarkdown: (request, entries) =>
      loadMapBoardMarkdown(entries, {
        enabled: request.map.enabled,
        boardId: request.map.boardId,
        activeBoardId: request.map.activeBoardId,
        projectId: request.projectId,
        treeNodes: input.treeNodes,
      }),
    buildChronicleSnapshot: ({
      request,
      language,
      codexNames,
      sceneCodexIds,
      mentionedCodexIds,
    }) =>
      buildChronicleSnapshotTextForScene(
        request.projectId,
        request.sceneId,
        input.treeNodes,
        language,
        codexNames,
        sceneCodexIds,
        mentionedCodexIds,
        request.settings.chronicleEnabled,
      ),
    buildPlotThreadScenes: (projectId, sceneId) =>
      projectId === input.projectId && sceneId === input.sceneId
        ? input.plotThreadScenes
        : undefined,
    markStart,
    markEnd,
  });
}

function captureSceneContext(
  input: ChatContextPreparationSnapshotInput,
): CapturedSceneContext {
  const sceneId = input.effectiveSceneId;
  if (!sceneId) throw new Error("scene context authority mismatch");
  const treeNodes = captureTreeNodes(input.projectId, false);
  const temporalResolution = cloneTemporalResolution();
  const plotThreadScenes = snapshotPlotThreadScenes(sceneId, treeNodes);
  const unplacedBeats = useUnplacedBeatsStore
    .getState()
    .getBeats(sceneId)
    .map((beat) => ({
      ...beat,
      content: beat.content.map((node) => ({ ...node })),
    }));
  return {
    request: {
      map: mapSelection(input),
      activeTab: focusedContextTab(),
      settings: contextSettings(),
    },
    sourceDeps: createProductionSceneSourceDeps({
      projectId: input.projectId,
      sceneId,
      treeNodes,
      temporalResolution,
      plotThreadScenes,
      unplacedBeats,
    }),
  };
}

function createProductionNonSceneSourceDeps(
  request: NonSceneTurnContextRequest,
  temporalResolution: CapturedNonSceneContext["temporalResolution"],
): NonSceneContextSourceDeps {
  return createNonSceneContextSourceDeps({
    fetchProjectContext: fetchRequiredProjectContext,
    listCodexEntries: listCodexEntriesForContext,
    listCodexContextMetadata,
    listCodexEntriesByIds: listCodexEntriesForContextByIds,
    getTemporalResolution: (projectId) => {
      if (projectId !== request.projectId) {
        throw new Error("non-scene temporal project mismatch");
      }
      return temporalResolution;
    },
    listPhases: listPhasesByEntryIds,
    listPhaseDetailOverrides: listDetailOverridesByPhaseIds,
    listRawDetailValues: listRawDetailValuesByEntryIds,
    findMentionedEntries: findMentionedEntriesAsync,
    listCodexRelations,
    loadMentionedScenes: (projectId, ids) => {
      if (projectId !== request.projectId) {
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
    listPinnedSnippets: chatApi.listPinnedSnippetEntries,
    listContextDetails: listContextDetailsByEntryIds,
    loadMapBoardMarkdown: (sourceRequest, entries) =>
      loadMapBoardMarkdown(entries, {
        enabled: sourceRequest.map.enabled,
        boardId: sourceRequest.map.boardId,
        activeBoardId: sourceRequest.map.activeBoardId,
        projectId: sourceRequest.projectId,
        treeNodes: sourceRequest.sourceSnapshot.treeNodes,
      }),
  });
}

function captureNonSceneContext(
  input: ChatContextPreparationSnapshotInput,
): CapturedNonSceneContext {
  const treeNodes = captureTreeNodes(input.projectId, true);
  const plotState = usePlotThreadStore.getState();
  return {
    scope: scopeForInput(input),
    map: mapSelection(input),
    activeTab: focusedContextTab(),
    settings: contextSettings(),
    sourceSnapshot: {
      treeNodes,
      plotThreadIds: plotState.threads.map((thread) => thread.id),
      plotThreadLinks: plotState.links.map(({ threadId, nodeId }) => ({
        threadId,
        nodeId,
      })),
    },
    temporalResolution: cloneTemporalResolution(),
  };
}

type CapturedPreparationSnapshot =
  | {
      input: ChatContextPreparationSnapshotInput;
      authority: ChatContextPreparationAuthority;
      kind: "public-web";
    }
  | {
      input: ChatContextPreparationSnapshotInput;
      authority: ChatContextPreparationAuthority;
      kind: "scene";
      captured: CapturedSceneContext;
    }
  | {
      input: ChatContextPreparationSnapshotInput;
      authority: ChatContextPreparationAuthority;
      kind: "non-scene";
      captured: CapturedNonSceneContext;
    };

function capturePreparationSnapshot(
  input: ChatContextPreparationSnapshotInput,
): ChatContextPreparationSnapshot {
  const authority = authoritySnapshot();
  const captured: CapturedPreparationSnapshot =
    input.privacy === "public-web"
      ? { input, authority, kind: "public-web" }
      : input.effectiveSceneId
        ? {
            input,
            authority,
            kind: "scene",
            captured: captureSceneContext(input),
          }
        : {
            input,
            authority,
            kind: "non-scene",
            captured: captureNonSceneContext(input),
          };
  return { value: captured };
}

function snapshotInput(
  input: ChatContextPreparationInput,
): ChatContextPreparationSnapshotInput {
  return {
    privacy: input.privacy,
    projectId: input.projectId,
    effectiveSceneId: input.effectiveSceneId,
    activeSceneId: input.activeSceneId,
    activeProjectId: input.activeProjectId,
    chatScope: input.chatScope,
    scopeAnchorId: input.scopeAnchorId,
    threadFocus: input.threadFocus,
    includeMapBoard: input.includeMapBoard,
    mapBoardId: input.mapBoardId,
  };
}

function resolveCapturedSnapshot(
  input: ChatContextPreparationInput,
  snapshot?: ChatContextPreparationSnapshot,
): CapturedPreparationSnapshot {
  const resolved = (
    snapshot ?? capturePreparationSnapshot(snapshotInput(input))
  ).value as CapturedPreparationSnapshot;
  const expected = snapshotInput(input);
  if (
    resolved.input.privacy !== expected.privacy ||
    resolved.input.projectId !== expected.projectId ||
    resolved.input.effectiveSceneId !== expected.effectiveSceneId ||
    resolved.input.activeSceneId !== expected.activeSceneId ||
    resolved.input.activeProjectId !== expected.activeProjectId ||
    resolved.input.chatScope !== expected.chatScope ||
    resolved.input.scopeAnchorId !== expected.scopeAnchorId ||
    resolved.input.threadFocus?.threadId !== expected.threadFocus?.threadId ||
    resolved.input.threadFocus?.title !== expected.threadFocus?.title ||
    resolved.input.includeMapBoard !== expected.includeMapBoard ||
    resolved.input.mapBoardId !== expected.mapBoardId
  ) {
    throw new Error("chat context snapshot authority mismatch");
  }
  return resolved;
}

export const chatContextPreparationComposition: ChatContextPreparationPort = {
  capture: capturePreparationSnapshot,
  prepare(input, snapshot) {
    const captured = resolveCapturedSnapshot(input, snapshot);
    if (captured.kind === "public-web") {
      return preparePublicWebContext(input, captured.authority);
    }
    if (captured.kind === "scene") {
      return prepareCapturedScene(input, captured.captured, captured.authority);
    }
    return prepareCapturedNonScene(
      input,
      captured.captured,
      captured.authority,
    );
  },
  isAuthorityCurrent,
};
