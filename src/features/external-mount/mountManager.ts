import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { countSceneBodyCharsFromJson } from "@/features/editor/charCountForBody";
import { getProjectSetting, setProjectSetting } from "@/features/settings/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  createNode,
  listAllNodes,
  saveSceneContent,
  updateNode,
} from "@/features/tree/api";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { rebaselineScenesAtTail } from "@/features/timelapse/toggle";
import { useTreeStore } from "@/features/tree/treeStore";
import { generateNKeysBetween } from "@/features/tree/fractionalIndex";
import { scheduleSceneIndex } from "@/features/semantic-search/scheduler";
import { upsertSceneBodyMentions } from "@/features/editor/beat/bodyMentionApi";
import { useCodexStore } from "@/features/codex/codexStore";
import { useChatStore } from "@/features/chat/chatStore";
import * as mountApi from "./api";
import { useExternalRootStore } from "./externalRootStore";
import { markdownToPmJson, pmJsonToMarkdown } from "./markdownBridge";
import { contentHash } from "./contentHash";
import {
  basename,
  buildMountFolderUri,
  buildSourceUri,
  dirname,
  parseSourceUri,
  titleFromFilename,
} from "./sourceUri";
import type { ExternalRoot, FileEvent, ScanResult, ScannedFile } from "./types";
import { EXTERNAL_ROOTS_KEY } from "./types";

const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RENAME_WINDOW_MS = 5000;

interface RecentDelete {
  rootId: string;
  relPath: string;
  contentHash: string;
  at: number;
}

const recentDeletes: RecentDelete[] = [];

