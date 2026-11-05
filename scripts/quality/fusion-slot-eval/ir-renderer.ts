// 融合の枠の評価（段階 2）：PD の原稿の IR をクラウド LLM で作り、IR の共通枠の使用率を
// 測る renderer 側の部品。
//
// 段階 1 の `renderer.ts`（Scene の canonical writer）と L0 の
// `scripts/quality/nir1-retrieval/renderer.ts`（measureHybrid／finalizeHybrid／buildIr）を
// 写して変えたもの（既存の file は変えない）。違いは次のとおり。
// - Scene は L0 と同じく 1 件ずつ folder に入れる（folder が読書順、Scene は folder 内の a0）。
//   地点を進めるときは同じ project に Scene を足す。
// - AI 設定（provider／model）と key は製品の IPC（save_ai_settings／save_api_key）で入れる。
// - 抽出は製品の `startChronicleExtraction`（useAi=true）。全提案を
//   `reviseChronicleProposal({secret:false})` で child にし、child を承認する（計画 §2.4）。
// - 返すのは件数・enum・不透明 ID・Scene の位置だけ。本文・題名・抜粋・LLM の応答は返さない。
import { generateNKeysBetween } from "fractional-indexing";
import { invoke } from "@/lib/tauri";
import {
  getCurrentWorkspaceIdentity,
  setCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { setCurrentRuntimeProjectId } from "@/runtime/projectIdentity";
import { useWorkspaceStore } from "@/features/workspace/store";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  createProject,
  listProjects,
  updateProject,
} from "@/features/project/api";
import {
  getCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import { listNodes, loadSceneContent } from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";
import { prosemirrorToText } from "@/lib/prosemirror";
import { useDebugLogStore } from "@/lib/debugLog";
import { fetchRelatedPastScenes } from "@/features/related-scenes/fetchRelatedScenes";
import {
  beginRelatedScenes,
  continueRelatedScenes,
  listenRelatedScenesIndexReady,
  releaseRelatedScenes,
} from "@/features/related-scenes/nir1RelatedScenesApi";
import { buildSemanticRecallQuery } from "@/features/chat/semanticRecall";
import {
  semanticIndexStatus,
  semanticReindexAll,
} from "@/features/semantic-search/api";
import {
  getAiSettings,
  hasApiKey,
  saveAiSettings,
  saveApiKey,
} from "@/features/chat/api";
import { useAiSettingsStore } from "@/features/chat/store";
import { captureMutationAuthority } from "@/features/concurrency/mutationAuthority";
import { listEvents } from "@/features/chronicle/api";
import { buildLiveChronicleExistingEventCatalog } from "@/features/chronicle/extraction/existingEventCatalog";
import { useChronicleExtractionStore } from "@/features/chronicle/chronicleExtractionStore";
import {
  discardChronicleTaskResumeCandidate,
  discoverChronicleTaskResumeCandidates,
  startChronicleExtraction,
} from "@/features/chronicle/extractEventsApi";
import {
  decideChronicleProposal,
  reviseChronicleProposal,
} from "@/features/chronicle/chronicleExtractionApi";

interface SceneSeed {
  /** 読書順の位置（1 始まり）。 */
  position: number;
  paragraphs: string[];
}

let openRevision = 0;
let active: {
  projectId: string;
  language: "ja" | "en";
  positions: Map<string, number>;
  lastFolderKey: string | null;
} | null = null;
let readyEvents = 0;
let unlistenReady: (() => void) | null = null;

const sceneId = (position: number) =>
  `fir-s${String(position).padStart(4, "0")}`;
const folderId = (position: number) =>
  `fir-f${String(position).padStart(4, "0")}`;

/** NEX_ などの code だけを残す。本文や key が混ざる余地のある message は返さない。 */
function errorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.match(/\bNEX_[A-Z0-9_]+\b/u)?.[0] ??
    message.match(/^\[[a-z-]+\]/u)?.[0] ??
    fallback
  );
}

/**
 * 診断用の error の形：ASCII 以外（日本語の本文）を "?" に替え、識別子らしい長い英数字列
 * （key の可能性がある）を伏せ、240 字で切る。原因の分類にだけ使う。
 */
