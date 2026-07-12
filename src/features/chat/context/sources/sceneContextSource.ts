import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import type { CodexContextEntry } from "@/features/codex/api";
import type { ContextDecision } from "@/features/ai-context/types";
import type {
  CodexEntryPhase,
  CodexPhaseDetailOverride,
} from "@/features/codex/phaseApi";
import type { CodexRelationRow } from "@/features/codex/codexRelationApi";
import type {
  PhaseResolutionMode,
  ResolvedCodexState,
  SceneTimeIndex,
  TemporalAnchor,
} from "@/features/codex/phaseResolver";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import {
  canIncludeResolvedCodexContext,
  materializeResolvedCodexContext,
  resolveCodexContexts,
} from "@/features/codex/context/resolvedCodexContext";
import {
  getDescendantsBFS,
  getChildrenFromArray,
  buildChildrenContext,
  computeChildrenTokenBudget,
  collectBudgetedDescendantIds,
} from "@/features/codex/childrenBudget";
import { detailValueToPlainText } from "@/features/codex/detailCleanup";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import {
  expandCodexRelationsBFS,
  collectIntraContextRelations,
  type IntraContextRelationEdge,
} from "@/features/codex/relationExpansion";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { prosemirrorToText } from "@/lib/prosemirror";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import { buildPendingBeatsSection } from "@/features/editor/beat/pendingBeatsContext";
import type {
  SceneForeshadowContext,
  OpenForeshadowForContext,
} from "@/features/foreshadow/api";
import type { Label } from "@/features/labels/labelApi";
import type { Snippet } from "@/features/snippets/api";
import type {
  PinnedCodexEntryWithData,
  PinnedSnippetEntryWithData,
  PinnedStickyEntryWithData,
} from "../../chatApi";
import type { ChatSummary } from "../../chatTypes";
import {
  buildSemanticRecallQuery,
  type SemanticRecallChunk,
} from "../../semanticRecall";
import type { ChatRecallMessage } from "../../chatRecall";
import {
  allocateLayerBudgets,
  buildStorySoFar,
  countTokens,
  type BuildSystemPromptInput,
  type CodexContext,
  type NoteContext,
  type PinnedCodexContext,
  type PinnedSnippetContext,
  type PinnedStickyContext,
} from "../../contextBuilder";
import type {
  RequiredSceneContext,
  RecalledMessageForPromotion,
} from "../contextPlannerDeps";
import type { SceneTurnContextRequest } from "../turnContextRequest";

export interface SceneContextSourceDeps {
  listCodexEntries: (projectId: string) => Promise<CodexContextEntry[]>;
  listTreeNodes: (projectId: string) => TreeNodeData[];
  getTemporalResolution: (projectId: string) => {
    sceneTimeIndex: SceneTimeIndex;
    resolutionMode: PhaseResolutionMode;
  };
  listPhases: (entryIds: string[]) => Promise<CodexEntryPhase[]>;
  listPhaseDetailOverrides: (
    phaseIds: string[],
  ) => Promise<CodexPhaseDetailOverride[]>;
  listRawDetailValues: (
    entryIds: string[],
  ) => Promise<
    Array<{ entryId: string; definitionId: string; value: string | null }>
  >;
  listContextDetails: (entryIds: string[]) => Promise<
    Array<{
      entryId: string;
      definitionId: string;
      fieldName: string;
      fieldType: string;
      value: string | null;
    }>
  >;
  findMentionedEntries: (
    text: string,
    entries: CodexMatchTarget[],
  ) => Promise<CodexMatchTarget[]>;
  listPinnedCodex: (sessionId: string) => Promise<PinnedCodexEntryWithData[]>;
  listPinnedSnippets: (
    sessionId: string,
  ) => Promise<PinnedSnippetEntryWithData[]>;
  listPinnedStickies: (
    sessionId: string,
  ) => Promise<PinnedStickyEntryWithData[]>;
  getSnippet: (
    projectId: string,
    snippetId: string,
  ) => Promise<Snippet | undefined>;
  getUnplacedBeats: (sceneId: string) => UnplacedBeat[];
  listSummaries: (sessionId: string) => Promise<ChatSummary[]>;
  listNodeLabels: (sceneId: string) => Promise<Label[]>;
  getSceneForeshadow: (sceneId: string) => Promise<SceneForeshadowContext>;
  listOpenForeshadows: (
    projectId: string,
  ) => Promise<OpenForeshadowForContext[]>;
  fetchSemanticRecall: (input: {
    projectId: string;
    query: string;
    excludeSceneIds: string[];
    hybrid: boolean;
  }) => Promise<SemanticRecallChunk[]>;
  fetchChatRecall: (input: {
    projectId: string;
    query: string;
    excludeSessionIds: string[];
    hybrid: boolean;
  }) => Promise<ChatRecallMessage[]>;
  loadMentionedScenes: (
    projectId: string,
    ids: readonly string[],
    currentSceneId: string,
  ) => Promise<Array<{ id: string; title: string; content: string }>>;
  listCodexRelations: (projectId: string) => Promise<CodexRelationRow[]>;
  loadMapBoardMarkdown: (
    request: SceneTurnContextRequest,
    entries: CodexContextEntry[],
  ) => Promise<string | undefined>;
  buildChronicleSnapshot: (input: {
    request: SceneTurnContextRequest;
    language: string;
    codexNames: Map<string, string>;
    sceneCodexIds: string[];
    mentionedCodexIds: string[];
  }) => Promise<string | undefined>;
  buildPlotThreadScenes: (
    projectId: string,
    sceneId: string,
  ) => BuildSystemPromptInput["plotThreadScenes"];
  markStart: (label: string) => void;
  markEnd: (label: string) => void;
}