interface PendingArchive {
  rootId: string;
  relPath: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingArchives: PendingArchive[] = [];

function cancelPendingArchive(rootId: string, relPath: string): void {
  const idx = pendingArchives.findIndex(
    (p) => p.rootId === rootId && p.relPath === relPath,
  );
  if (idx === -1) return;
  clearTimeout(pendingArchives[idx].timer);
  pendingArchives.splice(idx, 1);
}

/** @internal test helper */
export function _resetPendingArchives(): void {
  for (const p of pendingArchives) clearTimeout(p.timer);
  pendingArchives.length = 0;
}

/** @internal test helper */
export function _resetRecentDeletes(): void {
  recentDeletes.length = 0;
}

export async function loadRootsFromSettings(): Promise<ExternalRoot[]> {
  const projectId = getCurrentProjectId();
  const raw = await getProjectSetting(projectId, EXTERNAL_ROOTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ExternalRoot[];
  } catch {
    return [];
  }
}

export async function saveRootsToSettings(
  roots: ExternalRoot[],
): Promise<void> {
  const projectId = getCurrentProjectId();
  await setProjectSetting(projectId, EXTERNAL_ROOTS_KEY, JSON.stringify(roots));
}

// Boot fires this 2x (App.tsx StrictMode double-effect) plus 1x from
// reloadProjectData during loadProject. All three race past the
// `previous = []` snapshot, skip the unregister loop, and collide at
// registerMount with "overlaps with existing root: <self>". Dedup
// concurrent calls for the same project; chain across projects so a
// rapid switch still re-inits after the prior project's init drains.
let inFlightInit: { projectId: string; promise: Promise<void> } | null = null;

export async function initializeExternalMounts(): Promise<void> {
  const projectId = getCurrentProjectId();
  if (inFlightInit && inFlightInit.projectId === projectId) {
    return inFlightInit.promise;
  }
  const previousInit = inFlightInit?.promise;
  const entry: { projectId: string; promise: Promise<void> } = {
    projectId,
    promise: Promise.resolve(),
  };
  entry.promise = (async () => {
    if (previousInit) await previousInit.catch(() => {});
    try {
      await doInitializeExternalMounts();
    } finally {
      if (inFlightInit === entry) inFlightInit = null;
    }
  })();
  inFlightInit = entry;
  return entry.promise;
}

async function doInitializeExternalMounts(): Promise<void> {
  const previous = useExternalRootStore.getState().roots;
  for (const root of previous) {
    try {
      await mountApi.unregisterMount(root.id);
    } catch {
      // ignore stale watchers
    }
  }

  const missing: ExternalRoot[] = [];
  try {
    const roots = await loadRootsFromSettings();
    useExternalRootStore.getState().setRoots(roots);
    await purgeExpiredArchives();

    for (const root of roots) {
      let scan: ScanResult;
      try {
        scan = await mountApi.registerMount(root.id, root.path, root.label);
      } catch (err) {
        debugLog.error(
          "ExternalMount",
          `register failed: ${root.path}`,
          errorDetail(err),
        );
        missing.push(root);
        continue;
      }
      try {
        await reconcileRoot(root, scan);
      } catch (err) {
        debugLog.error(
          "ExternalMount",
          `reconcile failed: ${root.label}`,
          errorDetail(err),
        );
        toast.error(
          i18next.t("externalMount.toast.reconcileFailed", {
            label: root.label,
          }),
        );
      }
    }
  } catch (err) {
    // loadRootsFromSettings / purgeExpiredArchives が落ちると ScenesPanel が
    // mountInitialized = true を永久に待ち、タブ復元 (loadTabState) が走らない。
    // ここで握ってでも下の finally に到達させる。なお、setRoots 未実行で抜けた
    // 場合 useExternalRootStore.roots は previous 値のままになるが、loadTree は
    // DB から tree を組み立てるので表示は安全。
    debugLog.error("ExternalMount", "initialize failed", errorDetail(err));
  } finally {
    useExternalRootStore.getState().setMissingRoots(missing);
    // ScenesPanel.tsx の useEffect([mountInitialized]) は mountInitialized が
    // true に変わった commit 時点の useTreeStore.nodes から validNodeIds を作り
    // tabStore.loadTabState に渡す。setInitialized(true) を loadTree より先に
    // 呼ぶと React の commit が yield 中に走り、nodes 空のまま useEffect が
    // 発火して scene/note タブが全部除外される (1840c8c7 の race)。よって
    // setInitialized は必ず loadTree 完了後。loadTree が落ちても初期化フラグは
    // 立てて UI を進行させる。
    try {
      await useTreeStore.getState().loadTree(getCurrentProjectId());
    } catch (err) {
      debugLog.error("ExternalMount", "loadTree failed", errorDetail(err));
    }
    useExternalRootStore.getState().setInitialized(true);
  }
}

export async function addExternalMount(
  path: string,
  label?: string,
): Promise<void> {
  const id = crypto.randomUUID();
  const resolvedLabel = label ?? basename(path);
  const root: ExternalRoot = { id, path, label: resolvedLabel };
  const scan = await mountApi.registerMount(id, path, resolvedLabel);
  const roots = [...(await loadRootsFromSettings()), root];
  await saveRootsToSettings(roots);
  useExternalRootStore.getState().addRoot(root);
  await reconcileRoot(root, scan);
  await useTreeStore.getState().loadTree(getCurrentProjectId());
  toast.success(
    i18next.t("externalMount.toast.mounted", { label: resolvedLabel }),
  );
}

export async function removeExternalMount(rootId: string): Promise<void> {
  await mountApi.unregisterMount(rootId);
  const roots = (await loadRootsFromSettings()).filter((r) => r.id !== rootId);
  await saveRootsToSettings(roots);
  useExternalRootStore.getState().removeRoot(rootId);

  const projectId = getCurrentProjectId();
  const prefix = rootPrefix(rootId);
  const nodes = await listAllNodes(projectId);
  const { deleteNode } = await import("@/features/tree/api");
  for (const node of nodes) {
    if (node.sourceUri?.startsWith(prefix)) {
      await deleteNode(node.id);
    }
  }
  await useTreeStore.getState().loadTree(projectId);
  toast.success(i18next.t("externalMount.toast.removed"));
}

function rootPrefix(rootId: string): string {
  return `external-root://${rootId}/`;
}

async function reconcileRoot(
  root: ExternalRoot,
  scan: ScanResult,
): Promise<void> {
  const projectId = getCurrentProjectId();
  const allNodes = await listAllNodes(projectId);
  const prefix = rootPrefix(root.id);

  const mountFolderUri = buildMountFolderUri(root.id);
  let mountFolder = allNodes.find((n) => n.sourceUri === mountFolderUri);
  if (!mountFolder) {
    mountFolder = await createNode({
      id: crypto.randomUUID(),
      projectId,
      nodeType: "folder",
      title: root.label,
      sortOrder: nextSortOrder(allNodes, null),
      parentId: null,
      sourceUri: mountFolderUri,
    });
  }

  const dbByUri = await buildDbByUriMap(allNodes, prefix, mountFolderUri);

  const diskByPath = new Map(scan.files.map((f) => [f.relPath, f]));
  const folderIds = await ensureFolderTree(
    root,
    scan,
    mountFolder.id,
    allNodes,
  );

  // Boot-time rename detection via normalized-markdown content hash.
  // scan.files[].contentHash は disk の生 markdown を直接 SHA-256 したもので、
  // pmJsonToMarkdown を通った後の正規化形と一致しないため使えない (round-trip
  // drift: trailing newline 付加、段落間空行の縮退など)。disk 側も hashForDiskContent
  // で同じ pmJsonToMarkdown 経路を通してから比較する。
  const dbOnly = [...dbByUri.entries()].filter(
    ([uri, node]) =>
      !node.archivedAt && !diskByPath.has(parseSourceUri(uri)?.relPath ?? ""),
  );
  const diskOnly = scan.files.filter(
    (f) => !dbByUri.has(buildSourceUri(root.id, f.relPath)),
  );

  const diskHashByPath = new Map<string, string>();
  for (const f of diskOnly) {
    diskHashByPath.set(f.relPath, await hashForDiskContent(f.content));
  }

  for (const [uri, node] of dbOnly) {
    const parsed = parseSourceUri(uri);
    if (!parsed) continue;
    const nodeHash = await hashForNode(node);
    const match =
      nodeHash != null
        ? diskOnly.find((f) => diskHashByPath.get(f.relPath) === nodeHash)
        : undefined;
    if (match) {
      const newUri = buildSourceUri(root.id, match.relPath);
      await updateNode(node.id, {
        sourceUri: newUri,
        title: titleFromFilename(basename(match.relPath)),
        sourceMtime: match.mtime,
      });
      diskOnly.splice(diskOnly.indexOf(match), 1);
      dbByUri.delete(uri);
      dbByUri.set(newUri, { ...node, sourceUri: newUri });
    } else if (!node.archivedAt) {
      await softArchiveNode(node.id);
    }
  }

  for (const file of scan.files) {
    const uri = buildSourceUri(root.id, file.relPath);
    const existing = dbByUri.get(uri);
    if (existing?.archivedAt) {
      await updateNode(existing.id, {
        archivedAt: null,
        sourceMtime: file.mtime,
      });
    }
    if (existing) {
      await syncFileCache(existing.id, file);
    } else {
      await upsertSceneFromFile(root, file, mountFolder.id, folderIds);
    }
  }
}

async function hashForNode(node: { content: string }): Promise<string | null> {
  try {
    const markdown = pmJsonToMarkdown(node.content);
    return await contentHash(markdown);
  } catch {
    return null;
  }
}

/**
 * Compute a rename-detection hash from raw disk Markdown that survives the
 * `markdown → pmjson → markdown` round-trip drift (段落間空行の縮退、末尾改行の
 * 付加、リストマーカーの差異など)。`hashForNode` と同じ正規化経路を通すので、
 * 同一内容のファイルがどちらの起点でも同じハッシュになる。Rust 側 scan が返す
 * 生 markdown の SHA-256 (= `scan.files[].contentHash`) はリネーム判定には使えない。
 */
export async function hashForDiskContent(content: string): Promise<string> {
  const pmJson = JSON.stringify(markdownToPmJson(content));
  const normalized = pmJsonToMarkdown(pmJson);
  return contentHash(normalized);
}

/** @internal Exported for unit tests. */
export async function hashForNodeContent(
  content: string,
): Promise<string | null> {
  return hashForNode({ content });
}

async function ensureFolderTree(
  root: ExternalRoot,
  scan: ScanResult,
  mountFolderId: string,
  allNodes: Awaited<ReturnType<typeof listAllNodes>>,
): Promise<Map<string, string>> {
  const folderIds = new Map<string, string>();
  const projectId = getCurrentProjectId();
  const sortedDirs = [...scan.dirs].sort((a, b) =>
    a.relPath.localeCompare(b.relPath),
  );

  for (const dir of sortedDirs) {
    const uri = buildSourceUri(root.id, dir.relPath);
    let node = allNodes.find((n) => n.sourceUri === uri);
    if (!node) {
      const parentRel = dirname(dir.relPath);
      const parentId =
        parentRel == null
          ? mountFolderId
          : (folderIds.get(parentRel) ?? mountFolderId);
      node = await createNode({
        id: crypto.randomUUID(),
        projectId,
        nodeType: "folder",
        title: dir.name,
        sortOrder: nextSortOrder(allNodes, parentId),
        parentId,
        sourceUri: uri,
      });
      allNodes.push(node);
    }
    folderIds.set(dir.relPath, node.id);
  }
  return folderIds;
}

/** @internal Exported for unit tests. */
export async function buildDbByUriMap(
  allNodes: Awaited<ReturnType<typeof listAllNodes>>,
  prefix: string,
  mountFolderUri: string,
): Promise<Map<string, Awaited<ReturnType<typeof listAllNodes>>[number]>> {
  const candidates = allNodes.filter(
    (n) => n.sourceUri?.startsWith(prefix) && n.sourceUri !== mountFolderUri,
  );
  const grouped = new Map<string, typeof candidates>();
  for (const node of candidates) {
    const uri = node.sourceUri!;
    const group = grouped.get(uri) ?? [];
    group.push(node);
    grouped.set(uri, group);
  }

  const map = new Map<string, (typeof candidates)[number]>();
  for (const [uri, nodes] of grouped) {
    const active = nodes.filter((n) => !n.archivedAt);
    if (active.length > 1) {
      active.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const dup of active.slice(1)) {
        await softArchiveNode(dup.id);
      }
    }
    const preferred =
      active[0] ??
      nodes.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (preferred) map.set(uri, preferred);
  }
  return map;
}

