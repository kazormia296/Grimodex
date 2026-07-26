import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import type {
  CodexContextEntry,
  CodexContextMetadataEntry,
} from "@/features/codex/api";
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
  canExposeResolvedCodexIdentity,
  canIncludeResolvedCodexContext,
  materializeResolvedCodexContext,
  resolveCodexContexts,
} from "@/features/codex/context/resolvedCodexContext";
import {
  getDescendantsBFS,
  getChildrenFromArray,
  computeChildrenTokenBudget,
  collectBudgetedDescendantIds,
} from "@/features/codex/childrenBudget";
import { detailValueToPlainText } from "@/features/codex/detailCleanup";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { extractCodexSemanticLinks } from "@/features/codex/semanticLinks";
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
  ContextDiagnostic,
  RequiredSceneContext,
  RecalledMessageForPromotion,
} from "../contextPlannerDeps";
import type { SceneTurnContextRequest } from "../turnContextRequest";
import {
  orderEntriesByIds,
  stripCodexContent,
  toCodexContextIndexEntries,
  uniqueIds,
  type CodexContextIndexEntry,
  type CodexNameLookupEntry,
} from "./codexContextIndex";

export interface SceneContextSourceDeps {
  listCodexEntries: (projectId: string) => Promise<CodexContextEntry[]>;
  listCodexContextMetadata: (
    projectId: string,
  ) => Promise<CodexContextMetadataEntry[]>;
  listCodexEntriesByIds: (
    projectId: string,
    ids: readonly string[],
  ) => Promise<CodexContextEntry[]>;
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
    entries: CodexNameLookupEntry[],
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

interface OptionalSourceDescriptor {
  source: string;
  code: string;
  message: string;
}

interface OptionalSourceResult<T> {
  value: T;
  diagnostic?: ContextDiagnostic;
}

async function collectOptionalSource<T>(
  descriptor: OptionalSourceDescriptor,
  load: () => Promise<T>,
  fallback: T,
): Promise<OptionalSourceResult<T>> {
  const startedAt = Date.now();
  try {
    return { value: await load() };
  } catch (cause) {
    return {
      value: fallback,
      diagnostic: {
        ...descriptor,
        severity: "warning",
        latencyMs: Date.now() - startedAt,
        cause,
      },
    };
  }
}

function appendOptionalDiagnostic<T>(
  diagnostics: ContextDiagnostic[],
  result: OptionalSourceResult<T>,
): T {
  if (result.diagnostic) diagnostics.push(result.diagnostic);
  return result.value;
}

export function createSceneContextSourceDeps(
  overrides: Partial<SceneContextSourceDeps> = {},
): SceneContextSourceDeps {
  const deps: SceneContextSourceDeps = {
    listCodexEntries: async () => [],
    listCodexContextMetadata: async () => [],
    listCodexEntriesByIds: async () => [],
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
  if (!overrides.listCodexContextMetadata) {
    deps.listCodexContextMetadata = async (projectId) =>
      (await deps.listCodexEntries(projectId)).map(stripCodexContent);
  }
  if (!overrides.listCodexEntriesByIds) {
    deps.listCodexEntriesByIds = async (projectId, ids) =>
      orderEntriesByIds(ids, await deps.listCodexEntries(projectId));
  }
  return deps;
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
  allEntries: readonly CodexNameLookupEntry[],
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
  const budget = computeChildrenTokenBudget(preset, l4Budget);
  if (budget <= 0) return undefined;
  const lines: string[] = [];
  let usedTokens = 0;
  for (const descendant of getDescendantsBFS(entry.id, allEntries)) {
    if (excludeIds?.has(descendant.id)) continue;
    const resolved = resolvedById?.get(descendant.id);
    const mode = resolved?.contextMode ?? descendant.contextMode;
    if (!canExposeResolvedCodexIdentity(mode, "child")) continue;

    const resolvedSummary = resolved ? resolved.summary : descendant.summary;
    const resolvedContent = resolved ? resolved.content : descendant.content;
    const summary =
      resolvedSummary?.trim() || extractPlainText(resolvedContent) || "";
    const line =
      canIncludeResolvedCodexContext(mode, "child") && summary
        ? `  - ${descendant.name}: ${summary}`
        : `  - ${descendant.name} (${descendant.type}; id: ${descendant.id})`;
    const lineTokens = countTokens(line);
    if (usedTokens + lineTokens > budget) break;
    lines.push(line);
    usedTokens += lineTokens;
  }
  return lines.join("\n") || undefined;
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
  const diagnostics: ContextDiagnostic[] = [];
  const snapshot = request.sourceSnapshot;
  const scene = {
    ...snapshot.scene,
    content: request.includeBodies ? snapshot.scene.content : "",
  };
  const declaredSemanticLinks = request.includeBodies
    ? extractCodexSemanticLinks(snapshot.scene.contentJson)
    : [];
  const project = snapshot.project;
  const prefetchedEntries = snapshot.prefetchedCodexEntries
    ? [...snapshot.prefetchedCodexEntries]
    : null;
  const allMetadata = prefetchedEntries
    ? prefetchedEntries.map(stripCodexContent)
    : await deps.listCodexContextMetadata(request.projectId);
  if (allMetadata.some((entry) => entry.projectId !== request.projectId)) {
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
  type TemporalMetadata = NonNullable<
    BuildSystemPromptInput["contextTemporal"]
  >;
  const contextTemporal: TemporalMetadata = { asOfSceneId: request.sceneId };
  const indexEntries = toCodexContextIndexEntries(allMetadata);
  const { resolved: resolvedIndexById } = await resolveEntriesForContext(
    indexEntries,
    temporalAnchor,
    request,
    deps,
  );
  const effectiveIndexEntries: CodexContextIndexEntry[] = indexEntries.map(
    (entry) => {
      const resolved = resolvedIndexById.get(entry.id);
      return resolved
        ? materializeResolvedCodexContext(entry, resolved)
        : entry;
    },
  );
  const effectiveIndexById = new Map(
    effectiveIndexEntries.map((entry) => [entry.id, entry] as const),
  );
  const indexContextTemporalBySourceId: Record<string, TemporalMetadata> = {};
  for (const entry of effectiveIndexEntries) {
    const resolved = resolvedIndexById.get(entry.id);
    indexContextTemporalBySourceId[entry.id] = {
      ...contextTemporal,
      ...(resolved?.axisUsed ? { axis: resolved.axisUsed } : {}),
      ...(resolved?.activePhaseId ? { phaseId: resolved.activePhaseId } : {}),
      ...(resolved?.fallbackReason
        ? { fallbackReason: resolved.fallbackReason }
        : {}),
    };
  }

  // Pins are a selection trigger, not a source of prompt data. Resolve their
  // current entry first, then apply the explicit-pin exception for suppress.
  const pinnedFromDb = request.sessionId
    ? await deps.listPinnedCodex(request.sessionId)
    : [];
  const manualPinnedFromDb = pinnedFromDb.filter(
    (entry) => entry.pinSource !== "chat_mention",
  );
  const allPinnedIds = new Set(manualPinnedFromDb.map((entry) => entry.id));
  const contextDecisions = [...allPinnedIds].flatMap<ContextDecision>((id) => {
    const entry = effectiveIndexById.get(id);
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
  const visiblePinnedIds = new Set(
    [...allPinnedIds].filter((id) => {
      const entry = effectiveIndexById.get(id);
      return entry
        ? canIncludeResolvedCodexContext(entry.contextMode, "explicit-pin")
        : false;
    }),
  );
  const excludedAutoIds = new Set(request.excludedAutoEntryIds);
  const manualDirectChildIds = new Set(
    manualPinnedFromDb.flatMap((pin) => {
      const parent = effectiveIndexById.get(pin.id);
      if (
        !pin.withChildren ||
        !parent ||
        !canIncludeResolvedCodexContext(parent.contextMode, "explicit-pin")
      ) {
        return [];
      }
      return getChildrenFromArray(pin.id, effectiveIndexEntries)
        .filter((child) => !allPinnedIds.has(child.id))
        .filter((child) =>
          canIncludeResolvedCodexContext(child.contextMode, "explicit-pin"),
        )
        .map((child) => child.id);
    }),
  );
  const childIdentityEligibleIndexEntries = effectiveIndexEntries.filter(
    (entry) =>
      !excludedAutoIds.has(entry.id) &&
      canExposeResolvedCodexIdentity(entry.contextMode, "child"),
  );
  const childIdentityEligibleIds = new Set(
    childIdentityEligibleIndexEntries.map((entry) => entry.id),
  );
  const childContentEligibleIds = new Set(
    childIdentityEligibleIndexEntries
      .filter((entry) =>
        canIncludeResolvedCodexContext(entry.contextMode, "child"),
      )
      .map((entry) => entry.id),
  );
  const relationIdentityEligibleIndexEntries = effectiveIndexEntries.filter(
    (entry) =>
      !excludedAutoIds.has(entry.id) &&
      canExposeResolvedCodexIdentity(entry.contextMode, "relation"),
  );
  const relationIdentityEligibleIds = new Set(
    relationIdentityEligibleIndexEntries.map((entry) => entry.id),
  );
  const detailIdentityEligibleIndexEntries = effectiveIndexEntries.filter(
    (entry) =>
      !excludedAutoIds.has(entry.id) &&
      canExposeResolvedCodexIdentity(entry.contextMode, "detail-reference"),
  );
  const detailIdentityEligibleIds = new Set(
    detailIdentityEligibleIndexEntries.map((entry) => entry.id),
  );
  const mapIdentityEligibleIndexEntries = effectiveIndexEntries.filter(
    (entry) =>
      !excludedAutoIds.has(entry.id) &&
      canExposeResolvedCodexIdentity(entry.contextMode, "map-reference"),
  );
  const detectableCodex = effectiveIndexEntries.filter(
    (entry) =>
      !excludedAutoIds.has(entry.id) &&
      canIncludeResolvedCodexContext(entry.contextMode, "current-mention"),
  );
  const alwaysCodexIndex = effectiveIndexEntries.filter(
    (entry) => entry.contextMode === "always" && !excludedAutoIds.has(entry.id),
  );
  const detectableNotes = noteNodes.filter((node) => {
    const mode = node.contextMode ?? "mentioned";
    return canIncludeResolvedCodexContext(mode, "current-mention");
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
  const mentionText = [scene.content, request.outgoingUserMessage].join("\n");
  deps.markStart("buildSceneCtx.findMentionedEntriesAsync");
  const matchedMentions = await deps.findMentionedEntries(
    mentionText,
    matchTargets,
  );
  const structuredMentionIds = new Set([
    ...request.mentionedCodexIds,
    ...request.inputPinnedEntryIds,
    ...declaredSemanticLinks.map((link) => link.entryId),
  ]);
  const mentionedAll = Array.from(
    new Map(
      [
        ...matchedMentions,
        ...matchTargets.filter((target) => structuredMentionIds.has(target.id)),
      ].map((entry) => [entry.id, entry] as const),
    ).values(),
  );
  deps.markEnd("buildSceneCtx.findMentionedEntriesAsync");
  const mentionedIndex = mentionedAll
    .filter((entry) => entry.type !== "note" && !excludedAutoIds.has(entry.id))
    .map((entry) => effectiveIndexById.get(entry.id))
    .filter((entry): entry is CodexContextIndexEntry => entry !== undefined)
    .filter((entry) =>
      canIncludeResolvedCodexContext(entry.contextMode, "current-mention"),
    );
  const eligibleSemanticLinks: NonNullable<
    BuildSystemPromptInput["scene"]["semanticLinks"]
  > = declaredSemanticLinks.flatMap((link) => {
    const entry = effectiveIndexById.get(link.entryId);
    if (
      !entry ||
      excludedAutoIds.has(entry.id) ||
      !canIncludeResolvedCodexContext(entry.contextMode, "current-mention")
    ) {
      return [];
    }
    return [
      {
        entryId: entry.id,
        entryName: entry.name,
        text: link.text,
      },
    ];
  });
  const mentionedNotes = mentionedAll.filter((entry) => entry.type === "note");
  const mentionedIds = new Set(mentionedIndex.map((entry) => entry.id));
  const alwaysNotMentionedIndex = alwaysCodexIndex.filter(
    (entry) => !mentionedIds.has(entry.id),
  );
  const rawCodexIds = stableSortEntries([
    ...mentionedIndex,
    ...alwaysNotMentionedIndex,
  ]).map((entry) => entry.id);
  const l4SeedIds = new Set([...rawCodexIds, ...visiblePinnedIds]);
  const relationTraversalEntries = effectiveIndexEntries.filter(
    (entry) =>
      l4SeedIds.has(entry.id) || relationIdentityEligibleIds.has(entry.id),
  );
  const childTraversalEntries = effectiveIndexEntries.filter(
    (entry) =>
      l4SeedIds.has(entry.id) || childIdentityEligibleIds.has(entry.id),
  );
  const detailReferenceEntries = effectiveIndexEntries.filter(
    (entry) =>
      l4SeedIds.has(entry.id) ||
      manualDirectChildIds.has(entry.id) ||
      detailIdentityEligibleIds.has(entry.id),
  );
  const contextEligibleIds = new Set(
    relationTraversalEntries.map((entry) => entry.id),
  );
  const relationContextIds = new Set<string>();
  let relations: CodexRelationRow[] = [];
  let relationCodexEntries: CodexContext[] | undefined;
  let intraContextRelations: IntraContextRelationEdge[] | undefined;
  if (l4SeedIds.size > 0) {
    relations = appendOptionalDiagnostic(
      diagnostics,
      await collectOptionalSource<CodexRelationRow[]>(
        {
          source: "codex-relations",
          code: "CODEX_RELATIONS_UNAVAILABLE",
          message: "Codex relations are unavailable; continuing without them.",
        },
        () => deps.listCodexRelations(request.projectId),
        [],
      ),
    );
    const excludedRelationIds = new Set([
      ...l4SeedIds,
      ...collectBudgetedDescendantIds(l4SeedIds, childTraversalEntries),
    ]);
    for (const context of expandCodexRelationsBFS(
      [...l4SeedIds],
      relations,
      relationTraversalEntries,
      excludedRelationIds,
      { maxDepth: 1 },
    )) {
      relationContextIds.add(context.id);
    }
  }

  const activeTabCodexId =
    request.activeTab?.contentType === "codex"
      ? request.activeTab.nodeId
      : null;
  const activeTabIndexEntry = activeTabCodexId
    ? effectiveIndexById.get(activeTabCodexId)
    : undefined;
  const activeTabReason =
    activeTabCodexId &&
    (allPinnedIds.has(activeTabCodexId) ||
      manualDirectChildIds.has(activeTabCodexId))
      ? "explicit-pin"
      : "active-tab";
  const visibleActiveTabCodexId =
    activeTabCodexId &&
    activeTabIndexEntry &&
    (activeTabReason === "explicit-pin" ||
      !excludedAutoIds.has(activeTabCodexId)) &&
    canIncludeResolvedCodexContext(
      activeTabIndexEntry.contextMode,
      activeTabReason,
    )
      ? activeTabCodexId
      : null;
  const contentSeedIds = uniqueIds([
    ...rawCodexIds,
    ...visiblePinnedIds,
    ...manualDirectChildIds,
    ...relationContextIds,
    ...(visibleActiveTabCodexId ? [visibleActiveTabCodexId] : []),
    ...[
      ...collectBudgetedDescendantIds(
        [...rawCodexIds, ...visiblePinnedIds],
        childTraversalEntries,
      ),
    ].filter((id) => childContentEligibleIds.has(id)),
  ]);
  const loadedEntries = prefetchedEntries
    ? orderEntriesByIds(contentSeedIds, prefetchedEntries)
    : await deps.listCodexEntriesByIds(request.projectId, contentSeedIds);
  if (loadedEntries.some((entry) => entry.projectId !== request.projectId)) {
    throw new Error("scene context source returned a foreign-project row");
  }
  const { resolved: resolvedById, phases: phasesByEntry } =
    await resolveEntriesForContext(
      loadedEntries,
      temporalAnchor,
      request,
      deps,
    );
  const effectiveEntries = loadedEntries.map((entry) => {
    const resolved = resolvedById.get(entry.id);
    return resolved ? materializeResolvedCodexContext(entry, resolved) : entry;
  });
  const contextTemporalBySourceId = indexContextTemporalBySourceId;
  const effectiveEntryById = new Map(
    effectiveEntries.map((entry) => [entry.id, entry]),
  );
  const automaticChildEntries = childTraversalEntries.map(
    (entry) => effectiveEntryById.get(entry.id) ?? entry,
  );
  const rawCodexEntries = stableSortEntries(
    rawCodexIds
      .map((id) => effectiveEntryById.get(id))
      .filter((entry): entry is CodexContextEntry => entry !== undefined),
  );

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
      automaticChildEntries,
      l4Budget,
      allPinnedIds,
      resolvedById,
    );
    return childrenContext ? { ...context, childrenContext } : context;
  });
  deps.markStart("buildSceneCtx.enrichWithCustomDetails");
  const enrichedCodexEntries = await enrichWithCustomDetails(
    withChildren,
    detailReferenceEntries,
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
    const directChildren = withChildren
      ? getChildrenFromArray(entry.id, effectiveEntries)
          .filter((child) => !allPinnedIds.has(child.id))
          .filter((child) =>
            canIncludeResolvedCodexContext(child.contextMode, "explicit-pin"),
          )
      : [];
    const children = directChildren.map<CodexContext>((child) => {
      const aliases = parseAliases(child.aliases);
      const tags = parseTags(child.tagsCache);
      const childResolved = resolvedById.get(child.id);
      const childPhases = phasesByEntry.get(child.id) ?? [];
      const childActivePhase = childResolved?.activePhaseId
        ? childPhases.find((phase) => phase.id === childResolved.activePhaseId)
        : undefined;
      return {
        id: child.id,
        type: child.type,
        name: child.name,
        summary: child.summary ?? "",
        fullContent: extractPlainText(child.content) || undefined,
        ...(aliases ? { aliases } : {}),
        ...(tags ? { tags } : {}),
        ...(childActivePhase ? { phaseLabel: childActivePhase.label } : {}),
      };
    });
    const automaticChildExclusions = new Set([
      ...allPinnedIds,
      ...directChildren.map((child) => child.id),
    ]);
    const childrenContext = buildChildrenContextForEntry(
      entry,
      automaticChildEntries,
      l4Budget,
      automaticChildExclusions,
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
      children: withChildren ? children : undefined,
      ...(aliases ? { aliases } : {}),
      ...(tags ? { tags } : {}),
      ...(childrenContext ? { childrenContext } : {}),
      ...(activePhase ? { phaseLabel: activePhase.label } : {}),
    };
  };
  let pinnedCodexEntries: PinnedCodexContext[] = manualPinnedFromDb.flatMap(
    (pin) => {
      const entry = effectiveEntryById.get(pin.id);
      if (!entry) return [];
      const context = buildPinnedContext(entry, pin.withChildren);
      return context ? [context] : [];
    },
  );
  const pinnedContextsToEnrich = pinnedCodexEntries.flatMap<CodexContext>(
    (pinned) => [pinned, ...(pinned.children ?? [])],
  );
  const enrichedPinnedContexts = await enrichWithCustomDetails(
    pinnedContextsToEnrich,
    detailReferenceEntries,
    resolvedById,
    deps,
  );
  const enrichedPinnedById = new Map(
    enrichedPinnedContexts.map((entry) => [entry.id, entry] as const),
  );
  pinnedCodexEntries = pinnedCodexEntries.map((pinned) => ({
    ...(enrichedPinnedById.get(pinned.id) ?? pinned),
    withChildren: pinned.withChildren,
    children: pinned.children?.map(
      (child) => enrichedPinnedById.get(child.id) ?? child,
    ),
  }));
  const pinnedIds = new Set(pinnedCodexEntries.map((entry) => entry.id));
  const explicitPinnedIds = new Set([...pinnedIds, ...manualDirectChildIds]);
  const detectedEntries = mentionedIndex
    .filter((entry) => !explicitPinnedIds.has(entry.id))
    .map((entry) => effectiveEntryById.get(entry.id))
    .filter((entry): entry is CodexContextEntry => entry !== undefined);
  const alwaysEntries = alwaysCodexIndex
    .filter(
      (entry) =>
        !explicitPinnedIds.has(entry.id) && !mentionedIds.has(entry.id),
    )
    .map((entry) => effectiveEntryById.get(entry.id))
    .filter((entry): entry is CodexContextEntry => entry !== undefined);
  // UI lists deduplicate mentioned-vs-always, but priority is semantic. An
  // effective always entry remains always even when its name also matched.
  const alwaysEntryIdsForPrompt = alwaysCodexIndex
    .filter((entry) => !explicitPinnedIds.has(entry.id))
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
    const snippets = appendOptionalDiagnostic(
      diagnostics,
      await collectOptionalSource<PinnedSnippetEntryWithData[]>(
        {
          source: "pinned-snippets",
          code: "PINNED_SNIPPETS_UNAVAILABLE",
          message: "Pinned snippets are unavailable; continuing without them.",
        },
        () => deps.listPinnedSnippets(request.sessionId!),
        [],
      ),
    );
    pinnedSnippets = snippets.map((snippet) => ({
      id: snippet.id,
      title: snippet.title,
      content: extractPlainText(snippet.content) || snippet.title,
    }));

    const stickies = appendOptionalDiagnostic(
      diagnostics,
      await collectOptionalSource<PinnedStickyEntryWithData[]>(
        {
          source: "pinned-stickies",
          code: "PINNED_STICKIES_UNAVAILABLE",
          message: "Pinned stickies are unavailable; continuing without them.",
        },
        () => deps.listPinnedStickies(request.sessionId!),
        [],
      ),
    );
    pinnedStickies = stickies.map((sticky) => ({
      id: sticky.id,
      title: sticky.title,
      content: sticky.content,
    }));
  }

  const mapBoardMarkdown = appendOptionalDiagnostic(
    diagnostics,
    await collectOptionalSource<string | undefined>(
      {
        source: "map",
        code: "MAP_CONTEXT_UNAVAILABLE",
        message: "Map context is unavailable; continuing without it.",
      },
      () => deps.loadMapBoardMarkdown(request, mapIdentityEligibleIndexEntries),
      undefined,
    ),
  );

  let activeTabContent: BuildSystemPromptInput["activeTabContent"];
  try {
    if (request.activeTab?.contentType === "codex") {
      const entry = effectiveEntryById.get(request.activeTab.nodeId);
      const reason =
        allPinnedIds.has(request.activeTab.nodeId) ||
        manualDirectChildIds.has(request.activeTab.nodeId)
          ? "explicit-pin"
          : "active-tab";
      if (
        entry &&
        (reason === "explicit-pin" ||
          !excludedAutoIds.has(request.activeTab.nodeId)) &&
        canIncludeResolvedCodexContext(entry.contextMode, reason)
      ) {
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
  } catch (cause) {
    activeTabContent = undefined;
    diagnostics.push({
      source: "active-tab",
      severity: "warning",
      code: "ACTIVE_TAB_CONTEXT_UNAVAILABLE",
      message: "Active-tab context is unavailable; continuing without it.",
      cause,
    });
  }

  let conversationSummary: string | undefined;
  if (request.sessionId) {
    const summaries = appendOptionalDiagnostic(
      diagnostics,
      await collectOptionalSource<ChatSummary[]>(
        {
          source: "conversation-summaries",
          code: "CONVERSATION_SUMMARIES_UNAVAILABLE",
          message:
            "Conversation summaries are unavailable; continuing without them.",
        },
        () => deps.listSummaries(request.sessionId!),
        [],
      ),
    );
    if (summaries.length > 0) {
      conversationSummary = summaries
        .map((summary) => summary.summary)
        .join("\n\n");
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
            ? (effectiveIndexById.get(id)?.name ?? null)
            : null,
        currentBeatId: null,
        scenePovCharacterId: currentScene?.povCharacterId ?? null,
      });
    } catch (cause) {
      pendingBeatsSection = undefined;
      diagnostics.push({
        source: "pending-beats",
        severity: "warning",
        code: "PENDING_BEATS_UNAVAILABLE",
        message: "Pending beats are unavailable; continuing without them.",
        cause,
      });
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
    sceneLabelResult,
    sceneForeshadowResult,
    openForeshadowResult,
    semanticRecallResult,
    episodicRecallResult,
  ] = await Promise.all([
    collectOptionalSource<Label[]>(
      {
        source: "scene-labels",
        code: "SCENE_LABELS_UNAVAILABLE",
        message: "Scene labels are unavailable; continuing without them.",
      },
      () => deps.listNodeLabels(scene.id),
      [],
    ),
    collectOptionalSource<SceneForeshadowContext>(
      {
        source: "scene-foreshadow",
        code: "SCENE_FORESHADOW_UNAVAILABLE",
        message: "Scene foreshadow is unavailable; continuing without it.",
      },
      () => deps.getSceneForeshadow(scene.id),
      EMPTY_FORESHADOW,
    ),
    collectOptionalSource<OpenForeshadowForContext[]>(
      {
        source: "open-foreshadows",
        code: "OPEN_FORESHADOWS_UNAVAILABLE",
        message: "Open foreshadows are unavailable; continuing without them.",
      },
      () => deps.listOpenForeshadows(request.projectId),
      [],
    ),
    semanticQuery
      ? collectOptionalSource<SemanticRecallChunk[]>(
          {
            source: "semantic-recall",
            code: "SEMANTIC_RECALL_UNAVAILABLE",
            message: "Semantic recall is unavailable; continuing without it.",
          },
          () =>
            deps.fetchSemanticRecall({
              projectId: request.projectId,
              query: semanticQuery,
              excludeSceneIds: [scene.id, ...request.mentionedSceneIds],
              hybrid: request.settings.hybridRecallEnabled,
            }),
          [],
        )
      : Promise.resolve({ value: [] as SemanticRecallChunk[] }),
    episodicQuery
      ? collectOptionalSource<ChatRecallMessage[]>(
          {
            source: "episodic-recall",
            code: "EPISODIC_RECALL_UNAVAILABLE",
            message: "Episodic recall is unavailable; continuing without it.",
          },
          () =>
            deps.fetchChatRecall({
              projectId: request.projectId,
              query: episodicQuery,
              excludeSessionIds: request.sessionId ? [request.sessionId] : [],
              hybrid: request.settings.hybridRecallEnabled,
            }),
          [],
        )
      : Promise.resolve({ value: [] as ChatRecallMessage[] }),
  ]);
  const sceneLabelRows = appendOptionalDiagnostic(
    diagnostics,
    sceneLabelResult,
  );
  const sceneForeshadow = appendOptionalDiagnostic(
    diagnostics,
    sceneForeshadowResult,
  );
  const openForeshadows = appendOptionalDiagnostic(
    diagnostics,
    openForeshadowResult,
  );
  const semanticRecall = appendOptionalDiagnostic(
    diagnostics,
    semanticRecallResult,
  );
  const episodicRecall = appendOptionalDiagnostic(
    diagnostics,
    episodicRecallResult,
  );
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

  if (l4SeedIds.size > 0) {
    const relationExpansionEntries = relationTraversalEntries.map(
      (entry) => effectiveEntryById.get(entry.id) ?? entry,
    );
    const excludedRelationIds = new Set([
      ...l4SeedIds,
      ...collectBudgetedDescendantIds(l4SeedIds, childTraversalEntries),
    ]);
    const expanded = expandCodexRelationsBFS(
      [...l4SeedIds],
      relations,
      relationExpansionEntries,
      excludedRelationIds,
      { maxDepth: 1 },
    );
    relationCodexEntries = expanded.length > 0 ? expanded : undefined;
    const intra = collectIntraContextRelations(
      [...l4SeedIds],
      relations,
      relationTraversalEntries,
    );
    intraContextRelations = intra.length > 0 ? intra : undefined;
  }

  let chronicleSnapshotText: string | undefined;
  if (request.settings.chronicleEnabled) {
    chronicleSnapshotText = appendOptionalDiagnostic(
      diagnostics,
      await collectOptionalSource<string | undefined>(
        {
          source: "chronicle",
          code: "CHRONICLE_CONTEXT_UNAVAILABLE",
          message: "Chronicle context is unavailable; continuing without it.",
        },
        () =>
          deps.buildChronicleSnapshot({
            request,
            language: project?.language ?? "ja",
            codexNames: new Map(
              relationTraversalEntries.map(
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
          }),
        undefined,
      ),
    );
  }
  const plotThreadScenes = deps.buildPlotThreadScenes(
    request.projectId,
    scene.id,
  );
  const sceneWithSemanticLinks = {
    ...scene,
    semanticLinks:
      eligibleSemanticLinks.length > 0 ? eligibleSemanticLinks : undefined,
  };

  const promptInput: BuildSystemPromptInput = {
    scene: sceneWithSemanticLinks,
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
    scene: sceneWithSemanticLinks,
    project,
    promptInput,
    detectedEntries,
    alwaysEntries,
    stableCodexIds: [...new Set(stableCodexIds)],
    projectOutline: project?.outline?.trim() ? project.outline : undefined,
    chapterOutlines,
    recalledMessages,
    diagnostics,
  };
}
