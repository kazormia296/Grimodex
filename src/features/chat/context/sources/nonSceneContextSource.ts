import type { CodexContextEntry, CodexEntry } from "@/features/codex/api";
import type { ContextDecision } from "@/features/ai-context/types";
import type {
  CodexEntryPhase,
  CodexPhaseDetailOverride,
} from "@/features/codex/phaseApi";
import type {
  PhaseResolutionMode,
  ResolvedCodexState,
  SceneTimeIndex,
  TemporalAnchor,
} from "@/features/codex/phaseResolver";
import { formatTimelineContext } from "@/features/codex/phaseResolver";
import {
  canIncludeResolvedCodexContext,
  materializeResolvedCodexContext,
  resolveCodexContexts,
} from "@/features/codex/context/resolvedCodexContext";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import {
  buildChildrenContext,
  computeChildrenTokenBudget,
  getChildrenFromArray,
  getDescendantsBFS,
} from "@/features/codex/childrenBudget";
import { detailValueToPlainText } from "@/features/codex/detailCleanup";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import {
  findReverseMentioningEntries,
  getEntryScanText,
} from "@/features/codex/codexCrossMentions";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import type { CodexRelationRow } from "@/features/codex/codexRelationApi";
import { expandCodexRelationsBFS } from "@/features/codex/relationExpansion";
import {
  getAllProjectScenesInOrder,
  getAncestorFolders,
  getDescendantScenesInOrder,
  type TreeNodeData,
} from "@/features/tree/treeStore";
import type { Snippet } from "@/features/snippets/api";
import type {
  PinnedCodexEntryWithData,
  PinnedSnippetEntryWithData,
} from "../../chatApi";
import type {
  BuildSystemPromptInput,
  CodexContext,
  PinnedCodexContext,
  PinnedSnippetContext,
  ProjectContext,
} from "../../contextBuilder";
import type { NonSceneTurnContextRequest } from "../turnContextRequest";

export type NonSceneScopeAnchor =
  | { kind: "codex"; id: string; name: string }
  | { kind: "snippet"; id: string; title: string };

export interface NonSceneContextCollection {
  promptInput: BuildSystemPromptInput;
  detectedEntries: CodexContextEntry[];
  alwaysEntries: CodexContextEntry[];
  scopeAnchor: NonSceneScopeAnchor | null;
  projectOutline: string | undefined;
  chapterOutlines: Array<{ title: string; outline: string }>;
}

export interface AggregatedSceneInput {
  anchorId: string;
  anchorTitle: string;
  descendants: TreeNodeData[];
  includeBodies: boolean;
  activeSceneId: string | null;
  prefacePolicy: "folder" | "project";
  allEntries: CodexContextEntry[];
  /** Mention-only candidates; always entries remain available for derived labels. */
  detectableEntries: CodexContextEntry[];
  allNodes?: TreeNodeData[];
  agentMode: boolean;
  injectBeats: boolean;
}

export interface AggregatedSceneResult {
  aggregatedScene: { id: string; title: string; content: string };
  aggregatedDetected: CodexContextEntry[];
}

export interface CodexScopeBlocks {
  selectedPinned: PinnedCodexContext;
  relatedMentioned: CodexContextEntry[];
  relationExpanded: CodexContext[];
}

export interface NonSceneContextSourceDeps {
  fetchProjectContext: (projectId: string) => Promise<ProjectContext | null>;
  listCodexEntries: (projectId: string) => Promise<CodexContextEntry[]>;
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
  findMentionedEntries: (
    text: string,
    entries: CodexMatchTarget[],
  ) => Promise<CodexMatchTarget[]>;
  listCodexRelations: (projectId: string) => Promise<CodexRelationRow[]>;
  loadMentionedScenes: (
    projectId: string,
    ids: readonly string[],
  ) => Promise<Array<{ id: string; title: string; content: string }>>;
  getSnippet: (
    projectId: string,
    snippetId: string,
  ) => Promise<Snippet | undefined>;
  buildAggregatedScene: (
    input: AggregatedSceneInput,
  ) => Promise<AggregatedSceneResult | null>;
  listPinnedCodex: (sessionId: string) => Promise<PinnedCodexEntryWithData[]>;
  listPinnedSnippets: (
    sessionId: string,
  ) => Promise<PinnedSnippetEntryWithData[]>;
  listContextDetails: (entryIds: string[]) => Promise<
    Array<{
      entryId: string;
      definitionId: string;
      fieldName: string;
      fieldType: string;
      value: string | null;
    }>
  >;
  loadMapBoardMarkdown: (
    request: NonSceneTurnContextRequest,
    entries: CodexContextEntry[],
  ) => Promise<string | undefined>;
}