const EMPTY_FORESHADOW: SceneForeshadowContext = { setups: [], payoffs: [] };

export function createSceneContextSourceDeps(
  overrides: Partial<SceneContextSourceDeps> = {},
): SceneContextSourceDeps {
  return {
    listCodexEntries: async () => [],
    listTreeNodes: () => [],
    getTemporalResolution: () => ({
      sceneTimeIndex: buildSceneTimeIndex([]),
      resolutionMode: "reading",
    }),
    listPhases: async () => [],
    listPhaseDetailOverrides: async () => [],
    listRawDetailValues: async () => [],
    listContextDetails: async () => [],
    findMentionedEntries: async () => [],
    listPinnedCodex: async () => [],
    listPinnedSnippets: async () => [],
    listPinnedStickies: async () => [],
    getSnippet: async () => undefined,
    getUnplacedBeats: () => [],
    listSummaries: async () => [],
    listNodeLabels: async () => [],
    getSceneForeshadow: async () => EMPTY_FORESHADOW,
    listOpenForeshadows: async () => [],
    fetchSemanticRecall: async () => [],
    fetchChatRecall: async () => [],
    loadMentionedScenes: async () => [],
    listCodexRelations: async () => [],
    loadMapBoardMarkdown: async () => undefined,
    buildChronicleSnapshot: async () => undefined,
    buildPlotThreadScenes: () => undefined,
    markStart: () => {},
    markEnd: () => {},
    ...overrides,
  };
}

function parseAliases(json: string | null | undefined): string[] | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return undefined;
    const aliases = value.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return aliases.length > 0 ? aliases : undefined;
  } catch {
    return undefined;
  }
}

function parseTags(json: string | null | undefined): string[] | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return undefined;
    const tags = value
      .map((entry): string | undefined => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "name" in entry) {
          const name = (entry as { name: unknown }).name;
          return typeof name === "string" ? name : undefined;
        }
        return undefined;
      })
      .filter((entry): entry is string => Boolean(entry));
    return tags.length > 0 ? tags : undefined;
  } catch {
    return undefined;
  }
}

async function resolveEntriesForContext(
  entries: CodexContextEntry[],
  anchor: TemporalAnchor,
  request: SceneTurnContextRequest,
  deps: SceneContextSourceDeps,
): Promise<{
  resolved: Map<string, ResolvedCodexState>;
  phases: Map<string, CodexEntryPhase[]>;
}> {
  const resolved = new Map<string, ResolvedCodexState>();
  const phasesMap = new Map<string, CodexEntryPhase[]>();
  if (entries.length === 0) return { resolved, phases: phasesMap };

  const entryIds = entries.map((entry) => entry.id);
  const phases = await deps.listPhases(entryIds);
  const overrides = await deps.listPhaseDetailOverrides(
    phases.map((phase) => phase.id),
  );
  const rawDetails = await deps.listRawDetailValues(entryIds);
  const detailsByEntry = new Map<string, Map<string, string | null>>();
  for (const detail of rawDetails) {
    const values =
      detailsByEntry.get(detail.entryId) ?? new Map<string, string | null>();
    values.set(detail.definitionId, detail.value);
    detailsByEntry.set(detail.entryId, values);
  }
  const { sceneTimeIndex, resolutionMode } = deps.getTemporalResolution(
    request.projectId,
  );
  const result = resolveCodexContexts({
    entries,
    phases,
    phaseDetailOverrides: overrides,
    baseDetailsByEntry: detailsByEntry,
    anchor,
    sceneTimeIndex,
    resolutionMode,
  });
  return { resolved: result.resolvedById, phases: result.phasesByEntry };
}