async function upsertSceneFromFile(
  root: ExternalRoot,
  file: ScannedFile,
  mountFolderId: string,
  folderIds: Map<string, string>,
): Promise<void> {
  const projectId = getCurrentProjectId();
  const uri = buildSourceUri(root.id, file.relPath);
  const existing = (await listAllNodes(projectId)).find(
    (n) => n.sourceUri === uri,
  );
  if (existing) {
    if (existing.archivedAt) {
      await updateNode(existing.id, {
        archivedAt: null,
        sourceMtime: file.mtime,
      });
    }
    await syncFileCache(existing.id, file);
    return;
  }

  const parentRel = dirname(file.relPath);
  const parentId =
    parentRel == null
      ? mountFolderId
      : (folderIds.get(parentRel) ?? mountFolderId);
  const pmJson = JSON.stringify(markdownToPmJson(file.content));
  const charCount = countSceneBodyCharsFromJson(pmJson);
  const node = await createNode({
    id: crypto.randomUUID(),
    projectId,
    nodeType: "scene",
    title: titleFromFilename(basename(file.relPath)),
    sortOrder: sortOrderForFilename(file.relPath),
    parentId,
    sourceUri: uri,
    sourceMtime: file.mtime,
    content: pmJson,
  });
  await saveSceneContent(node.id, { content: pmJson, charCount });
  scheduleSceneIndex(node.id);
}