export function createNonSceneContextSourceDeps(
  overrides: Partial<NonSceneContextSourceDeps> = {},
): NonSceneContextSourceDeps {
  return {
    fetchProjectContext: async () => null,
    listCodexEntries: async () => [],
    getTemporalResolution: () => ({
      sceneTimeIndex: buildSceneTimeIndex([]),
      resolutionMode: "reading",
    }),
    listPhases: async () => [],
    listPhaseDetailOverrides: async () => [],
    listRawDetailValues: async () => [],
    findMentionedEntries: async () => [],
    listCodexRelations: async () => [],
    loadMentionedScenes: async () => [],
    getSnippet: async () => undefined,
    buildAggregatedScene: async () => null,
    listPinnedCodex: async () => [],
    listPinnedSnippets: async () => [],
    listContextDetails: async () => [],
    loadMapBoardMarkdown: async () => undefined,
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

function stableSortById<T extends { id: string }>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        left.entry.id.localeCompare(right.entry.id) || left.index - right.index,
    )
    .map(({ entry }) => entry);
}

function buildChildrenCtxForEntry(
  entry: Pick<CodexEntry, "id" | "childrenBudget">,
  allEntries: CodexContextEntry[],
  l4Budget: number,
  excludeIds?: Set<string>,
  resolvedById?: ReadonlyMap<string, ResolvedCodexState>,
): string | undefined {
  const preset = entry.childrenBudget ?? "compact";
  if (preset === "none") return undefined;
  const budget = computeChildrenTokenBudget(preset, l4Budget);
  const descendants = getDescendantsBFS(entry.id, allEntries).filter(
    (descendant) =>
      !excludeIds?.has(descendant.id) &&
      canIncludeResolvedCodexContext(descendant.contextMode, "derived"),
  );
  return buildChildrenContext(descendants, budget, resolvedById) || undefined;
}

async function enrichWithCustomDetails<T extends CodexContext>(
  entries: T[],
  allEntries: CodexContextEntry[],
  resolvedById: ReadonlyMap<string, ResolvedCodexState>,
  deps: NonSceneContextSourceDeps,
): Promise<T[]> {
  if (entries.length === 0) return entries;
  const details = await deps.listContextDetails(
    entries.map((entry) => entry.id),
  );
  const byEntryId = new Map<
    string,
    Array<{ fieldName: string; value: string }>
  >();
  for (const detail of details) {
    const resolvedValue = resolvedById
      .get(detail.entryId)
      ?.detailValues.get(detail.definitionId);
    // null is an explicit phase clear; only undefined falls back to Base.
    const effectiveValue =
      resolvedValue === undefined ? detail.value : resolvedValue;
    if (effectiveValue == null) continue;
    const value =
      detail.fieldType === "codex_reference"
        ? (allEntries.find((entry) => entry.id === effectiveValue)?.name ?? "")
        : detailValueToPlainText(effectiveValue);
    if (!value.trim()) continue;
    const values = byEntryId.get(detail.entryId) ?? [];
    values.push({ fieldName: detail.fieldName, value });
    byEntryId.set(detail.entryId, values);
  }
  return entries.map((entry) => {
    const customDetails = byEntryId.get(entry.id);
    return customDetails?.length ? { ...entry, customDetails } : entry;
  });
}

async function resolveEntriesForContext(
  entries: CodexContextEntry[],
  anchor: TemporalAnchor,
  request: NonSceneTurnContextRequest,
  deps: NonSceneContextSourceDeps,
) {
  const entryIds = entries.map((entry) => entry.id);
  const phases = entryIds.length > 0 ? await deps.listPhases(entryIds) : [];
  const overrides =
    phases.length > 0
      ? await deps.listPhaseDetailOverrides(phases.map((phase) => phase.id))
      : [];
  const rawDetails =
    entryIds.length > 0 ? await deps.listRawDetailValues(entryIds) : [];
  const baseDetailsByEntry = new Map<string, Map<string, string | null>>();
  for (const detail of rawDetails) {
    const values = baseDetailsByEntry.get(detail.entryId) ?? new Map();
    values.set(detail.definitionId, detail.value);
    baseDetailsByEntry.set(detail.entryId, values);
  }
  const { sceneTimeIndex, resolutionMode } = deps.getTemporalResolution(
    request.projectId,
  );
  return {
    ...resolveCodexContexts({
      entries,
      phases,
      phaseDetailOverrides: overrides,
      baseDetailsByEntry,
      anchor,
      sceneTimeIndex,
      resolutionMode,
    }),
    resolutionMode,
  };
}