function errorShape(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[^\x20-\x7e]+/gu, "?")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "<long>")
    .slice(0, 240);
}

function requireActive() {
  if (!active) throw new Error("[precheck] no prepared case");
  return active;
}

async function prepare(input: {
  workspacePath: string;
  projectId: string;
  language: "ja" | "en";
  /** 診断（--reuse-workspace）：測定の済んだ workspace の写しを開き、project を作らない。 */
  attach?: boolean;
}) {
  await invoke("open_workspace", { path: input.workspacePath });
  setCurrentWorkspaceIdentity({
    path: input.workspacePath,
    openRevision: ++openRevision,
  });
  // AI の監査は renderer の workspace store の active な workspace を要る（製品は workspace を
  // 開く流れで設定する）。
  useWorkspaceStore.setState({
    activeWorkspacePath: input.workspacePath,
    workspaceSwitchInProgress: false,
  });
  publishCurrentProjectId(input.projectId);
  setCurrentRuntimeProjectId(input.projectId);
  if (input.attach) return attachExisting(input);
  // 作成画面の「本筋を既定にする」と同じ option（R12）。新しい Scene はこの既定を受け継ぐ。
  await createProject(
    {
      id: input.projectId,
      title: "Fusion slot IR evaluation",
      language: input.language,
    },
    { sceneScopeDefault: "main-line" },
  );
  // IR の query は project の読書順の軸（DB の phase_resolution_mode が reading）を要る。
  // renderer の store だけでなく、L0 の setup と同じく製品の project の patch で DB に入れる。
  const patched = await updateProject(input.projectId, {
    phaseResolutionMode: "reading",
  });
  if (patched?.phaseResolutionMode !== "reading")
    throw new Error("[artifact] project phaseResolutionMode was not persisted");
  useProjectStore.setState({
    currentProjectId: input.projectId,
    projects: await listProjects(),
  });
  await useTreeStore
    .getState()
    .reloadTreeOrThrow(input.projectId, openRevision);
  usePhaseStore.setState({ resolutionMode: "reading" });
  unlistenReady?.();
  readyEvents = 0;
  unlistenReady = await listenRelatedScenesIndexReady((id) => {
    if (id === input.projectId) readyEvents++;
  });
  active = {
    projectId: input.projectId,
    language: input.language,
    positions: new Map(),
    lastFolderKey: null,
  };
  return { ok: true };
}

/** 診断：既にある project を開き、Scene の位置を id（fir-sNNNN）から戻す。 */
async function attachExisting(input: {
  projectId: string;
  language: "ja" | "en";
}) {
  const projects = await listProjects();
  const project = projects.find((p) => p.id === input.projectId);
  if (!project) throw new Error("[precheck] reuse: project が無い");
  if (project.phaseResolutionMode !== "reading")
    throw new Error("[precheck] reuse: phaseResolutionMode が reading でない");
  useProjectStore.setState({ currentProjectId: input.projectId, projects });
  await useTreeStore
    .getState()
    .reloadTreeOrThrow(input.projectId, openRevision);
  usePhaseStore.setState({ resolutionMode: "reading" });
  unlistenReady?.();
  readyEvents = 0;
  unlistenReady = await listenRelatedScenesIndexReady((id) => {
    if (id === input.projectId) readyEvents++;
  });
  const positions = new Map<string, number>();
  for (const node of await listNodes(input.projectId)) {
    const match = /^fir-s(\d{4})$/u.exec(node.id);
    if (match) positions.set(node.id, Number(match[1]));
  }
  active = {
    projectId: input.projectId,
    language: input.language,
    positions,
    lastFolderKey: null,
  };
  return { ok: true, attached: true, scenes: positions.size };
}

/**
 * 診断（--reuse-workspace）：IR の continue が解決した時刻を renderer の時計で残す。
 * contextBridge の bridge は差し替えられないので、driver が診断の mode のときだけ vite の変換で
 * `related_scenes_continue` の Promise を `globalThis.__firIrTap` に渡す。製品の結果は変えない。
 */
