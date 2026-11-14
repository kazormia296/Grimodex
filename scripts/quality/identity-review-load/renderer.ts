// 同定の review の負荷の測定（identity-review-load）の renderer entry。
// AI は呼ばない（startCodexStructureExtraction は useAi:false 固定）。
// window.identityLoad.* の戻り値は「件数・ID・hash（sha256 先頭 16 桁）」だけで、
// 原稿の本文・題・表記の文字列・引用を返さない。
// このファイルは tsc の対象外（scripts/）で、Vite が評価時に直接読み込む。
import { generateNKeysBetween } from "fractional-indexing";
import { invoke } from "@/lib/tauri";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { setCurrentRuntimeProjectId } from "@/runtime/projectIdentity";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { createProject, listProjects } from "@/features/project/api";
import {
  getCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import { createNode, listNodes, loadSceneContent } from "@/features/tree/api";
import {
  getDescendantScenesInOrder,
  useTreeStore,
} from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { prosemirrorToText } from "@/lib/prosemirror";
import { captureMutationAuthority } from "@/features/concurrency/mutationAuthority";
import { createCodexEntry, listCodexEntries } from "@/features/codex/api";
import { listCodexTypes } from "@/features/codex/typeApi";
import { listCodexRelations } from "@/features/codex/codexRelationApi";
import {
  buildCodexStructureCatalogs,
  startCodexStructureExtraction,
} from "@/features/codex/codexStructureExtractionApi";
import { isSafeForCodexEntityBulkApprove } from "@/features/codex/codexStructureExtractionStore";
import { buildExistingRelationCatalog } from "@/features/codex/extraction/existingRelationMatcher";
import { runEntityCandidatePrepass } from "@/features/codex/extraction/entityCandidatePrepass";
import { buildProjectNarrativeSnapshot } from "@/application/narrative-extraction/projectSnapshotAdapter";
import { derivePersistedNarrativeSceneScope } from "@/application/narrative-extraction/projectSnapshotAdapter";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import {
  planExtractionWindows,
  type WindowPlan,
} from "@/features/chronicle/extraction/windowPlanner";
import type {
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
} from "@/features/narrative-extraction/source/types";
import {
  countTextMismatches,
  crossSetCounts,
  expectedSceneText,
  hashSurface,
  planNestedFolders,
  scenesFromWork,
  summarizeCandidateInventory,
  summarizeSeedInventory,
} from "./lib.mjs";

interface WorkJson {
  scenes: { index: number; paragraphs: string[] }[];
}

interface Active {
  projectId: string;
  workKey: string;
  sceneIds: string[]; // scenes JSON の並び
  folderIds: Record<string, string>; // "25" | "50" | "75" | "100"
  expectedTexts: string[];
  sceneIdByIndexKey: Map<string, number>;
}
let openRevision = 0;
let active: Active | null = null;

function requireActive(): Active {
  if (!active) throw new Error("[precheck] no prepared work");
  return active;
}

/** workspace を開き、project を作る（製品の作成画面と同じく Scene Scope の既定は main-line）。 */
async function openProject(input: {
  workspacePath: string;
  projectId: string;
  title: string;
  language: string;
}) {
  await invoke("open_workspace", { path: input.workspacePath });
  setCurrentWorkspaceIdentity({
    path: input.workspacePath,
    openRevision: ++openRevision,
  });
  publishCurrentProjectId(input.projectId);
  setCurrentRuntimeProjectId(input.projectId);
  await createProject(
    { id: input.projectId, title: input.title, language: input.language },
    { sceneScopeDefault: "main-line" },
  );
  useProjectStore.setState({
    currentProjectId: input.projectId,
    projects: await listProjects(),
  });
  usePhaseStore.setState({ resolutionMode: "reading" });
  return { language: input.language };
}

/**
 * (a)(b) scenes JSON から、入れ子 folder（F25⊂F50⊂F75⊂F100）に場面を置いた project を作る。
 * 1 段落 = 1 paragraph。作成した本文と scenes JSON の一致を検査し、不一致は件数で返す。
 */
async function buildNestedWork(input: {
  projectId: string;
  workKey: string;
  work: WorkJson;
}) {
  const projectId = input.projectId;
  const scenes = scenesFromWork(input.work);
  const plan = planNestedFolders(scenes.length);
  const folderIds: Record<string, string> = {};
  for (const folder of plan.folders)
    folderIds[String(folder.percent)] = `${input.workKey}-f${folder.percent}`;
  const sceneIds = scenes.map(
    (scene) => `${input.workKey}-s${String(scene.index).padStart(3, "0")}`,
  );

  // root：F100 だけ。
  const rootKey = generateNKeysBetween(null, null, 1)[0];
  await createNode({
    id: folderIds["100"],
    projectId,
    nodeType: "folder",
    title: "F100",
    sortOrder: rootKey,
    parentId: null,
  });
  // 外側から内側へ（親が先に在る順）。F(k) の子は [F(k-1)（先頭）, ...追加の場面]。
  for (let i = plan.folders.length - 1; i >= 0; i--) {
    const folder = plan.folders[i];
    const childCount =
      (folder.childFolderPercent === null ? 0 : 1) +
      folder.addedSceneIndexes.length;
    const keys = generateNKeysBetween(null, null, childCount);
    let k = 0;
    if (folder.childFolderPercent !== null) {
      await createNode({
        id: folderIds[String(folder.childFolderPercent)],
        projectId,
        nodeType: "folder",
        title: `F${folder.childFolderPercent}`,
        sortOrder: keys[k++],
        parentId: folderIds[String(folder.percent)],
      });
    }
    for (const sceneIndex of folder.addedSceneIndexes) {
      const scene = scenes[sceneIndex];
      const content = JSON.stringify({
        type: "doc",
        content: scene.paragraphs.map((text) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        })),
      });
      await createNode({
        id: sceneIds[sceneIndex],
        projectId,
        nodeType: "scene",
        title: `S${scene.index}`,
        sortOrder: keys[k++],
        parentId: folderIds[String(folder.percent)],
        content,
      });
    }
  }
  const nodes = await listNodes(projectId);
  const identity = getCurrentWorkspaceIdentity();
  await useTreeStore
    .getState()
    .reloadTreeOrThrow(projectId, identity?.openRevision ?? openRevision);

  // 本文の一致検査（件数だけ返す）。
  const expectedTexts = scenes.map((scene) =>
    expectedSceneText(scene.paragraphs),
  );
  const actualTexts: string[] = [];
  for (const id of sceneIds)
    actualTexts.push(prosemirrorToText(await loadSceneContent(id)));
  const text = countTextMismatches(expectedTexts, actualTexts);

  // folder ごとの場面の列が期待どおりか（derivePersistedNarrativeSceneScope と treeStore の両方）。
  const folderChecks: Record<string, unknown> = {};
  for (const folder of plan.folders) {
    const expected = sceneIds.slice(0, folder.cumulativeSceneCount);
    const derived = derivePersistedNarrativeSceneScope(
      nodes,
      folderIds[String(folder.percent)],
    );
    const viaStore = getDescendantScenesInOrder(
      useTreeStore.getState().nodes,
      folderIds[String(folder.percent)],
    ).map((n) => n.id);
    folderChecks[`F${folder.percent}`] = {
      expectedSceneCount: expected.length,
      derivedOk: derived.ok,
      derivedMatches:
        derived.ok &&
        derived.sceneIds.length === expected.length &&
        derived.sceneIds.every((id, i) => id === expected[i]),
      storeMatches:
        viaStore.length === expected.length &&
        viaStore.every((id, i) => id === expected[i]),
    };
  }

  active = {
    projectId,
    workKey: input.workKey,
    sceneIds,
    folderIds,
    expectedTexts,
    sceneIdByIndexKey: new Map(sceneIds.map((id, i) => [id, i])),
  };
  return {
    workKey: input.workKey,
    sceneCount: scenes.length,
    paragraphCount: scenes.reduce((acc, s) => acc + s.paragraphs.length, 0),
    nodeCount: nodes.length,
    folderSceneCounts: plan.counts,
    text,
    folderChecks,
  };
}