async function syncFileCache(nodeId: string, file: ScannedFile): Promise<void> {
  const pmJson = JSON.stringify(markdownToPmJson(file.content));
  const charCount = countSceneBodyCharsFromJson(pmJson);
  await saveSceneContent(nodeId, { content: pmJson, charCount });
  await updateNode(nodeId, {
    sourceMtime: file.mtime,
    title: titleFromFilename(basename(file.relPath)),
  });
  scheduleSceneIndex(nodeId);
}

function sortOrderForFilename(relPath: string): string {
  return basename(relPath).toLowerCase();
}

function nextSortOrder(
  nodes: { parentId: string | null; sortOrder: string }[],
  parentId: string | null,
): string {
  const siblings = nodes.filter((n) => n.parentId === parentId);
  const keys = generateNKeysBetween(
    null,
    null,
    Math.max(siblings.length + 1, 1),
  );
  return keys[keys.length - 1] ?? "a0";
}

async function softArchiveNode(nodeId: string): Promise<void> {
  await updateNode(nodeId, { archivedAt: new Date().toISOString() });
}

export async function purgeExpiredArchives(): Promise<void> {
  const projectId = getCurrentProjectId();
  const cutoff = Date.now() - ARCHIVE_RETENTION_MS;
  const allNodes = await listAllNodes(projectId);
  for (const node of allNodes) {
    if (!node.archivedAt) continue;
    const archivedAt = Date.parse(node.archivedAt);
    if (!Number.isNaN(archivedAt) && archivedAt < cutoff) {
      const { deleteNode } = await import("@/features/tree/api");
      await deleteNode(node.id);
    }
  }
}