type IrTapRecord = { start: number; end: number | null; status: string | null };
let irTap: { continues: IrTapRecord[]; pending: Promise<unknown>[] } | null =
  null;
function installIrArrivalTap() {
  const tap = {
    continues: [] as IrTapRecord[],
    pending: [] as Promise<unknown>[],
  };
  (globalThis as unknown as { __firIrTap?: unknown }).__firIrTap = (
    promise: Promise<unknown>,
  ) => {
    const record: IrTapRecord = {
      start: performance.now(),
      end: null,
      status: null,
    };
    tap.continues.push(record);
    tap.pending.push(
      promise.then(
        (value) => {
          record.end = performance.now();
          const status = (value as { status?: unknown } | null)?.status;
          record.status = typeof status === "string" ? status : "unknown";
        },
        () => {
          record.end = performance.now();
          record.status = "rejected";
        },
      ),
    );
  };
  irTap = tap;
  return { installed: true, mode: "vite-transform" };
}

const CANONICAL_CUTOVER_MARKER = "narrative-c2-canonical-freshness-v1";

/** workspace の Generic Freshness の正本への切り替え（C2-ZC cutover）が済んだか。 */
async function canonicalCutoverDone(): Promise<boolean> {
  const rows = (
    await invoke<{ rows: { n: number }[] }>("db_execute", {
      sql: "SELECT count(*) AS n FROM schema_data_migrations WHERE migration_id = ?",
      params: [CANONICAL_CUTOVER_MARKER],
      method: "all",
    })
  ).rows;
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * cutover が済むまで待つ。済む前は IR の build が入口ではじかれる（build.rs の
 * CanonicalAuthorityUnavailable）。本測定の 1 作品目では、project の作成の直後から
 * Scene の追加と抽出が続き、保守の流れが cutover まで進まなかった（2026-11-04）。
 * 製品の保守を待つだけで、harness は保守を起動しない。
 */
async function waitCanonicalCutover(input: { timeoutMs: number }) {
  const started = performance.now();
  let polls = 0;
  while (performance.now() - started < input.timeoutMs) {
    polls++;
    if (await canonicalCutoverDone())
      return { done: true, polls, durationMs: performance.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { done: false, polls, durationMs: performance.now() - started };
}

/** provider と model だけを上書きする。reasoning は製品の経路から指定できないので触らない。 */
async function configureAi(input: {
  provider: "openrouter" | "anthropic";
  model: string;
}) {
  const current = await getAiSettings();
  await saveAiSettings({
    ...current,
    provider: input.provider,
    model: input.model,
  });
  await useAiSettingsStore.getState().loadSettings();
  const loaded = useAiSettingsStore.getState().settings;
  return {
    provider: loaded?.provider ?? null,
    model: loaded?.model ?? null,
    reasoningEffortOverride: loaded?.reasoningEffortOverride ?? null,
    thinkingEnabled: loaded?.thinkingEnabled ?? null,
  };
}

/** 製品の save_api_key（safeStorage）で key を入れる。値は返さず、記録もしない。 */
async function installKey(input: {
  provider: "openrouter" | "anthropic";
  key: string;
}) {
  try {
    await saveApiKey(input.provider, input.key, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const backend = message.match(/backend: ([a-z_]+)/u)?.[1] ?? null;
    throw new Error(
      `[key] save_api_key failed${backend ? ` (backend ${backend})` : ""}${
        message.includes("safeStorage unavailable") ? " (unavailable)" : ""
      }`,
    );
  }
  const present = await hasApiKey(input.provider, null);
  await useAiSettingsStore.getState().loadSettings();
  return { present, storeHasApiKey: useAiSettingsStore.getState().hasApiKey };
}

/** Scene を読書順に足す。1 件ずつ folder に入れる（L0 の流儀）。 */
async function addScenes(scenes: SceneSeed[]) {
  const state = requireActive();
  const sorted = [...scenes].sort((a, b) => a.position - b.position);
  const keys = generateNKeysBetween(state.lastFolderKey, null, sorted.length);
  for (const [index, scene] of sorted.entries()) {
    const title = `S${scene.position}`;
    await invoke("tree_node_create", {
      payload: {
        ...createCanonicalWriteContext("human"),
        id: folderId(scene.position),
        projectId: state.projectId,
        parentId: null,
        nodeType: "folder",
        title,
        sortOrder: keys[index],
        content: null,
        canonicalPayload: { parentId: null, sortOrder: keys[index], title },
      },
    });
    await invoke("tree_node_create", {
      payload: {
        ...createCanonicalWriteContext("human"),
        id: sceneId(scene.position),
        projectId: state.projectId,
        parentId: folderId(scene.position),
        nodeType: "scene",
        title,
        sortOrder: "a0",
        content: JSON.stringify({
          type: "doc",
          content: scene.paragraphs.map((text) => ({
            type: "paragraph",
            content: [{ type: "text", text }],
          })),
        }),
        canonicalPayload: {
          parentId: folderId(scene.position),
          sortOrder: "a0",
          title,
        },
      },
    });
    state.positions.set(sceneId(scene.position), scene.position);
  }
  state.lastFolderKey = keys[keys.length - 1] ?? state.lastFolderKey;
  const nodes = await listNodes(state.projectId);
  const sceneCount = nodes.filter((node) => node.nodeType === "scene").length;
  if (sceneCount !== state.positions.size)
    throw new Error("[artifact] setup scene count mismatch");
  await useTreeStore
    .getState()
    .reloadTreeOrThrow(state.projectId, openRevision);
  for (const scene of sorted) {
    const expected = scene.paragraphs.map((p) => `${p}\n`).join("");
    if (
      prosemirrorToText(await loadSceneContent(sceneId(scene.position))) !==
      expected
    )
      throw new Error(
        `[artifact] persisted source differs: ${sceneId(scene.position)}`,
      );
  }
  return { sceneCount };
}

function positionsOfRefs(refs: readonly unknown[]): number[] {
  const state = requireActive();
  const found = new Set<number>();
  for (const ref of refs) {
    const text = typeof ref === "string" ? ref : JSON.stringify(ref);
    for (const [id, position] of state.positions)
      if (text.includes(id)) found.add(position);
  }
  return [...found].sort((a, b) => a - b);
}

// 案 B（新しい場面は project の既定の scope＝本筋を受け継ぐ）。製品（SDEF PR-1／PR-2、#791・#793）
// に入ったので、project を作成画面と同じ option（sceneScopeDefault: "main-line"）で作り、
// 足した Scene が既定を受け継いだかだけを確かめる。harness は scope を書かない。
export const MAIN_SCOPE_REFS = {
  timeline: "timeline:main",
  worldline: "worldline:prime",
  narrativeLayer: "layer:manuscript",
} as const;
interface ScopeRegistry {
  registryVersion: string;
  timelineRefs: string[];
  worldlineRefs: string[];
  narrativeLayerRefs: string[];
}
interface ScopeAxes {
  timeline: { kind: string; ref?: string };
  worldline: { kind: string; ref?: string };
  narrativeLayer: { kind: string; ref?: string };
}
interface ScopeReadResult {
  registry: ScopeRegistry;
  registryRevision: number;
  binding: {
    version: number;
    compatibilityMarker: string;
    queryIdentity: ScopeAxes;
    materialConstraint: ScopeAxes;
    knowledgeHolder: { kind: string };
    audience: { kind: string };
  };
}

const isMainLine = (axes: ScopeAxes) =>
  axes.timeline.kind === "exact" &&
  axes.timeline.ref === MAIN_SCOPE_REFS.timeline &&
  axes.worldline.kind === "exact" &&
  axes.worldline.ref === MAIN_SCOPE_REFS.worldline &&
  axes.narrativeLayer.kind === "exact" &&
  axes.narrativeLayer.ref === MAIN_SCOPE_REFS.narrativeLayer;

/**
 * 足した Scene が project の既定（本筋）を受け継いだかを確かめる。query と material は本筋の
 * exact、holder と audience は reader、marker は explicit。1 件でも違えば止める（書き直さない）。
 * 最後に DB の binding を marker ごとに数える。
 */
async function verifyMainScope(positions: number[]) {
  const state = requireActive();
  const workspace = getCurrentWorkspaceIdentity();
  if (!workspace) throw new Error("[precheck] no workspace identity");
  let inherited = 0;
  for (const position of positions) {
    const read = await invoke<ScopeReadResult>("narrative_scene_scope_read", {
      expectedWorkspacePath: workspace.path,
      projectId: state.projectId,
      sceneId: sceneId(position),
    });
    const b = read.binding;
    if (
      b.compatibilityMarker !== "explicit" ||
      !isMainLine(b.queryIdentity) ||
      !isMainLine(b.materialConstraint) ||
      b.knowledgeHolder.kind !== "reader" ||
      b.audience.kind !== "reader"
    )
      throw new Error(
        `[artifact] scene at position ${position} did not inherit the main-line default`,
      );
    inherited++;
  }
  const markers = (
    await invoke<{ rows: { m: string; n: number }[] }>("db_execute", {
      sql: "SELECT compatibility_marker AS m, count(*) AS n FROM narrative_scene_scope_bindings WHERE project_id = ? GROUP BY compatibility_marker",
      params: [state.projectId],
      method: "all",
    })
  ).rows;
  const byMarker = Object.fromEntries(markers.map((r) => [r.m, Number(r.n)]));
  if ((byMarker.explicit ?? 0) !== state.positions.size || markers.length !== 1)
    throw new Error("[artifact] not every scene scope binding is explicit");
  return { inherited, markers: byMarker };
}

/** 未解決の resume 候補は次の解析を拒むので、失敗の後に捨てる。 */
async function discardResumeCandidates() {
  const state = requireActive();
  const workspace = getCurrentWorkspaceIdentity();
  if (!workspace) throw new Error("[precheck] no workspace identity");
  const scope = {
    projectId: state.projectId,
    workspacePath: workspace.path,
    openRevision: workspace.openRevision,
  };
  const candidates = await discoverChronicleTaskResumeCandidates(scope);
  const discarded: string[] = [];
  for (const candidate of candidates) {
    try {
      await discardChronicleTaskResumeCandidate({
        candidate,
        authority: captureMutationAuthority(
          state.projectId,
          getCurrentProjectId,
        ),
        workspacePath: workspace.path,
        openRevision: workspace.openRevision,
      });
      discarded.push("discarded");
    } catch (error) {
      discarded.push(errorCode(error, "discard-failed"));
    }
  }
  return { candidates: candidates.length, results: discarded };
}

/**
 * 1 Scene を抽出し、全提案を非 secret の child にして承認する。
 * 返すのは件数・enum・位置だけ（題名・note・evidence の引用は返さない）。
 */
async function extractScene(position: number) {
  const state = requireActive();
  const workspace = getCurrentWorkspaceIdentity();
  if (!workspace) throw new Error("[precheck] no workspace identity");
  const started = performance.now();
  useChronicleExtractionStore.getState().clearProjection();
  let runId: string;
  try {
    const existing = await listEvents(state.projectId);
    ({ runId } = await startChronicleExtraction({
      projectId: state.projectId,
      folderId: folderId(position),
      language: state.language,
      sceneIds: [sceneId(position)],
      authority: captureMutationAuthority(state.projectId, getCurrentProjectId),
      workspacePath: workspace.path,
      openRevision: workspace.openRevision,
      existingEvents: buildLiveChronicleExistingEventCatalog(existing),
    }));
  } catch (error) {
    const code = errorCode(error, "extraction-failed");
    const shape = errorShape(error);
    let recovery = null;
    try {
      recovery = await discardResumeCandidates();
    } catch (recoveryError) {
      recovery = { error: errorCode(recoveryError, "recovery-failed") };
    }
    return {
      position,
      status: "failed",
      errorCode: code,
      errorShape: shape,
      recovery,
      durationMs: performance.now() - started,
      proposals: [],
    };
  }
  const extractedMs = performance.now() - started;
  const projection = useChronicleExtractionStore.getState().projection;
  if (!projection || projection.runId !== runId)
    return {
      position,
      status: "failed",
      errorCode: "projection-missing",
      durationMs: extractedMs,
      proposals: [],
    };
  const proposals = [];
  for (const proposal of [...projection.proposals]) {
    const row: Record<string, unknown> = {
      applicability: proposal.applicability,
      statusBefore: proposal.status,
      secretBefore: proposal.payload?.disclosure.secret ?? null,
      actuality: proposal.payload?.actuality ?? null,
      significance: proposal.payload?.significance ?? null,
      evidenceCount: proposal.evidence.length,
      evidencePositions: positionsOfRefs(
        proposal.payload?.evidenceDocumentRefs ?? [],
      ),
      revealPositions: positionsOfRefs(
        proposal.payload ? [proposal.payload.disclosure.revealDocumentRef] : [],
      ),
      revised: false,
      approved: false,
      error: null as string | null,
    };
    if (proposal.applicability !== "applicable" || proposal.application) {
      row.error = "not-applicable";
      proposals.push(row);
      continue;
    }
    try {
      // 順序は revise が先、承認が後（逆だと decision が古い revision を指して失効する）。
      await reviseChronicleProposal({
        proposalId: proposal.proposalId,
        patch: { secret: false },
      });
      row.revised = true;
      await decideChronicleProposal({
        proposalId: proposal.proposalId,
        status: "approved",
      });
      row.approved = true;
    } catch (error) {
      row.error = errorCode(
        error,
        row.revised ? "approve-failed" : "revise-failed",
      );
    }
    proposals.push(row);
  }
  return {
    position,
    status: "completed",
    runId,
    errorCode: null,
    extractedMs,
    durationMs: performance.now() - started,
    proposals,
  };
}

async function buildRaw(input: { first: boolean }) {
  const state = requireActive();
  // 抽出の後に作るので、初回でも既に vector がある可能性がある。止めずに記録する。
  const before = await semanticIndexStatus(state.projectId);
  const chunksBefore = before.indexedChunkCount;
  const started = performance.now();
  await semanticReindexAll(state.projectId, `fusion-ir-${state.projectId}`);
  const status = await semanticIndexStatus(state.projectId);
  if (
    status.staleChunkCount !== 0 ||
    status.indexedSceneCount !== state.positions.size ||
    status.nonemptySceneCount !== state.positions.size
  )
    throw new Error(
      "[artifact] full build did not publish all expected scenes",
    );
  return {
    first: input.first,
    chunksBefore,
    durationMs: performance.now() - started,
    indexedChunkCount: status.indexedChunkCount,
    indexedSceneCount: status.indexedSceneCount,
  };
}

/** 製品の hybrid の fetch を 1 回呼び、件数・enum・位置だけを返す。session は必ず解放する。 */
async function sampleHybrid(position: number) {
  const state = requireActive();
  const id = sceneId(position);
  useTreeStore.setState({ activeSceneId: id });
  useDebugLogStore.getState().clear();
  if (irTap) {
    irTap.continues.length = 0;
    irTap.pending.length = 0;
  }
  const started = performance.now();
  const sample = await fetchRelatedPastScenes(id, { mode: "hybrid" });
  const durationMs = performance.now() - started;
  // 診断：窓の判定の後も session を保ったまま IR の到着を待つ（上限 10 s）。
  let irArrival: {
    afterRawMs: number | null;
    status: string | null;
    continues: number;
  } | null = null;
  if (irTap) {
    await Promise.race([
      Promise.allSettled(irTap.pending),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    const last = irTap.continues.at(-1);
    irArrival = {
      afterRawMs:
        last?.end != null && sample.timing.tRawReadyMs !== null
          ? last.end - sample.timing.tRawReadyMs
          : null,
      status: last?.status ?? null,
      continues: irTap.continues.length,
    };
  }
  try {
    const failures = useDebugLogStore
      .getState()
      .entries.filter(
        (entry) =>
          entry.tag === "RelatedScenes" &&
          (entry.level === "warn" || entry.level === "error"),
      ).length;
    const toPosition = (sid: string) => state.positions.get(sid) ?? -1;
    const result = sample.result;
    return {
      status: sample.status,
      rawStatus: sample.rawStatus,
      initialSnapshot: sample.initialSnapshot
        ? {
            indexUsable: sample.initialSnapshot.indexUsable,
            querySupported: sample.initialSnapshot.querySupported,
          }
        : null,
      completion: sample.completion
        ? {
            outcome: sample.completion.outcome,
            deadlineExceeded: sample.completion.deadlineExceeded,
          }
        : null,
      resultKind: result.kind,
      irStatus: result.ir.status,
      irReason: "reason" in result.ir ? result.ir.reason : null,
      rows:
        result.kind === "fused"
          ? result.scenes.map((row) => ({
              position: toPosition(row.sceneId),
              kind: row.kind,
            }))
          : result.scenes.map((row) => ({
              position: toPosition(row.sceneId),
              kind: "raw",
            })),
      rawCount: sample.rawScenes.length,
      rawPositions: sample.rawScenes.map((row) => toPosition(row.sceneId)),
      durationMs,
      failures,
      // 診断（分類・集計には使わない）：IR の窓（Raw ＋ RELATED_SCENES_IR_EXTRA_WAIT_MS）と
      // の位置関係を見るための相対時間。renderer の時計どうし・Native どうしでだけ引く。
      timing: {
        rawReadyAfterFetchMs:
          sample.timing.tRawReadyMs === null
            ? null
            : sample.timing.tRawReadyMs - sample.timing.tFetchMs,
        returnAfterRawMs:
          sample.timing.tRawReadyMs === null
            ? null
            : sample.timing.tReturnMs - sample.timing.tRawReadyMs,
        nativeRawReadyElapsedMs:
          sample.timing.native?.rawReadyElapsedMs ?? null,
        ...(irArrival ? { irArrival } : {}),
      },
    };
  } finally {
    sample.session?.release();
  }
}

/**
 * 別 operation の probe：begin→continue（deadline なし）→release。continue の列は
 * floor・Scene ごとの最大・上限 8 件を通った後のもの（floor 前の候補は見えない）。
 */
async function probe(position: number) {
  const state = requireActive();
  const workspace = getCurrentWorkspaceIdentity();
  if (!workspace) throw new Error("[precheck] no workspace identity");
  const id = sceneId(position);
  const body = prosemirrorToText(await loadSceneContent(id));
  const query = buildSemanticRecallQuery({ userMessage: "", sceneBody: body });
  const tBegin = performance.now();
  const begin = await beginRelatedScenes({
    expectedWorkspacePath: workspace.path,
    projectId: state.projectId,
    currentSceneId: id,
    query,
  });
  const tBeginReturned = performance.now();
  if (begin.ir.status !== "pending")
    return {
      status: "unavailable",
      reason: begin.ir.reason,
      admittedPositions: [],
    };
  const ticket = begin.ir.operationTicket;
  try {
    const answer = await continueRelatedScenes(ticket);
    // 診断（分類・集計には使わない）：begin の往復と、begin が返ってから IR が届くまで。
    const timing = {
      beginRoundTripMs: tBeginReturned - tBegin,
      irAfterBeginMs: performance.now() - tBeginReturned,
      nativeRawReadyElapsedMs: begin.timing?.rawReadyElapsedMs ?? null,
    };
    if (answer.status !== "available")
      return {
        status: "unavailable",
        reason: answer.reason,
        admittedPositions: [],
        timing,
      };
    return {
      status: "available",
      reason: null,
      admittedPositions: answer.scenes.map(
        (scene) => state.positions.get(scene.sceneId) ?? -1,
      ),
      timing,
    };
  } finally {
    await releaseRelatedScenes(ticket).catch(() => undefined);
  }
}

/**
 * 承認の後、IR が使える（indexUsable）まで待つ。`related-scenes:index-ready` を数え、
 * 実際の query 経路で確かめる（L0 の buildIr と同じ考え方。上限は伸ばす）。
 */
async function waitIrUsable(input: {
  position: number;
  timeoutMs: number;
  /** 承認が無い地点では build の event を待たない。 */
  requireReadyEvent: boolean;
}) {
  // begin のたびに Native が IR の build を予約し、公開すると index-ready を出す。承認の後の
  // build を待つため、usable に加えて、この関数の開始より後の index-ready を 1 回以上要る。
  // event が来ないまま usable が 30 秒続いたら（作り直す物が無い）受け入れ、印を付ける。
  const eventsAtStart = readyEvents;
  const started = performance.now();
  let usableSince: number | null = null;
  const probes: { indexUsable: boolean | null; outcome: string | null }[] = [];
  const result = (usable: boolean, acceptedWithoutEvent: boolean) => ({
    usable,
    acceptedWithoutEvent,
    durationMs: performance.now() - started,
    readyEvents: readyEvents - eventsAtStart,
    attempts: probes.length,
    notUsableAttempts: probes.filter((p) => p.indexUsable !== true).length,
    last: probes[probes.length - 1] ?? null,
  });
  while (performance.now() - started < input.timeoutMs) {
    const sample = await sampleHybrid(input.position);
    probes.push({
      indexUsable: sample.initialSnapshot?.indexUsable ?? null,
      outcome: sample.completion?.outcome ?? null,
    });
    const usable = sample.initialSnapshot?.indexUsable === true;
    if (usable) {
      usableSince ??= performance.now();
      if (!input.requireReadyEvent || readyEvents > eventsAtStart)
        return result(true, false);
      if (performance.now() - usableSince >= 30000) return result(true, true);
    } else {
      usableSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return result(false, false);
}

/**
 * 使用量：ai_audit_events の execution.* の件数と、成功の usage の token 合計。
 * ai_usage の行もあれば合計する。数字だけを返す（payload の本文は返さない）。
 */
async function usage() {
  const state = requireActive();
  const rows = async (sql: string, params: unknown[] = []) =>
    (
      await invoke<{ rows: Record<string, unknown>[] }>("db_execute", {
        sql,
        params,
        method: "all",
      })
    ).rows;
  const byType = await rows(
    "SELECT event_type AS t, count(*) AS n FROM ai_audit_events WHERE event_type LIKE 'execution.%' GROUP BY event_type",
  );
  const succeeded = await rows(
    "SELECT payload FROM ai_audit_events WHERE event_type = 'execution.succeeded'",
  );
  let inputTokens = 0;
  let outputTokens = 0;
  let missingUsage = 0;
  for (const row of succeeded) {
    try {
      const parsed = JSON.parse(String(row.payload)) as {
        usage?: { inputTokens?: number | null; outputTokens?: number | null };
      };
      const input = parsed.usage?.inputTokens;
      const output = parsed.usage?.outputTokens;
      if (typeof input === "number") inputTokens += input;
      if (typeof output === "number") outputTokens += output;
      if (typeof input !== "number" || typeof output !== "number")
        missingUsage++;
    } catch {
      missingUsage++;
    }
  }
  const aiUsage = await rows(
    "SELECT count(*) AS n, sum(tokens_in) AS tin, sum(tokens_out) AS tout, sum(cost_usd) AS cost, sum(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS nocost FROM ai_usage WHERE project_id = ?",
    [state.projectId],
  );
  return {
    auditExecutions: Object.fromEntries(
      byType.map((row) => [String(row.t), Number(row.n)]),
    ),
    succeeded: succeeded.length,
    inputTokens,
    outputTokens,
    missingUsage,
    aiUsage: aiUsage[0] ?? null,
  };
}

Object.assign(window, {
  fusionIrEvaluation: {
    prepare,
    installIrArrivalTap,
    configureAi,
    installKey,
    addScenes,
    extractScene,
    discardResumeCandidates,
    verifyMainScope,
    waitCanonicalCutover,
    canonicalCutoverDone,
    buildRaw,
    sampleHybrid,
    probe,
    waitIrUsable,
    usage,
    readyEvents: () => readyEvents,
    ready: true,
  },
});