/** (c) 名簿の Entry を登録する（IME の書出しは予約しない）。この段では空の名簿のまま呼ばない。 */
async function registerRoster(input: {
  projectId: string;
  entries: {
    id: string;
    type: string;
    name: string;
    aliases?: string[];
    readings?: string[];
  }[];
}) {
  let created = 0;
  for (const entry of input.entries) {
    await createCodexEntry(
      {
        id: entry.id,
        projectId: input.projectId,
        type: entry.type,
        name: entry.name,
        aliases: entry.aliases?.length ? JSON.stringify(entry.aliases) : null,
        readings: entry.readings?.length
          ? JSON.stringify(entry.readings)
          : null,
      },
      { suppressImeExport: true },
    );
    created++;
  }
  return { created };
}

/** 製品の dialog と同じ request の組み方で catalog を作る。 */
async function buildCatalogRequest(projectId: string) {
  const entries = await listCodexEntries(projectId);
  const projectTypes = await listCodexTypes(projectId);
  const catalogs = buildCodexStructureCatalogs({
    entries: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      aliases: entry.aliases,
      type: entry.type,
      version: entry.version,
    })),
    projectTypes,
  });
  const existingRelations = buildExistingRelationCatalog(
    (await listCodexRelations(projectId)).map((row) => ({
      id: row.id,
      fromCodexId: row.fromCodexId,
      toCodexId: row.toCodexId,
      relationType: row.relationType,
      directionality:
        row.directionality === "symmetric" ? "symmetric" : "directed",
      label: row.label,
      inverseLabel: row.inverseLabel,
      semanticKey: row.semanticKey,
      version: row.version,
    })),
  );
  return {
    existingEntries: catalogs.existingCatalog,
    typeCatalog: catalogs.typeCatalog,
    existingRelations,
    entryCount: entries.length,
    typeCount: projectTypes.length,
  };
}