export async function handleFileEvent(event: FileEvent): Promise<void> {
  if (useExternalRootStore.getState().isMuted(event.rootId, event.relPath)) {
    return;
  }

  const root = useExternalRootStore
    .getState()
    .roots.find((r) => r.id === event.rootId);
  if (!root) return;

  switch (event.kind) {
    case "changed":
      await handleFileChanged(root, event.relPath);
      break;
    case "added":
      await handleFileAdded(root, event.relPath);
      break;
    case "removed":
      await handleFileRemoved(root, event.relPath);
      break;
    case "renamed":
      if (event.oldRelPath) {
        await handleFileRenamed(root, event.oldRelPath, event.relPath);
      }
      break;
  }
}

async function handleFileChanged(
  root: ExternalRoot,
  relPath: string,
): Promise<void> {
  cancelPendingArchive(root.id, relPath);
  const uri = buildSourceUri(root.id, relPath);
  const node = await findNodeByUri(uri);
  if (!node) return;

  const content = await mountApi.readExternalFile(root.id, relPath);
  const fileMtime = await mountApi.getExternalFileMtime(root.id, relPath);
  const { useTabStore } = await import("@/features/editor/tabStore");
  const isDirty = useTabStore.getState().dirtyTabIds.has(node.id);

  if (isDirty) {
    useExternalRootStore.getState().enqueueConflict({
      sceneId: node.id,
      rootId: root.id,
      relPath,
      incomingContent: content,
      incomingMtime: fileMtime,
    });
    return;
  }

  await applyExternalContent(node.id, root.id, relPath, content, fileMtime);
}

async function applyExternalContent(
  nodeId: string,
  _rootId: string,
  _relPath: string,
  markdown: string,
  sourceMtime?: string,
): Promise<void> {
  const pmJson = JSON.stringify(markdownToPmJson(markdown));
  const charCount = countSceneBodyCharsFromJson(pmJson);
  await saveSceneContent(nodeId, { content: pmJson, charCount });
  await updateNode(nodeId, {
    sourceMtime: sourceMtime ?? new Date().toISOString(),
  });
  // External file → app (IN) rewrites scene content in the DB and the live
  // editor reload runs with isApplyingExternalUpdate=true, so no doc.step is
  // recorded. Mark the sync and re-anchor the scene baseline at the chain tail
  // so later edits replay on the imported content (no RangeError).
  //
  // Defensive: this path is reached for file-content events (→ scene nodes),
  // but a folder also carries a sourceUri. change_events.sceneId is a valid FK
  // to ANY tree node (no flush-wedge), yet baselining a folder as an editor
  // scene would be a wasted, never-replayed snapshot — so skip positively-known
  // folders. A brand-new scene not yet in the store still proceeds.
  const knownNode = useTreeStore.getState().nodes?.find((n) => n.id === nodeId);
  if (knownNode?.nodeType !== "folder") {
    recordChangeEvent({
      domain: "mount",
      opType: "file.import",
      entityType: "scene",
      entityId: nodeId,
      sceneId: nodeId,
      payload: { sceneId: nodeId, charCount },
    });
    await rebaselineScenesAtTail(getCurrentProjectId(), [nodeId]);
  }
  scheduleSceneIndex(nodeId);
  useTreeStore.getState().setCharCount(nodeId, charCount);
  await useTreeStore.getState().loadTree(getCurrentProjectId());

  // file-backed Scene でも schema 非依存の Codex 本文検出と チャット context
  // 再構築は実行する。Mention 拡張のような schema 依存処理は file-backed
  // editor 側で外しているのでここでは扱わない (see fileBackedEditorExtensions.ts)。
  const codexEntries = useCodexStore.getState().entries;
  if (codexEntries.length > 0) {
    try {
      await upsertSceneBodyMentions(nodeId, pmJson, codexEntries);
    } catch (err) {
      debugLog.error(
        "ExternalMount",
        "upsertSceneBodyMentions failed",
        errorDetail(err),
      );
    }
  }
  const chatState = useChatStore.getState();
  if (chatState.activeSceneId === nodeId) {
    await chatState.refreshContextLayers().catch(() => {});
  }

  // 取り込んだ内容を表示中の live editor (タブ EditorPane / リニア
  // LinearSceneBlock) に反映する。リニアはタブを持たないので tab リスト
  // だけのゲートでは取りこぼし、editor の古い doc が次の autosave で
  // 取り込み分を上書きしてしまう。
  const { useTabStore } = await import("@/features/editor/tabStore");
  const { useLinearEditorStore } =
    await import("@/features/editor/linearEditorStore");
  const tabState = useTabStore.getState();
  const hasLiveEditor =
    tabState.tabs.some((t) => t.nodeId === nodeId) ||
    tabState.secondaryTabs.some((t) => t.nodeId === nodeId) ||
    nodeId in useLinearEditorStore.getState().editorsById;
  if (hasLiveEditor) {
    window.dispatchEvent(
      new CustomEvent("external-mount:reload-scene", {
        detail: { sceneId: nodeId, content: pmJson },
      }),
    );
  }
}