async function enrichWithCustomDetails<T extends CodexContext>(
  entries: T[],
  allEntries: CodexContextEntry[],
  resolvedById: ReadonlyMap<string, ResolvedCodexState>,
  deps: SceneContextSourceDeps,
): Promise<T[]> {
  if (entries.length === 0) return entries;
  const details = await deps.listContextDetails(
    entries.map((entry) => entry.id),
  );
  const byEntry = new Map<
    string,
    Array<{ fieldName: string; value: string }>
  >();
  for (const detail of details) {
    const resolved = resolvedById.get(detail.entryId);
    const resolvedValue = resolved?.detailValues.has(detail.definitionId)
      ? resolved.detailValues.get(detail.definitionId)
      : detail.value;
    // null is an explicit Phase clear; do not fall back to the Base row.
    if (resolvedValue == null) continue;
    let value: string;
    if (detail.fieldType === "codex_reference") {
      const referenced = allEntries.find((entry) => entry.id === resolvedValue);
      // A reference to an entry rejected by the effective visibility policy
      // must not smuggle its name/id back into an otherwise visible entry.
      if (!referenced) continue;
      value = referenced.name;
    } else {
      value = detailValueToPlainText(resolvedValue);
    }
    if (!value.trim()) continue;
    const values = byEntry.get(detail.entryId) ?? [];
    values.push({ fieldName: detail.fieldName, value });
    byEntry.set(detail.entryId, values);
  }
  return entries.map((entry) => {
    const customDetails = byEntry.get(entry.id);
    return customDetails?.length ? { ...entry, customDetails } : entry;
  });
}

function buildChildrenContextForEntry(
  entry: Pick<CodexContextEntry, "id" | "childrenBudget">,
  allEntries: CodexContextEntry[],
  l4Budget: number,
  excludeIds?: Set<string>,
  resolvedById?: ReadonlyMap<
    string,
    { summary: string | null; content: string; contextMode: string }
  >,
): string | undefined {
  const preset = entry.childrenBudget ?? "compact";
  if (preset === "none") return undefined;
  const descendants = getDescendantsBFS(entry.id, allEntries).filter(
    (descendant) =>
      !excludeIds?.has(descendant.id) &&
      canIncludeResolvedCodexContext(
        resolvedById?.get(descendant.id)?.contextMode ?? descendant.contextMode,
        "derived",
      ),
  );
  return (
    buildChildrenContext(
      descendants,
      computeChildrenTokenBudget(preset, l4Budget),
      resolvedById,
    ) || undefined
  );
}

function stableSortEntries<T extends { id: string }>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        left.entry.id.localeCompare(right.entry.id) || left.index - right.index,
    )
    .map(({ entry }) => entry);
}