function tally<T>(rows: readonly T[], key: (row: T) => string) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/** (d) startCodexStructureExtraction（useAi:false）を指定 folder に対して呼び、projection を件数で返す。 */
async function extractStructure(input: {
  folderPercent: number;
  /** false：Native への Run/ProposalSet の保存を飛ばす（製品の test seam。live の projection だけ読む）。 */
  persist: boolean;
}) {
  const a = requireActive();
  const folderId = a.folderIds[String(input.folderPercent)];
  if (!folderId) throw new Error("[precheck] unknown folder percent");
  const projectId = a.projectId;
  const workspace = getCurrentWorkspaceIdentity();
  if (!workspace) throw new Error("[precheck] no workspace identity");
  const sceneNodes = getDescendantScenesInOrder(
    useTreeStore.getState().nodes,
    folderId,
  );
  if (sceneNodes.length === 0) throw new Error("[precheck] empty folder");
  const authority = captureMutationAuthority(projectId, getCurrentProjectId);
  const catalog = await buildCatalogRequest(projectId);
  const startedAt = performance.now();
  const projection = await startCodexStructureExtraction({
    projectId,
    folderId,
    sceneIds: sceneNodes.map((scene) => scene.id),
    authority,
    workspacePath: workspace.path,
    openRevision: workspace.openRevision,
    useAi: false,
    ...(input.persist ? {} : { skipNativePersist: true }),
    existingEntries: catalog.existingEntries,
    typeCatalog: catalog.typeCatalog,
    existingRelations: catalog.existingRelations,
  });
  const durationMs = performance.now() - startedAt;

  const rows = [];
  for (const proposal of projection.proposals) {
    const payload = proposal.proposal.payload;
    const binding = payload.binding;
    rows.push({
      surfaceHash: await hashSurface(proposal.displayTitle),
      bindingKind: binding.kind,
      candidateCount:
        binding.kind === "unresolved" ? binding.candidates.length : 0,
      allowCreateNew:
        binding.kind === "unresolved" ? binding.allowCreateNew : null,
      blocked: proposal.applicability === "blocked",
      bulkApprovable: isSafeForCodexEntityBulkApprove(proposal.safety),
      typeStatus: payload.typeResolution.status,
      form: proposal.safety.explicitProperName ? "proper-name" : "alias",
      evidenceCount: proposal.evidence.length,
    });
  }
  return {
    folderPercent: input.folderPercent,
    persisted: input.persist,
    sceneCount: sceneNodes.length,
    durationMs,
    runStatus: projection.status,
    entryCountInCatalog: catalog.entryCount,
    typeCountInCatalog: catalog.typeCount,
    entityProposalCount: projection.proposals.length,
    relationProposalCount: projection.relationProposals.length,
    baseDetailProposalCount: projection.baseDetailProposals.length,
    phaseProposalCount: projection.phaseProposals.length,
    coverage: {
      mode: projection.coverage.mode ?? null,
      documentCount: projection.coverage.documentCount ?? null,
      windowCount: projection.coverage.windowCount ?? null,
      gapCount: projection.coverage.gaps?.length ?? 0,
    },
    counts: {
      bindingKind: tally(rows, (r) => r.bindingKind),
      typeStatus: tally(rows, (r) => r.typeStatus),
      form: tally(rows, (r) => r.form),
      blocked: rows.filter((r) => r.blocked).length,
      bulkApprovable: rows.filter((r) => r.bulkApprovable).length,
      unresolvedWithCandidates: rows.filter(
        (r) => r.bindingKind === "unresolved" && r.candidateCount > 0,
      ).length,
      candidateTotal: rows.reduce((acc, r) => acc + r.candidateCount, 0),
      withoutEvidence: rows.filter((r) => r.evidenceCount === 0).length,
    },
    rows,
  };
}