async function buildResolvedCodexScopeBlocks(input: {
  request: NonSceneTurnContextRequest;
  selectedEntryId: string;
  effectiveEntries: CodexContextEntry[];
  mentionEligibleEntries: CodexContextEntry[];
  derivedEligibleEntries: CodexContextEntry[];
  resolvedById: ReadonlyMap<string, ResolvedCodexState>;
  phasesByEntry: ReadonlyMap<string, CodexEntryPhase[]>;
  lang?: string | null;
  deps: NonSceneContextSourceDeps;
}): Promise<CodexScopeBlocks | null> {
  const {
    request,
    selectedEntryId,
    effectiveEntries,
    mentionEligibleEntries,
    derivedEligibleEntries,
    resolvedById,
    phasesByEntry,
    lang,
    deps,
  } = input;
  const selected = effectiveEntries.find(
    (entry) => entry.id === selectedEntryId,
  );
  if (
    !selected ||
    !canIncludeResolvedCodexContext(selected.contextMode, "explicit-pin")
  ) {
    return null;
  }
  const resolved = resolvedById.get(selected.id);
  if (!resolved) return null;

  const phases = phasesByEntry.get(selected.id) ?? [];
  const phaseById = new Map(phases.map((phase) => [phase.id, phase] as const));
  const appliedPhases = resolved.appliedPhaseIds.flatMap((phaseId) => {
    const phase = phaseById.get(phaseId);
    return phase ? [phase] : [];
  });
  const timelinePhases = appliedPhases.map((phase) => ({
    label: phase.label,
    anchorTitle:
      request.sourceSnapshot.treeNodes.find(
        (node) => node.id === phase.anchorNodeId,
      )?.title ??
      phase.anchorNodeId ??
      "",
    summaryOverride: phase.summaryOverride,
  }));
  const finalContent = extractPlainText(selected.content) || "";
  const timelineText =
    timelinePhases.length > 0
      ? formatTimelineContext(
          {
            name: selected.name,
            type: selected.type,
            summary: selected.summary,
          },
          timelinePhases,
          resolved,
          lang,
        )
      : "";
  const childrenContext = buildChildrenCtxForEntry(
    selected,
    effectiveEntries,
    60_000,
    new Set([selected.id]),
    resolvedById,
  );
  const aliases = parseAliases(selected.aliases);
  const tags = parseTags(selected.tagsCache);
  const activePhase = resolved.activePhaseId
    ? phaseById.get(resolved.activePhaseId)
    : undefined;
  let selectedPinned: PinnedCodexContext = {
    id: selected.id,
    type: selected.type,
    name: selected.name,
    summary: selected.summary ?? "",
    fullContent:
      [finalContent, timelineText].filter(Boolean).join("\n\n") || undefined,
    withChildren: false,
    ...(aliases ? { aliases } : {}),
    ...(tags ? { tags } : {}),
    ...(childrenContext ? { childrenContext } : {}),
    ...(activePhase ? { phaseLabel: activePhase.label } : {}),
  };
  selectedPinned = (
    await enrichWithCustomDetails(
      [selectedPinned],
      [selected, ...derivedEligibleEntries],
      resolvedById,
      deps,
    )
  )[0]!;

  const detectable = mentionEligibleEntries.filter(
    (entry) => entry.id !== selected.id,
  );
  const forwardMatched = await deps.findMentionedEntries(
    getEntryScanText(selected),
    detectable,
  );
  const reverseMatched = findReverseMentioningEntries(
    {
      id: selected.id,
      name: selected.name,
      type: selected.type,
      aliases: selected.aliases,
      excludedAliases: selected.excludedAliases,
    },
    detectable,
  );
  const effectiveById = new Map(
    effectiveEntries.map((entry) => [entry.id, entry] as const),
  );
  const relatedIds = new Set<string>();
  const relatedMentioned: CodexContextEntry[] = [];
  for (const match of [...forwardMatched, ...reverseMatched]) {
    if (match.id === selected.id || relatedIds.has(match.id)) continue;
    const entry = effectiveById.get(match.id);
    if (!entry || entry.contextMode !== "mentioned") continue;
    relatedIds.add(entry.id);
    relatedMentioned.push(entry);
  }

  const relations = await deps
    .listCodexRelations(request.projectId)
    .catch(() => []);
  const relationContexts = expandCodexRelationsBFS(
    [selected.id],
    relations,
    [selected, ...derivedEligibleEntries],
    new Set([selected.id, ...relatedIds]),
    { maxDepth: 1 },
  );
  const relationExpanded = await enrichWithCustomDetails(
    relationContexts,
    [selected, ...derivedEligibleEntries],
    resolvedById,
    deps,
  );

  return { selectedPinned, relatedMentioned, relationExpanded };
}