export async function collectSceneContext(
  request: SceneTurnContextRequest,
  deps: SceneContextSourceDeps,
): Promise<RequiredSceneContext> {
  const snapshot = request.sourceSnapshot;
  const scene = {
    ...snapshot.scene,
    content: request.includeBodies ? snapshot.scene.content : "",
  };
  const project = snapshot.project;
  const allEntries: CodexContextEntry[] = snapshot.prefetchedCodexEntries
    ? [...snapshot.prefetchedCodexEntries]
    : await deps.listCodexEntries(request.projectId);
  if (allEntries.some((entry) => entry.projectId !== request.projectId)) {
    throw new Error("scene context source returned a foreign-project row");
  }

  const budgets = allocateLayerBudgets(request.budget.contextWindow, {
    maxOutputTokens: request.budget.maxOutputTokens,
    responseReservationTokens: request.budget.responseReservationTokens,
  });
  const l4Budget = budgets.l4;
  const allNodes = deps
    .listTreeNodes(request.projectId)
    .filter((node) => node.projectId === request.projectId);
  const noteNodes = allNodes.filter((node) => node.nodeType === "note");
  const temporalAnchor: TemporalAnchor = {
    kind: "scene",
    sceneId: request.sceneId,
  };
  const { resolved: resolvedById, phases: phasesByEntry } =
    await resolveEntriesForContext(allEntries, temporalAnchor, request, deps);
  const effectiveEntries = allEntries.map((entry) => {
    const resolved = resolvedById.get(entry.id);
    return resolved ? materializeResolvedCodexContext(entry, resolved) : entry;
  });
  type TemporalMetadata = NonNullable<
    BuildSystemPromptInput["contextTemporal"]
  >;
  const contextTemporal: TemporalMetadata = { asOfSceneId: request.sceneId };
  const contextTemporalBySourceId: Record<string, TemporalMetadata> = {};
  for (const entry of effectiveEntries) {
    const resolved = resolvedById.get(entry.id);
    contextTemporalBySourceId[entry.id] = {
      ...contextTemporal,
      ...(resolved?.axisUsed ? { axis: resolved.axisUsed } : {}),
      ...(resolved?.activePhaseId ? { phaseId: resolved.activePhaseId } : {}),
      ...(resolved?.fallbackReason
        ? { fallbackReason: resolved.fallbackReason }
        : {}),
    };
  }
  const effectiveEntryById = new Map(
    effectiveEntries.map((entry) => [entry.id, entry]),
  );

  // Pins are a selection trigger, not a source of prompt data. Resolve their
  // current entry first, then apply the explicit-pin exception for suppress.
  const pinnedFromDb = request.sessionId
    ? await deps.listPinnedCodex(request.sessionId)
    : [];
  const dbPinnedIds = new Set(pinnedFromDb.map((entry) => entry.id));
  const inputPinnedIds = request.inputPinnedEntryIds.filter(
    (id) => !dbPinnedIds.has(id),
  );
  const allPinnedIds = new Set([...dbPinnedIds, ...inputPinnedIds]);
  const contextDecisions = [...allPinnedIds].flatMap<ContextDecision>((id) => {
    const entry = effectiveEntryById.get(id);
    if (!entry) {
      return [
        {
          key: `codex:${id}`,
          status: "unavailable",
          reason: "missing-source",
          tokensBefore: 0,
          tokensAfter: 0,
        },
      ];
    }
    if (!canIncludeResolvedCodexContext(entry.contextMode, "explicit-pin")) {
      return [
        {
          key: `codex:${id}`,
          status: "excluded",
          reason: `policy-${entry.contextMode}`,
          tokensBefore: 0,
          tokensAfter: 0,
        },
      ];
    }
    return [];
  });
  const contextEligibleEntries = effectiveEntries.filter((entry) =>
    canIncludeResolvedCodexContext(
      entry.contextMode,
      allPinnedIds.has(entry.id) ? "explicit-pin" : "derived",
    ),
  );
  const contextEligibleIds = new Set(
    contextEligibleEntries.map((entry) => entry.id),
  );

  const excludedAutoIds = new Set(request.excludedAutoEntryIds);
  const detectableCodex = effectiveEntries.filter(
    (entry) =>
      !excludedAutoIds.has(entry.id) &&
      canIncludeResolvedCodexContext(entry.contextMode, "mention"),
  );
  const alwaysCodex = effectiveEntries.filter(
    (entry) => entry.contextMode === "always" && !excludedAutoIds.has(entry.id),
  );
  const detectableNotes = noteNodes.filter((node) => {
    const mode = node.contextMode ?? "mentioned";
    return mode !== "hidden" && mode !== "suppress";
  });
  const alwaysNotes = noteNodes.filter(
    (node) => (node.contextMode ?? "mentioned") === "always",
  );
  const matchTargets: CodexMatchTarget[] = [
    ...detectableCodex.map((entry) => ({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      aliases: entry.aliases,
      excludedAliases: entry.excludedAliases,
    })),
    ...detectableNotes.map((node) => ({
      id: node.id,
      name: node.title,
      type: "note",
      aliases: node.aliases ?? "[]",
      excludedAliases: node.excludedAliases ?? "[]",
    })),
  ];
  const mentionText = [
    scene.content,
    ...request.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content),
  ].join("\n");
  deps.markStart("buildSceneCtx.findMentionedEntriesAsync");
  const mentionedAll = await deps.findMentionedEntries(
    mentionText,
    matchTargets,
  );
  deps.markEnd("buildSceneCtx.findMentionedEntriesAsync");
  const mentioned = mentionedAll
    .filter((entry) => entry.type !== "note" && !excludedAutoIds.has(entry.id))
    .map((entry) => effectiveEntryById.get(entry.id))
    .filter((entry): entry is CodexContextEntry => entry !== undefined)
    .filter((entry) =>
      canIncludeResolvedCodexContext(entry.contextMode, "mention"),
    );
  const mentionedNotes = mentionedAll.filter((entry) => entry.type === "note");
  const mentionedIds = new Set(mentioned.map((entry) => entry.id));
  const alwaysNotMentioned = alwaysCodex.filter(
    (entry) => !mentionedIds.has(entry.id),
  );
  const rawCodexEntries = stableSortEntries([
    ...mentioned,
    ...alwaysNotMentioned,
  ]);

  const buildCodexContext = (entry: CodexContextEntry): CodexContext => {
    const summary = entry.summary ?? "";
    const aliases = parseAliases(entry.aliases);
    const resolved = resolvedById.get(entry.id);
    const phases = phasesByEntry.get(entry.id) ?? [];
    const activePhase = resolved?.activePhaseId
      ? phases.find((phase) => phase.id === resolved.activePhaseId)
      : undefined;
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      summary,
      contentFallback: summary.trim()
        ? undefined
        : extractPlainText(entry.content) || undefined,
      ...(aliases ? { aliases } : {}),
      ...(activePhase ? { phaseLabel: activePhase.label } : {}),
    };
  };
  const baseCodexEntries = rawCodexEntries.map(buildCodexContext);
  const withChildren = baseCodexEntries.map((context) => {
    const full = effectiveEntryById.get(context.id);
    if (!full) return context;
    const childrenContext = buildChildrenContextForEntry(
      full,
      effectiveEntries,
      l4Budget,
      allPinnedIds,
      resolvedById,
    );
    return childrenContext ? { ...context, childrenContext } : context;
  });
  deps.markStart("buildSceneCtx.enrichWithCustomDetails");
  const enrichedCodexEntries = await enrichWithCustomDetails(
    withChildren,
    contextEligibleEntries,
    resolvedById,
    deps,
  );
  deps.markEnd("buildSceneCtx.enrichWithCustomDetails");
  const codexEntries = enrichedCodexEntries;

  const buildPinnedContext = (
    entry: CodexContextEntry,
    withChildren: boolean,
  ): PinnedCodexContext | null => {
    if (!canIncludeResolvedCodexContext(entry.contextMode, "explicit-pin")) {
      return null;
    }
    const children = withChildren
      ? getChildrenFromArray(entry.id, effectiveEntries)
          .filter((child) => !allPinnedIds.has(child.id))
          .filter((child) =>
            canIncludeResolvedCodexContext(child.contextMode, "derived"),
          )
          .map((child) => {
            const aliases = parseAliases(child.aliases);
            const summary = child.summary ?? "";
            return {
              id: child.id,
              type: child.type,
              name: child.name,
              summary,
              contentFallback: summary.trim()
                ? undefined
                : extractPlainText(child.content) || undefined,
              ...(aliases ? { aliases } : {}),
            };
          })
      : undefined;
    const childrenContext = buildChildrenContextForEntry(
      entry,
      effectiveEntries,
      l4Budget,
      allPinnedIds,
      resolvedById,
    );
    const aliases = parseAliases(entry.aliases);
    const tags = parseTags(entry.tagsCache);
    const resolved = resolvedById.get(entry.id);
    const phases = phasesByEntry.get(entry.id) ?? [];
    const activePhase = resolved?.activePhaseId
      ? phases.find((phase) => phase.id === resolved.activePhaseId)
      : undefined;
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      summary: entry.summary ?? "",
      fullContent: extractPlainText(entry.content) || undefined,
      withChildren,
      children,
      ...(aliases ? { aliases } : {}),
      ...(tags ? { tags } : {}),
      ...(childrenContext ? { childrenContext } : {}),
      ...(activePhase ? { phaseLabel: activePhase.label } : {}),
    };
  };
  let pinnedCodexEntries: PinnedCodexContext[] = pinnedFromDb.flatMap((pin) => {
    const entry = effectiveEntryById.get(pin.id);
    if (!entry) return [];
    const context = buildPinnedContext(entry, pin.withChildren);
    return context ? [context] : [];
  });
  const extraPinned = inputPinnedIds.flatMap((id) => {
    const entry = effectiveEntryById.get(id);
    if (!entry) return [];
    const context = buildPinnedContext(entry, false);
    return context ? [context] : [];
  });
  if (extraPinned.length > 0) {
    pinnedCodexEntries = [...pinnedCodexEntries, ...extraPinned];
  }
  pinnedCodexEntries = await enrichWithCustomDetails(
    pinnedCodexEntries,
    contextEligibleEntries,
    resolvedById,
    deps,
  );
  const pinnedIds = new Set(pinnedCodexEntries.map((entry) => entry.id));
  const detectedEntries = mentioned
    .filter((entry) => !pinnedIds.has(entry.id))
    .map((entry) => effectiveEntryById.get(entry.id))
    .filter((entry): entry is CodexContextEntry => entry !== undefined);
  const alwaysEntries = alwaysCodex.filter(
    (entry) => !pinnedIds.has(entry.id) && !mentionedIds.has(entry.id),
  );
  // UI lists deduplicate mentioned-vs-always, but priority is semantic. An
  // effective always entry remains always even when its name also matched.
  const alwaysEntryIdsForPrompt = alwaysCodex
    .filter((entry) => !pinnedIds.has(entry.id))
    .map((entry) => entry.id);

  const noteById = new Map(noteNodes.map((node) => [node.id, node]));
  const noteContext = (node: TreeNodeData): NoteContext => {
    const aliases = parseAliases(node.aliases);
    return {
      id: node.id,
      title: node.title,
      content: prosemirrorToText(node.content ?? ""),
      ...(aliases ? { aliases } : {}),
    };
  };
  const mentionedNoteIds = new Set(mentionedNotes.map((entry) => entry.id));
  const notes: NoteContext[] = [
    ...mentionedNotes
      .map((entry) => noteById.get(entry.id))
      .filter((node): node is TreeNodeData => node !== undefined)
      .map(noteContext),
    ...alwaysNotes
      .filter((node) => !mentionedNoteIds.has(node.id))
      .map(noteContext),
  ];

  const currentScene = allNodes.find((node) => node.id === scene.id);
  deps.markStart("buildSceneCtx.buildStorySoFar");
  const storySoFar = buildStorySoFar(scene.id, allNodes, budgets.l2);
  deps.markEnd("buildSceneCtx.buildStorySoFar");
  const chapterOutlines: Array<{ title: string; outline: string }> = [];
  {
    const path: Array<{ title: string; outline: string }> = [];
    let cursor = currentScene;
    while (cursor?.parentId) {
      const parent = allNodes.find((node) => node.id === cursor!.parentId);
      if (!parent) break;
      if (parent.nodeType === "folder" && parent.synopsis?.trim()) {
        path.push({ title: parent.title, outline: parent.synopsis.trim() });
      }
      cursor = parent;
    }
    chapterOutlines.push(...path.reverse());
  }
  const previousReadingNode = currentScene
    ? allNodes
        .filter(
          (node) =>
            node.nodeType === "scene" &&
            node.id !== scene.id &&
            cmpKeys(node.sortOrder, currentScene.sortOrder) < 0 &&
            Boolean(node.synopsis?.trim()),
        )
        .sort((left, right) => cmpKeys(right.sortOrder, left.sortOrder))[0]
    : undefined;
  const previousScene = previousReadingNode?.synopsis
    ? {
        title: previousReadingNode.title,
        synopsis: previousReadingNode.synopsis,
      }
    : undefined;
  const previousStoryNode =
    currentScene?.storyTimeOrder != null
      ? allNodes
          .filter(
            (node) =>
              node.nodeType === "scene" &&
              node.id !== scene.id &&
              node.storyTimeOrder != null &&
              cmpKeys(node.storyTimeOrder, currentScene.storyTimeOrder!) < 0 &&
              Boolean(node.synopsis?.trim()),
          )
          .sort((left, right) =>
            cmpKeys(right.storyTimeOrder!, left.storyTimeOrder!),
          )[0]
      : undefined;
  const storyTimePreviousScene =
    previousStoryNode?.synopsis &&
    previousStoryNode.id !== previousReadingNode?.id
      ? {
          title: previousStoryNode.title,
          synopsis: previousStoryNode.synopsis,
          storyTimeLabel: previousStoryNode.storyTimeLabel ?? null,
        }
      : undefined;

  let pinnedSnippets: PinnedSnippetContext[] = [];
  let pinnedStickies: PinnedStickyContext[] = [];
  if (request.sessionId) {
    try {
      const snippets = await deps.listPinnedSnippets(request.sessionId);
      pinnedSnippets = snippets.map((snippet) => ({
        id: snippet.id,
        title: snippet.title,
        content: extractPlainText(snippet.content) || snippet.title,
      }));
    } catch {
      pinnedSnippets = [];
    }
    try {
      const stickies = await deps.listPinnedStickies(request.sessionId);
      pinnedStickies = stickies.map((sticky) => ({
        id: sticky.id,
        title: sticky.title,
        content: sticky.content,
      }));
    } catch {
      pinnedStickies = [];
    }
  }

  let mapBoardMarkdown: string | undefined;
  try {
    mapBoardMarkdown = await deps.loadMapBoardMarkdown(
      request,
      contextEligibleEntries,
    );
  } catch {
    mapBoardMarkdown = undefined;
  }

  let activeTabContent: BuildSystemPromptInput["activeTabContent"];
  try {
    if (request.activeTab?.contentType === "codex") {
      const entry = effectiveEntryById.get(request.activeTab.nodeId);
      const reason = allPinnedIds.has(request.activeTab.nodeId)
        ? "explicit-pin"
        : "active-tab";
      if (entry && canIncludeResolvedCodexContext(entry.contextMode, reason)) {
        activeTabContent = {
          type: "codex",
          title: entry.name,
          content: extractPlainText(entry.content) || entry.summary || "",
        };
      }
    } else if (request.activeTab?.contentType === "snippet") {
      const snippet = await deps.getSnippet(
        request.projectId,
        request.activeTab.nodeId,
      );
      if (snippet) {
        activeTabContent = {
          type: "snippet",
          title: snippet.title,
          content: extractPlainText(snippet.content) || snippet.title,
        };
      }
    }
  } catch {
    activeTabContent = undefined;
  }

  let conversationSummary: string | undefined;
  if (request.sessionId) {
    try {
      const summaries = await deps.listSummaries(request.sessionId);
      if (summaries.length > 0) {
        conversationSummary = summaries
          .map((summary) => summary.summary)
          .join("\n\n");
      }
    } catch {
      conversationSummary = undefined;
    }
  }
  deps.markStart(
    `buildSceneCtx.conversationTokenize.${request.messages.length}`,
  );
  const conversationTokens = request.messages
    .filter((message) => message.role !== "system")
    .reduce((sum, message) => sum + countTokens(message.content), 0);
  deps.markEnd(`buildSceneCtx.conversationTokenize.${request.messages.length}`);

  let pendingBeatsSection: string | undefined;
  if (request.settings.injectBeats) {
    let sceneDocJson: unknown = null;
    if (scene.contentJson) {
      try {
        sceneDocJson = JSON.parse(scene.contentJson);
      } catch {
        sceneDocJson = null;
      }
    }
    try {
      pendingBeatsSection = buildPendingBeatsSection({
        sceneDocJson,
        unplacedBeats: deps.getUnplacedBeats(scene.id),
        resolveCharacterName: (id) =>
          contextEligibleIds.has(id)
            ? (effectiveEntryById.get(id)?.name ?? null)
            : null,
        currentBeatId: null,
        scenePovCharacterId: currentScene?.povCharacterId ?? null,
      });
    } catch {
      pendingBeatsSection = undefined;
    }
  }

  const semanticQuery =
    request.settings.semanticRecallEnabled && request.outgoingUserMessage
      ? buildSemanticRecallQuery({
          userMessage: request.outgoingUserMessage,
          sceneBody: scene.content,
        })
      : "";
  const episodicQuery =
    request.settings.episodicRecallEnabled && request.outgoingUserMessage
      ? buildSemanticRecallQuery({
          userMessage: request.outgoingUserMessage,
          sceneBody: scene.content,
        })
      : "";
  deps.markStart("buildSceneCtx.fetchLabelsAndForeshadow");
  const [
    sceneLabelRows,
    sceneForeshadow,
    openForeshadows,
    semanticRecall,
    episodicRecall,
  ] = await Promise.all([
    deps.listNodeLabels(scene.id).catch(() => []),
    deps.getSceneForeshadow(scene.id).catch(() => EMPTY_FORESHADOW),
    deps.listOpenForeshadows(request.projectId).catch(() => []),
    semanticQuery
      ? deps
          .fetchSemanticRecall({
            projectId: request.projectId,
            query: semanticQuery,
            excludeSceneIds: [scene.id, ...request.mentionedSceneIds],
            hybrid: request.settings.hybridRecallEnabled,
          })
          .catch(() => [])
      : Promise.resolve([] as SemanticRecallChunk[]),
    episodicQuery
      ? deps
          .fetchChatRecall({
            projectId: request.projectId,
            query: episodicQuery,
            excludeSessionIds: request.sessionId ? [request.sessionId] : [],
            hybrid: request.settings.hybridRecallEnabled,
          })
          .catch(() => [])
      : Promise.resolve([] as ChatRecallMessage[]),
  ]);
  deps.markEnd("buildSceneCtx.fetchLabelsAndForeshadow");
  const sceneLabels = sceneLabelRows.map((label) => label.name);
  const sceneForeshadowInput: BuildSystemPromptInput["sceneForeshadow"] =
    sceneForeshadow.setups.length > 0 || sceneForeshadow.payoffs.length > 0
      ? {
          setups: sceneForeshadow.setups.map((setup) => ({
            title: setup.title,
            intent: setup.intent,
            derivedLabel: setup.derivedLabel,
            strength: setup.strength ?? null,
            excerpt: setup.excerpt ?? null,
          })),
          payoffs: sceneForeshadow.payoffs.map((payoff) => ({
            title: payoff.title,
            intent: payoff.intent,
            setupSceneTitle: payoff.setupSceneTitle,
            derivedLabel: payoff.derivedLabel,
            strength: payoff.strength ?? null,
            excerpt: payoff.excerpt ?? null,
          })),
        }
      : undefined;
  const openForeshadowsInput: BuildSystemPromptInput["openForeshadows"] =
    openForeshadows.length > 0
      ? openForeshadows.map((foreshadow) => ({
          title: foreshadow.title,
          intent: foreshadow.intent,
          loadBearing: foreshadow.loadBearing,
          setupCount: foreshadow.setupCount,
          derivedLabel: foreshadow.derivedLabel,
        }))
      : undefined;
  const mentionedScenes = await deps.loadMentionedScenes(
    request.projectId,
    request.mentionedSceneIds,
    scene.id,
  );

  let relationCodexEntries: CodexContext[] | undefined;
  let intraContextRelations: IntraContextRelationEdge[] | undefined;
  const l4SeedIds = new Set([
    ...codexEntries.map((entry) => entry.id),
    ...pinnedCodexEntries.map((entry) => entry.id),
  ]);
  if (l4SeedIds.size > 0) {
    const relations = await deps
      .listCodexRelations(request.projectId)
      .catch(() => []);
    const excludedRelationIds = new Set([
      ...l4SeedIds,
      ...collectBudgetedDescendantIds(l4SeedIds, contextEligibleEntries),
    ]);
    const expanded = expandCodexRelationsBFS(
      [...l4SeedIds],
      relations,
      contextEligibleEntries,
      excludedRelationIds,
      { maxDepth: 1 },
    );
    relationCodexEntries = expanded.length > 0 ? expanded : undefined;
    const intra = collectIntraContextRelations(
      [...l4SeedIds],
      relations,
      contextEligibleEntries,
    );
    intraContextRelations = intra.length > 0 ? intra : undefined;
  }

  let chronicleSnapshotText: string | undefined;
  if (request.settings.chronicleEnabled) {
    try {
      chronicleSnapshotText = await deps.buildChronicleSnapshot({
        request,
        language: project?.language ?? "ja",
        codexNames: new Map(
          contextEligibleEntries.map(
            (entry) => [entry.id, entry.name] as const,
          ),
        ),
        sceneCodexIds: codexEntries.map((entry) => entry.id),
        mentionedCodexIds: Array.from(
          new Set([
            ...request.mentionedCodexIds.filter((id) =>
              contextEligibleIds.has(id),
            ),
            ...pinnedCodexEntries.map((entry) => entry.id),
          ]),
        ),
      });
    } catch {
      chronicleSnapshotText = undefined;
    }
  }
  const plotThreadScenes = deps.buildPlotThreadScenes(
    request.projectId,
    scene.id,
  );

  const promptInput: BuildSystemPromptInput = {
    scene,
    contextTemporal,
    contextTemporalBySourceId,
    project: project ?? undefined,
    storySoFar: storySoFar || undefined,
    previousScene,
    codexEntries,
    pinnedCodexEntries,
    pinnedSnippets: pinnedSnippets.length > 0 ? pinnedSnippets : undefined,
    pinnedStickies: pinnedStickies.length > 0 ? pinnedStickies : undefined,
    mapBoardMarkdown,
    mapBoardId:
      request.map.enabled && mapBoardMarkdown
        ? (request.map.boardId ?? request.map.activeBoardId ?? undefined)
        : undefined,
    activeTabContent,
    commandInstruction: request.commandInstruction,
    conversationTokens,
    contextWindow: request.budget.contextWindow,
    maxOutputTokens: request.budget.maxOutputTokens,
    outputReservationTokens: request.budget.responseReservationTokens,
    deliveryMode: request.budget.deliveryMode,
    conversationSummary,
    pendingBeatsSection,
    sceneLabels: sceneLabels.length > 0 ? sceneLabels : undefined,
    sceneForeshadow: sceneForeshadowInput,
    openForeshadows: openForeshadowsInput,
    storyTimePreviousScene,
    projectOutline: project?.outline ?? undefined,
    chapterOutlines: chapterOutlines.length > 0 ? chapterOutlines : undefined,
    mentionedScenes: mentionedScenes.length > 0 ? mentionedScenes : undefined,
    lang: project?.language ?? "ja",
    agentMode: request.mode === "agent",
    customChatInstruction: request.settings.customChatInstruction,
    sessionStableCodexIds: [...request.sessionStableCodexIds],
    sessionStableContextInitialized:
      request.sessionStableContextInitialized === true,
    contextDecisions,
    alwaysEntryIds: alwaysEntryIdsForPrompt,
    noteEntries: notes.length > 0 ? notes : undefined,
    alwaysNoteIds:
      alwaysNotes.length > 0 ? alwaysNotes.map((note) => note.id) : undefined,
    relationCodexEntries,
    intraContextRelations,
    semanticRecall:
      semanticRecall.length > 0
        ? semanticRecall.map((chunk) => ({
            sceneTitle: chunk.sceneTitle,
            chunkText: chunk.chunkText,
          }))
        : undefined,
    chatRecall:
      episodicRecall.length > 0
        ? episodicRecall.map((message) => ({
            label: message.label,
            text: message.text,
          }))
        : undefined,
    plotThreadScenes,
    chronicleSnapshotText,
  };
  const stableCodexIds = [
    ...allPinnedIds,
    ...pinnedCodexEntries.flatMap((entry) => [
      entry.id,
      ...(entry.children?.map((child) => child.id) ?? []),
    ]),
    ...rawCodexEntries.map((entry) => entry.id),
    ...notes.map((note) => note.id),
    ...pinnedSnippets.map((snippet) => snippet.id),
    ...pinnedStickies.map((sticky) => sticky.id),
    ...(mapBoardMarkdown
      ? [request.map.boardId ?? request.map.activeBoardId ?? "active-board"]
      : []),
    ...(relationCodexEntries?.map((entry) => entry.id) ?? []),
  ];
  const recalledMessages: RecalledMessageForPromotion[] = episodicRecall.map(
    (message) => ({ messageId: message.messageId, text: message.text }),
  );
  return {
    scene,
    project,
    promptInput,
    detectedEntries,
    alwaysEntries,
    stableCodexIds: [...new Set(stableCodexIds)],
    projectOutline: project?.outline?.trim() ? project.outline : undefined,
    chapterOutlines,
    recalledMessages,
  };
}