/** 製品の buildSourceViewsForPlan と同じ（非 export のため写し）。 */
async function buildSourceViewsForPlan(
  snapshot: NarrativeCorpusSnapshot,
  plan: WindowPlan,
): Promise<NarrativeSourceView[]> {
  const documentByRef = new Map(
    snapshot.documents.map((document) => [document.ref, document] as const),
  );
  const views: NarrativeSourceView[] = [];
  for (const window of plan.windows) {
    const document = documentByRef.get(window.documentRef);
    if (!document) continue;
    const ranges = [...window.ownedRanges, ...window.contextRanges];
    views.push(
      await buildNarrativeSourceView({
        ref: window.sourceRef,
        document,
        documentRange: {
          start: Math.min(...ranges.map((range) => range.start)),
          end: Math.max(...ranges.map((range) => range.end)),
        },
      }),
    );
  }
  return views;
}

/**
 * (e) 0 回目の目録。AI なし。
 * - seed：製品と同じ prepass の入口（snapshot → window → source view → prepass。最小出現 1）
 * - 候補画面の候補：extract_codex_candidates を IPC で直接（ラッパは失敗を [] に潰す）
 * 戻り値は件数と、表記ごとの hash・出現数だけ。
 */
async function inventory(input: { folderPercent: number }) {
  const a = requireActive();
  const folderId = a.folderIds[String(input.folderPercent)];
  const projectId = a.projectId;
  const sceneNodes = getDescendantScenesInOrder(
    useTreeStore.getState().nodes,
    folderId,
  );
  const authority = captureMutationAuthority(projectId, getCurrentProjectId);
  const snapshotResult = await buildProjectNarrativeSnapshot({
    projectId,
    folderId,
    language: "ja",
    sceneIds: sceneNodes.map((scene) => scene.id),
    authority,
  });
  if (!snapshotResult.ok) {
    return {
      seed: {
        status: "snapshot-failed",
        diagnostics: snapshotResult.diagnostics.map((d) => String(d.code)),
      },
    };
  }
  const snapshot = snapshotResult.snapshot;
  const windowPlan = planExtractionWindows(snapshot);
  const sourceViews = await buildSourceViewsForPlan(snapshot, windowPlan);
  let seedSection: Record<string, unknown>;
  let seedRows: {
    surfaceHash: string;
    occurrenceCount: number;
    sceneCount: number;
    properName: boolean;
  }[] = [];
  let seedSurfaces: string[] = [];
  try {
    const prepass = await runEntityCandidatePrepass({
      snapshot,
      sourceViews,
      minimumOccurrenceCount: 1,
      createEvidenceAnchorId: () => crypto.randomUUID(),
    });
    const sceneOfDocument = new Map<string, string>();
    for (const document of snapshot.documents) {
      if (document.origin.kind === "project-node")
        sceneOfDocument.set(document.ref, document.origin.nodeId);
    }
    const seeds = prepass.status === "complete" ? prepass.seeds : [];
    const mapped = seeds.map((seed) => ({
      surface: seed.surface as string,
      occurrenceCount: seed.occurrences.length as number,
      sceneIds: seed.occurrences.map(
        (o) => sceneOfDocument.get(o.documentRef) ?? "unknown",
      ) as string[],
      appearsAsProperName: Boolean(seed.features.appearsAsProperName),
    }));
    seedSurfaces = mapped.map((m) => m.surface);
    seedRows = await Promise.all(
      mapped.map(async (m) => ({
        surfaceHash: await hashSurface(m.surface),
        occurrenceCount: m.occurrenceCount,
        sceneCount: new Set(m.sceneIds).size,
        properName: m.appearsAsProperName,
      })),
    );
    seedSection = {
      status: prepass.status,
      sourceViewCount: sourceViews.length,
      windowCount: windowPlan.windows.length,
      documentCount: snapshot.documents.length,
      rejectionCount: prepass.rejections.length,
      ...summarizeSeedInventory(mapped),
    };
  } catch (error) {
    seedSection = {
      status: "prepass-threw",
      errorName: error instanceof Error ? error.name : "unknown",
    };
  }

  // 候補画面の候補：IPC を直接。minCount は既定（null → Rust 側の既定）と 1 の両方。
  const candidateSections: Record<string, unknown> = {};
  let defaultCandidateSurfaces: string[] = [];
  let candidateRows: { surfaceHash: string; count: number }[] = [];
  for (const [label, minCount] of [
    ["default", null],
    ["min1", 1],
  ] as const) {
    try {
      const raw = (await invoke("extract_codex_candidates", {
        projectId,
        minCount,
      })) as { surface: string; count: number }[];
      candidateSections[label] = {
        status: "ok",
        ...summarizeCandidateInventory(raw),
      };
      if (label === "default") {
        defaultCandidateSurfaces = raw.map((c) => c.surface);
        candidateRows = await Promise.all(
          raw.map(async (c) => ({
            surfaceHash: await hashSurface(c.surface),
            count: c.count,
          })),
        );
      }
    } catch (error) {
      candidateSections[label] = {
        status: "failed",
        errorName: error instanceof Error ? error.name : "unknown",
      };
    }
  }
  return {
    folderPercent: input.folderPercent,
    sceneCount: sceneNodes.length,
    seed: seedSection,
    candidates: candidateSections,
    seedVsCandidateDefault: crossSetCounts(
      seedSurfaces,
      defaultCandidateSurfaces,
    ),
    seedRows,
    candidateRows,
  };
}

Object.assign(window, {
  identityLoad: {
    openProject,
    buildNestedWork,
    registerRoster,
    extractStructure,
    inventory,
    ready: true,
  },
});