/**
 * Collect non-scene sources using only an immutable turn request and explicit
 * adapters. Rendering and Zustand mutation are deliberately left to the
 * planner/composition root.
 */
export async function collectNonSceneContext(
  request: NonSceneTurnContextRequest,
  deps: NonSceneContextSourceDeps,
): Promise<NonSceneContextCollection> {
  const mentionedScenes = await deps.loadMentionedScenes(
    request.projectId,
    request.mentionedSceneIds,
  );
  const allNodes = [...request.sourceSnapshot.treeNodes];
  const foreignNode = allNodes.find(
    (node) => node.projectId !== request.projectId,
  );
  if (foreignNode) {
    throw new Error(
      `non-scene context tree project mismatch: ${foreignNode.projectId}`,
    );
  }
  if (request.scope.kind === "folder") {
    const folderScope = request.scope;
    if (
      !allNodes.some(
        (node) =>
          node.id === folderScope.folderId && node.nodeType === "folder",
      )
    ) {
      throw new Error("required folder context anchor is unavailable");
    }
  }
  if (
    request.scope.kind === "thread" &&
    !request.sourceSnapshot.plotThreadIds.includes(request.scope.threadId)
  ) {
    throw new Error("required thread context anchor is unavailable");
  }
  const scopeOutlines: Array<{ title: string; outline: string }> = [];
  if (request.containerScope === "folder" && request.scopeAnchorId) {
    const anchor = allNodes.find((node) => node.id === request.scopeAnchorId);
    const ancestors = getAncestorFolders(allNodes, request.scopeAnchorId);
    const chain = anchor ? [anchor, ...ancestors] : ancestors;
    for (const folder of chain) {
      if (folder.nodeType === "folder" && folder.synopsis?.trim()) {
        scopeOutlines.push({
          title: folder.title,
          outline: folder.synopsis.trim(),
        });
      }
    }
    scopeOutlines.reverse();
  }

  const [project, allEntries] = await Promise.all([
    deps.fetchProjectContext(request.projectId),
    deps.listCodexEntries(request.projectId),
  ]);
  const foreignEntry = allEntries.find(
    (entry) => entry.projectId !== request.projectId,
  );
  if (foreignEntry) {
    throw new Error(
      `non-scene context project mismatch: ${foreignEntry.projectId}`,
    );
  }
  if (request.scope.kind === "codex") {
    const codexScope = request.scope;
    if (!allEntries.some((entry) => entry.id === codexScope.entryId)) {
      throw new Error("required codex context anchor is unavailable");
    }
  }

  const temporalAnchor: TemporalAnchor =
    request.scope.kind === "codex"
      ? { kind: "latest" }
      : request.activeSceneId.trim()
        ? { kind: "scene", sceneId: request.activeSceneId }
        : { kind: "base" };
  const resolvedContexts = await resolveEntriesForContext(
    allEntries,
    temporalAnchor,
    request,
    deps,
  );
  const effectiveEntries = allEntries.map((entry) => {
    const resolved = resolvedContexts.resolvedById.get(entry.id);
    return resolved ? materializeResolvedCodexContext(entry, resolved) : entry;
  });
  type TemporalMetadata = NonNullable<
    BuildSystemPromptInput["contextTemporal"]
  >;
  const contextTemporal: TemporalMetadata =
    temporalAnchor.kind === "scene"
      ? { asOfSceneId: temporalAnchor.sceneId }
      : { fallbackReason: temporalAnchor.kind };
  const contextTemporalBySourceId: Record<string, TemporalMetadata> = {};
  for (const entry of effectiveEntries) {
    const resolved = resolvedContexts.resolvedById.get(entry.id);
    contextTemporalBySourceId[entry.id] = {
      ...contextTemporal,
      ...(resolved?.axisUsed ? { axis: resolved.axisUsed } : {}),
      ...(resolved?.activePhaseId ? { phaseId: resolved.activePhaseId } : {}),
      ...(resolved?.fallbackReason
        ? { fallbackReason: resolved.fallbackReason }
        : {}),
    };
  }
  const mentionEligibleEntries = effectiveEntries.filter(
    (entry) => entry.contextMode === "mentioned",
  );
  const derivedEligibleEntries = effectiveEntries.filter((entry) =>
    canIncludeResolvedCodexContext(entry.contextMode, "derived"),
  );

  const codexBlocks =
    request.scope.kind === "codex"
      ? await buildResolvedCodexScopeBlocks({
          request,
          selectedEntryId: request.scope.entryId,
          effectiveEntries,
          mentionEligibleEntries,
          derivedEligibleEntries,
          resolvedById: resolvedContexts.resolvedById,
          phasesByEntry: resolvedContexts.phasesByEntry,
          lang: project?.language,
          deps,
        })
      : null;
  if (request.scope.kind === "codex" && !codexBlocks) {
    throw new Error("required codex context anchor is unavailable or hidden");
  }
  let snippetAnchor: Snippet | undefined;
  if (request.scope.kind === "snippet") {
    snippetAnchor = await deps.getSnippet(
      request.projectId,
      request.scope.snippetId,
    );
    if (!snippetAnchor) {
      throw new Error("required snippet context anchor is unavailable");
    }
  }
  if (request.projectId && !project) {
    throw new Error("required project context is unavailable");
  }

  let aggregatedScene: AggregatedSceneResult["aggregatedScene"] | null = null;
  let aggregatedDetected: CodexContextEntry[] = [];
  if (request.scope.kind === "thread") {
    const threadScope = request.scope;
    const memberIds = new Set(
      request.sourceSnapshot.plotThreadLinks
        .filter((link) => link.threadId === threadScope.threadId)
        .map((link) => link.nodeId),
    );
    const descendants = allNodes.filter(
      (node) => node.nodeType === "scene" && memberIds.has(node.id),
    );
    if (descendants.length > 0) {
      const result = await deps.buildAggregatedScene({
        anchorId: threadScope.threadId,
        anchorTitle: threadScope.title,
        descendants,
        includeBodies: true,
        activeSceneId: request.activeSceneId,
        prefacePolicy: "folder",
        allEntries: derivedEligibleEntries,
        detectableEntries: mentionEligibleEntries,
        agentMode: request.agentToolsAvailable,
        injectBeats: request.settings.injectBeats,
      });
      if (result) {
        aggregatedScene = result.aggregatedScene;
        aggregatedDetected = result.aggregatedDetected;
      }
    }
  } else if (request.scope.kind === "folder") {
    const folderScope = request.scope;
    const anchor = allNodes.find((node) => node.id === folderScope.folderId);
    if (anchor) {
      const result = await deps.buildAggregatedScene({
        anchorId: anchor.id,
        anchorTitle: anchor.title,
        descendants: getDescendantScenesInOrder(allNodes, anchor.id),
        includeBodies: request.includeBodies,
        activeSceneId: request.activeSceneId,
        prefacePolicy: "folder",
        allEntries: derivedEligibleEntries,
        detectableEntries: mentionEligibleEntries,
        agentMode: request.agentToolsAvailable,
        injectBeats: request.settings.injectBeats,
      });
      if (result) {
        aggregatedScene = result.aggregatedScene;
        aggregatedDetected = result.aggregatedDetected;
      }
    }
  } else if (request.scope.kind === "project") {
    const result = await deps.buildAggregatedScene({
      anchorId: request.projectId,
      anchorTitle: project?.title ?? "Project",
      descendants: getAllProjectScenesInOrder(allNodes),
      includeBodies: request.includeBodies,
      activeSceneId: request.activeSceneId,
      prefacePolicy: "project",
      allEntries: derivedEligibleEntries,
      detectableEntries: mentionEligibleEntries,
      allNodes,
      agentMode: request.agentToolsAvailable,
      injectBeats: request.settings.injectBeats,
    });
    if (result) {
      aggregatedScene = result.aggregatedScene;
      aggregatedDetected = result.aggregatedDetected;
    }
  }

  const excludedAutoIds = new Set(request.excludedAutoEntryIds);
  const globalAlwaysEntries = effectiveEntries.filter(
    (entry) => entry.contextMode === "always" && !excludedAutoIds.has(entry.id),
  );
  const l4Budget = 60_000;
  const pinnedFromDb = request.sessionId
    ? await deps.listPinnedCodex(request.sessionId)
    : [];
  const dbPinnedIds = new Set(pinnedFromDb.map((entry) => entry.id));
  const inputPinnedIds = request.inputPinnedEntryIds.filter(
    (id) => !dbPinnedIds.has(id),
  );
  const allPinnedIds = new Set([...dbPinnedIds, ...inputPinnedIds]);

  const contextDecisions = [...allPinnedIds].flatMap<ContextDecision>((id) => {
    const entry = effectiveEntries.find((candidate) => candidate.id === id);
    if (!entry) {
      return [
        {
          key: `codex:${id}`,
          status: "unavailable" as const,
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
          status: "excluded" as const,
          reason: `policy-${entry.contextMode}`,
          tokensBefore: 0,
          tokensAfter: 0,
        },
      ];
    }
    return [];
  });

  const effectiveById = new Map(
    effectiveEntries.map((entry) => [entry.id, entry] as const),
  );
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
    const childrenContext = buildChildrenCtxForEntry(
      entry,
      effectiveEntries,
      l4Budget,
      allPinnedIds,
      resolvedContexts.resolvedById,
    );
    const aliases = parseAliases(entry.aliases);
    const tags = parseTags(entry.tagsCache);
    const resolved = resolvedContexts.resolvedById.get(entry.id);
    const phases = resolvedContexts.phasesByEntry.get(entry.id) ?? [];
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

  let pinnedCodex = pinnedFromDb.flatMap((pin) => {
    const entry = effectiveById.get(pin.id);
    if (!entry) return [];
    const context = buildPinnedContext(entry, pin.withChildren);
    return context ? [context] : [];
  });
  const extraPinned = inputPinnedIds.flatMap((id) => {
    const entry = effectiveById.get(id);
    if (!entry) return [];
    const context = buildPinnedContext(entry, false);
    return context ? [context] : [];
  });
  pinnedCodex = [...pinnedCodex, ...extraPinned];

  let pinnedSnippets: PinnedSnippetContext[] = [];
  if (request.sessionId) {
    const snippetItems = await deps.listPinnedSnippets(request.sessionId);
    pinnedSnippets = snippetItems.map((snippet) => ({
      id: snippet.id,
      title: snippet.title,
      content: extractPlainText(snippet.content) || snippet.title,
    }));
  }
  if (snippetAnchor) {
    pinnedSnippets = pinnedSnippets.filter(
      (snippet) => snippet.id !== snippetAnchor?.id,
    );
  }

  const explicitlyVisibleIds = new Set([
    ...allPinnedIds,
    ...(codexBlocks?.selectedPinned ? [codexBlocks.selectedPinned.id] : []),
  ]);
  const detailReferenceEntries = effectiveEntries.filter(
    (entry) =>
      canIncludeResolvedCodexContext(entry.contextMode, "derived") ||
      (explicitlyVisibleIds.has(entry.id) &&
        canIncludeResolvedCodexContext(entry.contextMode, "explicit-pin")),
  );
  let mergedPinnedCodex = await enrichWithCustomDetails(
    pinnedCodex,
    detailReferenceEntries,
    resolvedContexts.resolvedById,
    deps,
  );
  if (codexBlocks?.selectedPinned) {
    mergedPinnedCodex = mergedPinnedCodex.filter(
      (entry) => entry.id !== codexBlocks.selectedPinned.id,
    );
  }
  const mergedPinnedIds = new Set(mergedPinnedCodex.map((entry) => entry.id));
  if (codexBlocks?.selectedPinned) {
    mergedPinnedIds.add(codexBlocks.selectedPinned.id);
  }

  const relatedNotPinned =
    codexBlocks?.relatedMentioned.filter(
      (entry) =>
        !mergedPinnedIds.has(entry.id) && !excludedAutoIds.has(entry.id),
    ) ?? [];
  const detectedNotPinned = stableSortById([
    ...aggregatedDetected.filter(
      (entry) =>
        !mergedPinnedIds.has(entry.id) && !excludedAutoIds.has(entry.id),
    ),
    ...relatedNotPinned,
  ]);
  const detectedIds = new Set(detectedNotPinned.map((entry) => entry.id));
  const alwaysNotDetected = stableSortById(
    globalAlwaysEntries.filter(
      (entry) => !mergedPinnedIds.has(entry.id) && !detectedIds.has(entry.id),
    ),
  );
  const baseGlobalCodexEntries: CodexContext[] = [
    ...detectedNotPinned,
    ...alwaysNotDetected,
  ].map((entry) => {
    const aliases = parseAliases(entry.aliases);
    const summary = entry.summary ?? "";
    const resolved = resolvedContexts.resolvedById.get(entry.id);
    const phases = resolvedContexts.phasesByEntry.get(entry.id) ?? [];
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
  });
  const globalWithChildren = baseGlobalCodexEntries.map((context) => {
    const entry = effectiveById.get(context.id);
    if (!entry) return context;
    const childrenContext = buildChildrenCtxForEntry(
      entry,
      effectiveEntries,
      l4Budget,
      allPinnedIds,
      resolvedContexts.resolvedById,
    );
    return childrenContext ? { ...context, childrenContext } : context;
  });
  const globalCodexEntries = await enrichWithCustomDetails(
    globalWithChildren,
    detailReferenceEntries,
    resolvedContexts.resolvedById,
    deps,
  );

  const mapBoardMarkdown = await deps.loadMapBoardMarkdown(
    request,
    detailReferenceEntries,
  );
  let focusSubject: BuildSystemPromptInput["focusSubject"];
  let scopeAnchor: NonSceneScopeAnchor | null = null;
  if (request.scope.kind === "thread") {
    focusSubject = {
      kind: "thread",
      name: request.scope.title,
      body: aggregatedScene?.content ?? "",
    };
  } else if (codexBlocks?.selectedPinned) {
    focusSubject = { kind: "codex", entry: codexBlocks.selectedPinned };
    scopeAnchor = {
      kind: "codex",
      id: codexBlocks.selectedPinned.id,
      name: codexBlocks.selectedPinned.name,
    };
  } else if (snippetAnchor) {
    focusSubject = {
      kind: "snippet",
      name: snippetAnchor.title,
      body: extractPlainText(snippetAnchor.content),
    };
    scopeAnchor = {
      kind: "snippet",
      id: snippetAnchor.id,
      title: snippetAnchor.title,
    };
  }

  return {
    promptInput: {
      scene:
        aggregatedScene && request.scope.kind !== "thread"
          ? aggregatedScene
          : { id: "", title: "", content: "" },
      project: project ?? undefined,
      codexEntries:
        globalCodexEntries.length > 0 ? globalCodexEntries : undefined,
      pinnedCodexEntries:
        mergedPinnedCodex.length > 0 ? mergedPinnedCodex : undefined,
      pinnedSnippets: pinnedSnippets.length > 0 ? pinnedSnippets : undefined,
      chapterOutlines: scopeOutlines.length > 0 ? scopeOutlines : undefined,
      mentionedScenes: mentionedScenes.length > 0 ? mentionedScenes : undefined,
      relationCodexEntries: codexBlocks?.relationExpanded.length
        ? codexBlocks.relationExpanded
        : undefined,
      alwaysEntryIds: globalAlwaysEntries.map((entry) => entry.id),
      contextTemporal,
      contextTemporalBySourceId,
      contextDecisions,
      sessionStableCodexIds: [...request.sessionStableCodexIds],
      sessionStableContextInitialized:
        request.sessionStableContextInitialized === true,
      focusSubject,
      lang: project?.language ?? "ja",
      mapBoardMarkdown,
      mapBoardId:
        request.map.enabled && mapBoardMarkdown
          ? (request.map.boardId ?? request.map.activeBoardId ?? undefined)
          : undefined,
    },
    detectedEntries: detectedNotPinned,
    alwaysEntries: alwaysNotDetected,
    scopeAnchor,
    projectOutline: project?.outline ?? undefined,
    chapterOutlines: scopeOutlines,
  };
}