async function handleFileAdded(
  root: ExternalRoot,
  relPath: string,
): Promise<void> {
  cancelPendingArchive(root.id, relPath);
  const scan = await mountApi.scanMount(root.id);
  const file = scan.files.find((f) => f.relPath === relPath);
  if (!file) return;

  // recentDeletes は handleFileRemoved 側で hashForNode (pmJsonToMarkdown 経路)
  // で計算しているので、disk 側も同じ正規化経路の hashForDiskContent で揃える。
  const fileHash = await hashForDiskContent(file.content);
  const recent = recentDeletes.find(
    (d) =>
      d.rootId === root.id &&
      d.contentHash === fileHash &&
      Date.now() - d.at < RENAME_WINDOW_MS,
  );
  if (recent) {
    await handleFileRenamed(root, recent.relPath, relPath);
    return;
  }

  await reconcileRoot(root, scan);
  await useTreeStore.getState().loadTree(getCurrentProjectId());
}

async function handleFileRemoved(
  root: ExternalRoot,
  relPath: string,
): Promise<void> {
  const uri = buildSourceUri(root.id, relPath);
  const node = await findNodeByUri(uri);
  if (!node) return;

  // handleFileAdded 側で hashForDiskContent と比較するので、削除側も同じ正規化
  // 経路 (hashForNode) で計算する。parse 不能なら rename 候補から除外。
  const hash = await hashForNode(node);
  if (hash) {
    recentDeletes.push({
      rootId: root.id,
      relPath,
      contentHash: hash,
      at: Date.now(),
    });
  }

  const { useTabStore } = await import("@/features/editor/tabStore");
  const isDirty = useTabStore.getState().dirtyTabIds.has(node.id);
  if (isDirty) {
    toast.warning(i18next.t("externalMount.toast.fileDeletedExternally"));
    return;
  }

  // Atomic saves (delete temp + rename) emit removed before added/changed.
  // Defer archive so tabs and tree nodes stay stable through the window.
  cancelPendingArchive(root.id, relPath);
  const capturedUri = uri;
  const timer = setTimeout(() => {
    cancelPendingArchive(root.id, relPath);
    void (async () => {
      const still = await findNodeByUri(capturedUri);
      if (!still || still.archivedAt) return;
      await softArchiveNode(still.id);
      await useTreeStore.getState().loadTree(getCurrentProjectId());
    })();
  }, RENAME_WINDOW_MS);
  pendingArchives.push({ rootId: root.id, relPath, timer });
}

async function handleFileRenamed(
  root: ExternalRoot,
  oldRelPath: string,
  newRelPath: string,
): Promise<void> {
  cancelPendingArchive(root.id, oldRelPath);
  cancelPendingArchive(root.id, newRelPath);
  const oldUri = buildSourceUri(root.id, oldRelPath);
  const node = await findNodeByUri(oldUri);
  if (!node) {
    await handleFileAdded(root, newRelPath);
    return;
  }
  const newUri = buildSourceUri(root.id, newRelPath);
  await updateNode(node.id, {
    sourceUri: newUri,
    title: titleFromFilename(basename(newRelPath)),
  });
  await useTreeStore.getState().loadTree(getCurrentProjectId());
  toast.info(
    i18next.t("externalMount.toast.renamed", {
      title: titleFromFilename(basename(newRelPath)),
    }),
  );
}

async function findNodeByUri(uri: string) {
  const projectId = getCurrentProjectId();
  const nodes = await listAllNodes(projectId);
  return nodes.find((n) => n.sourceUri === uri);
}

/** @internal Exported for unit tests. */
export { applyExternalContent };

export async function resolveReloadConflict(
  choice: "keep-local" | "reload",
): Promise<void> {
  const conflict = useExternalRootStore.getState().conflicts[0];
  if (!conflict) return;
  if (choice === "reload") {
    await applyExternalContent(
      conflict.sceneId,
      conflict.rootId,
      conflict.relPath,
      conflict.incomingContent,
      conflict.incomingMtime,
    );
  }
  useExternalRootStore.getState().shiftConflict();
}
