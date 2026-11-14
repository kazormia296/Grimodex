// 同定の review の負荷の測定（identity-review-load）の renderer entry。
// AI は呼ばない（startCodexStructureExtraction は useAi:false 固定）。
// window.identityLoad.* の戻り値は「件数・ID・hash（sha256 先頭 16 桁）」だけで、
// 原稿の本文・題・表記の文字列・引用を返さない。
// 範囲（records に書く）：workspace は製品の open lifecycle（workspaceOpenLifecycle）を通らず、
// open_workspace と setCurrentWorkspaceIdentity で開く（store の hydrate・lifecycle proof・
// quiescence lease は通らない）。(d) の live projection は保存なしの seam（skipNativePersist）で読む：
// 保存後の revisionId・application・restore 経路・永続化の時間は含まない。
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
import { kakuyomuBodyToProseMirror } from "@/features/import/kakuyomuMarkup";
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
  candidateKey,
  comparePersistedScene,
  compareHashSets,
  countBulkApprovable,
  countRubyNotations,
  crossSetCounts,
  expectedCanonicalText,
  hashSurface,
  isBulkApprovableRow,
  planNestedFolders,
  rubyBaseText,
  rubySurfaceRelation,
  seedMissingFromCandidates,
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
  /** 場面ごとの段落数（ルビ記法を親文字だけにした本文の段落）。 */
  paragraphCounts: number[];
  expectedCanonicalTexts: string[];
  /** ルビの親文字（candidateKey。重複を潰した集合）。ルビの付いた表記の seed／候補の突合に使う。 */
  rubyBaseKeys: string[];
  rubyNodeCount: number;
  sceneIndexById: Map<string, number>; // 1 始まりの場面 index
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
 * 1 段落 = 1 paragraph。段落は製品の取り込みと同じ変換（kakuyomuBodyToProseMirror）で
 * ProseMirror にする（`｜親文字《読み》` は ruby node）。変換の入力は段落ごと（段落の数は
 * 変わらない）。作成した本文と scenes JSON の一致（段落数・本文〔ルビは親文字を読む〕・
 * ruby node 数）を検査し、不一致は件数で返す。
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
      const blocks = scene.paragraphs.map((text) => {
        const converted = JSON.parse(kakuyomuBodyToProseMirror(text)) as {
          content?: unknown[];
        };
        if (converted.content?.length !== 1)
          throw new Error(
            "[artifact] PARAGRAPH_SPLIT markup conversion changed the paragraph count",
          );
        return converted.content[0];
      });
      const content = JSON.stringify({ type: "doc", content: blocks });
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

  // 本文の一致検査（件数だけ返す）。prosemirrorToText は ruby を落とすので使わない。
  let sceneMismatched = 0;
  let paragraphCountMismatched = 0;
  let textMismatched = 0;
  let rubyMismatched = 0;
  let rubyPairMismatched = 0;
  let rubyNodeCount = 0;
  const rubyBaseKeys = new Set<string>();
  for (let i = 0; i < sceneIds.length; i++) {
    const check = comparePersistedScene(
      scenes[i].paragraphs,
      await loadSceneContent(sceneIds[i]),
    );
    if (!check.paragraphCountOk) paragraphCountMismatched++;
    if (!check.textOk) textMismatched++;
    if (!check.rubyOk) rubyMismatched++;
    rubyPairMismatched += check.rubyPairMismatchCount;
    if (!(check.paragraphCountOk && check.textOk && check.rubyOk))
      sceneMismatched++;
    rubyNodeCount += check.rubyCount;
    for (const base of check.rubyBases) rubyBaseKeys.add(candidateKey(base));
  }
  const text = {
    expected: scenes.length,
    actual: sceneIds.length,
    mismatched: sceneMismatched,
    paragraphCountMismatched,
    textMismatched,
    rubyMismatched,
    // 親文字・読みの並びが期待と違う ruby の数（致命にしない。記録のみ）。
    rubyPairMismatched,
  };
  const allParagraphs = scenes.flatMap((scene) => scene.paragraphs);
  const ruby = {
    nodeCount: rubyNodeCount,
    notationCount: countRubyNotations(allParagraphs),
    distinctBaseCount: rubyBaseKeys.size,
    scenesWithRuby: scenes.filter(
      (scene) => countRubyNotations(scene.paragraphs) > 0,
    ).length,
  };

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
    paragraphCounts: scenes.map((scene) => scene.paragraphs.length),
    expectedCanonicalTexts: scenes.map((scene) =>
      expectedCanonicalText(scene.paragraphs.map(rubyBaseText)),
    ),
    rubyBaseKeys: [...rubyBaseKeys],
    rubyNodeCount,
    sceneIndexById: new Map(sceneIds.map((id, i) => [id, i + 1])),
  };
  return {
    workKey: input.workKey,
    sceneCount: scenes.length,
    paragraphCount: scenes.reduce((acc, s) => acc + s.paragraphs.length, 0),
    nodeCount: nodes.length,
    folderSceneCounts: plan.counts,
    text,
    ruby,
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

interface SeedMapped {
  surface: string;
  occurrenceCount: number;
  sceneIds: string[];
  appearsAsProperName: boolean;
}

/**
 * 製品と同じ prepass の入口（snapshot → window → source view → prepass。最小出現 1）で seed を読み、
 * 本文の突合（snapshot の canonical.text と、作った本文の期待値）も数える。
 * inventory と extractStructure の両方が、同じ process でこれを使う。
 */
async function readSeeds(a: Active, folderId: string, sceneIds: string[]) {
  const authority = captureMutationAuthority(a.projectId, getCurrentProjectId);
  const snapshotResult = await buildProjectNarrativeSnapshot({
    projectId: a.projectId,
    folderId,
    language: "ja",
    sceneIds,
    authority,
  });
  if (!snapshotResult.ok) {
    return {
      ok: false as const,
      diagnostics: snapshotResult.diagnostics.map((d) => String(d.code)),
    };
  }
  const snapshot = snapshotResult.snapshot;
  const windowPlan = planExtractionWindows(snapshot);
  const sourceViews = await buildSourceViewsForPlan(snapshot, windowPlan);

  // snapshot の canonical.text（抽出器が実際に読む本文）と、作った本文の期待値の突合。
  const sceneOfDocument = new Map<string, string>();
  let canonicalMatched = 0;
  let canonicalMismatched = 0;
  const seenIndexes = new Set<number>();
  for (const document of snapshot.documents) {
    if (document.origin.kind !== "project-node") continue;
    sceneOfDocument.set(document.ref, document.origin.nodeId);
    const index = a.sceneIndexById.get(document.origin.nodeId);
    if (index === undefined || seenIndexes.has(index)) {
      canonicalMismatched++;
      continue;
    }
    seenIndexes.add(index);
    if (document.canonical.text === a.expectedCanonicalTexts[index - 1])
      canonicalMatched++;
    else canonicalMismatched++;
  }
  const canonicalText = {
    documentCount: snapshot.documents.length,
    expectedSceneCount: a.expectedCanonicalTexts.length,
    matched: canonicalMatched,
    mismatched: canonicalMismatched,
    missingScenes: a.expectedCanonicalTexts.length - seenIndexes.size,
  };

  const prepass = await runEntityCandidatePrepass({
    snapshot,
    sourceViews,
    minimumOccurrenceCount: 1,
    createEvidenceAnchorId: () => crypto.randomUUID(),
  });
  const seeds = prepass.status === "complete" ? prepass.seeds : [];
  const mapped: SeedMapped[] = seeds.map((seed) => ({
    surface: seed.surface as string,
    occurrenceCount: seed.occurrences.length as number,
    sceneIds: seed.occurrences.map(
      (o) => sceneOfDocument.get(o.documentRef) ?? "unknown",
    ) as string[],
    appearsAsProperName: Boolean(seed.features.appearsAsProperName),
  }));
  return {
    ok: true as const,
    mapped,
    canonicalText,
    prepass: {
      status: String(prepass.status),
      seedCount: seeds.length,
      rejectionCount: prepass.rejections.length,
      sourceViewCount: sourceViews.length,
      windowCount: windowPlan.windows.length,
      documentCount: snapshot.documents.length,
    },
  };
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
  // 同じ process で seed を独立に読む（製品の skip 経路の coverage は固定値で、観測にならない）。
  const observedSeeds = await readSeeds(
    a,
    folderId,
    sceneNodes.map((scene) => scene.id),
  );
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
      applicability: String(proposal.applicability),
      status: String(proposal.status),
      blocked: proposal.applicability === "blocked",
      safe: isSafeForCodexEntityBulkApprove(proposal.safety),
      typeStatus: payload.typeResolution.status,
      form: proposal.safety.explicitProperName ? "proper-name" : "alias",
      evidenceCount: proposal.evidence.length,
    });
  }
  // 製品の画面（safeCount）・一括承認と同じ 3 条件で数える。
  const rowsWithBulk = rows.map((row) => ({
    ...row,
    bulkApprovable: isBulkApprovableRow(row),
  }));
  // seed の hash 集合と提案の hash 集合の突合。prepass が complete なのに差があれば失敗。
  let observed: Record<string, unknown>;
  if (observedSeeds.ok) {
    const seedVsProposal = compareHashSets(
      await Promise.all(
        observedSeeds.mapped.map((m) => hashSurface(m.surface)),
      ),
      rows.map((r) => r.surfaceHash),
    );
    observed = {
      prepass: observedSeeds.prepass,
      canonicalText: observedSeeds.canonicalText,
      seedVsProposal,
    };
    if (
      observedSeeds.prepass.status === "complete" &&
      (seedVsProposal.leftOnly > 0 || seedVsProposal.rightOnly > 0)
    ) {
      throw new Error(
        `[artifact] SEED_PROPOSAL_SET_DIFFERS seed and proposal hash sets differ: seedOnly=${seedVsProposal.leftOnly} proposalOnly=${seedVsProposal.rightOnly}`,
      );
    }
  } else {
    observed = {
      prepass: { status: "snapshot-failed" },
      diagnostics: observedSeeds.diagnostics,
    };
  }
  return {
    folderPercent: input.folderPercent,
    persisted: input.persist,
    sceneCount: sceneNodes.length,
    scope: [
      "no-product-open-lifecycle",
      "live-projection-without-persist-seam",
      "no-restore-column-no-persist-time",
    ],
    observed,
    runStatus: projection.status,
    entryCountInCatalog: catalog.entryCount,
    typeCountInCatalog: catalog.typeCount,
    entityProposalCount: projection.proposals.length,
    relationProposalCount: projection.relationProposals.length,
    baseDetailProposalCount: projection.baseDetailProposals.length,
    phaseProposalCount: projection.phaseProposals.length,
    // 製品が skip 経路で返す固定値（prepass の状態とは無関係）。観測としては使わない。
    coverageReportedByProduct: {
      mode: projection.coverage.mode ?? null,
      documentCount: projection.coverage.documentCount ?? null,
      windowCount: projection.coverage.windowCount ?? null,
      gapCount: projection.coverage.gaps?.length ?? 0,
    },
    counts: {
      bindingKind: tally(rows, (r) => r.bindingKind),
      typeStatus: tally(rows, (r) => r.typeStatus),
      form: tally(rows, (r) => r.form),
      applicability: tally(rows, (r) => r.applicability),
      reviewStatus: tally(rows, (r) => r.status),
      blocked: rows.filter((r) => r.blocked).length,
      safe: rows.filter((r) => r.safe).length,
      bulkApprovable: countBulkApprovable(rows),
      unresolvedWithCandidates: rows.filter(
        (r) => r.bindingKind === "unresolved" && r.candidateCount > 0,
      ).length,
      candidateTotal: rows.reduce((acc, r) => acc + r.candidateCount, 0),
      withoutEvidence: rows.filter((r) => r.evidenceCount === 0).length,
    },
    rows: rowsWithBulk,
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
 * - seed：製品と同じ prepass の入口（readSeeds。最小出現 1）
 * - 候補画面の候補：extract_codex_candidates を IPC で直接（ラッパは失敗を [] に潰す）。
 *   Rust は scope なしの project 全体を読むので、F100（全場面が入る folder）のときだけ取る。
 * 戻り値は件数と、表記ごとの hash・出現数・場面 index だけ（surfaces は launcher が
 * repo 外の 0600 の file にだけ書く走査用で、検査対象の出力には入れない）。
 */
async function inventory(input: { folderPercent: number }) {
  const a = requireActive();
  const folderId = a.folderIds[String(input.folderPercent)];
  const sceneNodes = getDescendantScenesInOrder(
    useTreeStore.getState().nodes,
    folderId,
  );
  const read = await readSeeds(
    a,
    folderId,
    sceneNodes.map((scene) => scene.id),
  );
  if (!read.ok) {
    return {
      seed: { status: "snapshot-failed", diagnostics: read.diagnostics },
    };
  }
  const mapped = read.mapped;
  const sceneIndexOf = (sceneId: string) => a.sceneIndexById.get(sceneId) ?? 0;
  const seedSurfaces = mapped.map((m) => m.surface);
  const seedRows = await Promise.all(
    mapped.map(async (m) => {
      const perScene = new Map<number, number>();
      for (const sceneId of m.sceneIds) {
        const index = sceneIndexOf(sceneId);
        perScene.set(index, (perScene.get(index) ?? 0) + 1);
      }
      return {
        surfaceHash: await hashSurface(m.surface),
        occurrenceCount: m.occurrenceCount,
        sceneCount: perScene.size,
        // 出現場面：[場面 index（1 始まり）, その場面での出現数]（index 昇順）。
        scenes: [...perScene.entries()].sort((x, y) => x[0] - y[0]),
        properName: m.appearsAsProperName,
      };
    }),
  );
  const seedSection: Record<string, unknown> = {
    ...read.prepass,
    ...summarizeSeedInventory(mapped),
  };

  const candidateSections: Record<string, unknown> = {};
  let defaultCandidateSurfaces: string[] = [];
  // min1（minCount=1 の raw）の候補の表記と出現数。ルビの突合の主指標に使う（既定の閾値と混ぜない）。
  let min1CandidateOccurrence: [string, number][] | null = null;
  let candidateRows: {
    surfaceHash: string;
    count: number;
    firstSceneIndex: number;
  }[] = [];
  let seedVsCandidateDefault: ReturnType<typeof crossSetCounts> | null = null;
  let occurrenceCrossCheck: Record<string, unknown> | null = null;
  if (input.folderPercent !== 100) {
    candidateSections.status = "skipped-not-f100";
  } else {
    let min1Occurrences: number | null = null;
    for (const [label, minCount] of [
      ["default", null],
      ["min1", 1],
    ] as const) {
      try {
        const raw = (await invoke("extract_codex_candidates", {
          projectId: a.projectId,
          minCount,
        })) as { surface: string; count: number; firstSceneId: string }[];
        const summary = summarizeCandidateInventory(raw);
        candidateSections[label] = { status: "ok", ...summary };
        if (label === "min1") {
          min1Occurrences = summary.occurrenceCount as number;
          min1CandidateOccurrence = raw.map(
            (c) => [c.surface, c.count] as [string, number],
          );
        }
        if (label === "default") {
          defaultCandidateSurfaces = raw.map((c) => c.surface);
          candidateRows = await Promise.all(
            raw.map(async (c) => ({
              surfaceHash: await hashSurface(c.surface),
              count: c.count,
              firstSceneIndex: sceneIndexOf(c.firstSceneId),
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
    seedVsCandidateDefault = crossSetCounts(
      seedSurfaces,
      defaultCandidateSurfaces,
    );
    // 候補の出現数（min1）と seed の出現数の合計の突合（差は記録するだけ。成否には使わない）。
    const seedOccurrences = mapped.reduce(
      (acc, m) => acc + m.occurrenceCount,
      0,
    );
    occurrenceCrossCheck = {
      seedOccurrences,
      candidateMin1Occurrences: min1Occurrences,
      equal: min1Occurrences === seedOccurrences,
    };
  }
  // ルビの付いた表記：親文字の集合と、seed（TS の canonical＝親文字を読む）・候補画面の候補
  // （Rust の本文＝ruby を落とす）の突合。表記の文字列は出さず、hash の集合で比べる。
  const seedRuby = rubySurfaceRelation(a.rubyBaseKeys, seedSurfaces);
  const candidateRuby = rubySurfaceRelation(
    a.rubyBaseKeys,
    defaultCandidateSurfaces,
  );
  const seedExactHashes = await Promise.all(
    seedRuby.exactSurfaces.map(hashSurface),
  );
  const candidateExactHashes = await Promise.all(
    candidateRuby.exactSurfaces.map(hashSurface),
  );
  // 主指標：seed のうち min1 の候補に無い表記を直接数え、親文字との関係で 3 分類する。
  // 閾値（min-count）の影響を混ぜないため、既定の候補ではなく min1 を使う。
  let min1Missing: ReturnType<typeof seedMissingFromCandidates> | null = null;
  const min1MissingHashes: Record<string, string[]> = {
    exact: [],
    containing: [],
    other: [],
  };
  if (input.folderPercent === 100 && min1CandidateOccurrence !== null) {
    min1Missing = seedMissingFromCandidates(
      a.rubyBaseKeys,
      mapped.map((m) => [m.surface, m.occurrenceCount] as [string, number]),
      min1CandidateOccurrence,
    );
    for (const cls of ["exact", "containing", "other"] as const)
      min1MissingHashes[cls] = await Promise.all(
        min1Missing.classes[cls].keys.map(hashSurface),
      );
  }
  const min1MissingCounts = min1Missing
    ? {
        seedDistinct: min1Missing.seedDistinct,
        candidateDistinct: min1Missing.candidateDistinct,
        missing: min1Missing.missing,
        presentOccurrenceDiff: min1Missing.presentOccurrenceDiff,
        exact: {
          surfaces: min1Missing.classes.exact.surfaces,
          occurrences: min1Missing.classes.exact.occurrences,
        },
        containing: {
          surfaces: min1Missing.classes.containing.surfaces,
          occurrences: min1Missing.classes.containing.occurrences,
          shortOnly: min1Missing.classes.containing.shortOnly,
        },
        other: {
          surfaces: min1Missing.classes.other.surfaces,
          occurrences: min1Missing.classes.other.occurrences,
        },
      }
    : null;
  const rubySection = {
    nodeCount: a.rubyNodeCount,
    distinctBaseCount: a.rubyBaseKeys.length,
    // 主指標（min1 の候補との差）。
    seedMissingFromMin1Candidates: min1MissingCounts,
    // 既定の閾値での値（閾値の影響が混ざる。参考）。
    defaultThreshold: {
      seedExact: seedRuby.exact,
      seedContaining: seedRuby.containing,
      candidateExact: candidateRuby.exact,
      candidateContaining: candidateRuby.containing,
      exactCompare:
        input.folderPercent === 100
          ? compareHashSets(seedExactHashes, candidateExactHashes)
          : null,
    },
  };
  const rubyRows = {
    baseHashes: await Promise.all(a.rubyBaseKeys.map(hashSurface)),
    seedExactHashes,
    candidateExactHashes,
    min1MissingHashes,
  };
  return {
    folderPercent: input.folderPercent,
    sceneCount: sceneNodes.length,
    scope: ["no-product-open-lifecycle"],
    ruby: rubySection,
    rubyRows,
    seed: seedSection,
    canonicalText: read.canonicalText,
    candidates: candidateSections,
    seedVsCandidateDefault,
    occurrenceCrossCheck,
    seedRows,
    candidateRows,
    surfaces: { seed: seedSurfaces, candidate: defaultCandidateSurfaces },
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
