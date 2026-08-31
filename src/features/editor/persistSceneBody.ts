import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  markStart,
  markEnd,
  recordCounter,
  recordSerializedByteCounter,
} from "@/lib/perfLog";
import { countSceneBodyChars } from "@/features/editor/charCountForBody";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import {
  saveSceneContentInner,
  type DerivedPreviews,
} from "@/features/tree/api";
import { serializeSceneWrite } from "@/features/tree/pendingSceneWrites";
import { useTreeStore } from "@/features/tree/treeStore";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { scheduleWriteBack } from "@/features/external-mount/writeBack";
import { saveAuthorshipSpans } from "@/features/attribution/api";
import {
  getSceneForeshadowBaseVersions,
  saveForeshadowAnchors,
} from "@/features/foreshadow/saveAnchors";
import { publishAuthoritativeForeshadowRows } from "@/features/foreshadow/foreshadowStore";
import type { ForeshadowRow } from "@/features/foreshadow/types";
import { saveAnnotationAnchors } from "@/features/post-effect/syncAnnotations";
import { extractBeatMentions } from "@/features/editor/beat/extractBeatMentions";
import { upsertSceneBeatMentions } from "@/features/editor/beat/mentionApi";
import { extractBeatPovOverrides } from "@/features/editor/beat/extractBeatPovOverrides";
import { upsertSceneBeatPovOverrides } from "@/features/editor/beat/beatPovCacheApi";
import { useChatStore } from "@/features/chat/chatStore";
import { scheduleSceneIndex } from "@/features/semantic-search/scheduler";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { isElectron } from "@/lib/shell";
import {
  deriveSceneAiRatio,
  deriveSceneBodySnapshot,
} from "./sceneBodySnapshot";
import { saveSceneBodyBundle } from "./sceneBodyBundleApi";
import { bumpMatrixDataVersion } from "@/features/matrix/matrixDataVersion";
import { listCodexMatchTargets } from "@/features/codex/api";
import { recordBodyMentionScans } from "@/features/codex/bodyMentionIndexState";
import { upsertSceneBodyMentions } from "@/features/editor/beat/bodyMentionApi";
import {
  getCurrentWorkspaceIdentity,
  isCurrentWorkspaceIdentity,
  type WorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { publishSceneBodyCommit } from "@/lib/sceneBodyCommitRegistry";
import {
  nextTreeNodeMutationTimestamp,
  publishTreeNodeMutation,
} from "@/lib/treeNodeMutationRegistry";
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";
import { isIpcLifecycleCancellation } from "@/lib/tauri";
import { scheduleEditorAnalysisTask } from "@/lib/editorAnalysisScheduler";
import {
  getRecorderSessionId,
  recordChangeEvent,
} from "@/features/timelapse/recorder";
import {
  runTimelapseBodyReplacement,
  runTimelapseBodyWrite,
  runTimelapseMutation,
  type TimelapseDocumentIdentity,
} from "@/features/timelapse/bodyWriteMode";
import type {
  TimelapseCoverageProof,
  TimelapseDocumentRef,
} from "@/features/timelapse/documentCoverage";

export interface BodyMentionScanRequest {
  projectId: string;
  sceneId: string;
  docJsonStr: string;
  sceneVersion: number;
  sceneUpdatedAt: string;
}

export interface PersistedSceneBody {
  contentJson: string;
  contentVersion: number;
  contentUpdatedAt: string;
  foreshadowRows: ForeshadowRow[];
}

export interface PersistSceneBodyOptions {
  /** Loaded scene version for editor OCC; omit for authoritative headless writes. */
  baseVersion?: number;
  /** Maintenance provenance for the Native Change Feed transaction. */
  origin?: "human" | "ai-apply";
  /**
   * Replayable steps for an off-screen mutation. Electron commits these as
   * the canonical Change Event in the same transaction as the scene body.
   */
  timelapseSteps?: readonly unknown[];
  /** Accepted doc.step capability from the loaded editor transaction stream. */
  timelapseDocument?: TimelapseDocumentRef;
  /** Structural scene identity used by replacement fallback. */
  timelapseDocumentIdentity?: TimelapseDocumentIdentity;
}

interface ScheduledBodyMentionScan extends BodyMentionScanRequest {
  workspaceIdentity: WorkspaceIdentity | null;
}

const pendingBodyMentionScans = new Map<string, ScheduledBodyMentionScan>();
const bodyMentionScanTimers = new Map<string, ReturnType<typeof setTimeout>>();
const bodyMentionScanTasks = new Map<string, Promise<void>>();

function isBodyMentionScanAuthoritative(
  request: ScheduledBodyMentionScan,
): boolean {
  if (request.workspaceIdentity) {
    return isCurrentWorkspaceIdentity(request.workspaceIdentity);
  }
  return getCurrentWorkspaceIdentity() === null;
}

type AiRatioRefresh =
  | { kind: "precomputed"; value: number | undefined }
  | { kind: "database" }
  | { kind: "skip" };

interface PostSaveDerivedRefreshRequest {
  sceneId: string;
  projectId: string;
  workspaceIdentity: WorkspaceIdentity | null;
  aiRatio: AiRatioRefresh;
  refreshContextLayers: boolean;
}

function isPostSaveAuthorityCurrent(
  request: PostSaveDerivedRefreshRequest,
): boolean {
  const sameWorkspace = request.workspaceIdentity
    ? isCurrentWorkspaceIdentity(request.workspaceIdentity)
    : getCurrentWorkspaceIdentity() === null;
  return (
    sameWorkspace && useTreeStore.getState().projectId === request.projectId
  );
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Keep non-authoritative projections out of the durable save task. The latest
 * save for a scene replaces a pending refresh, and workspace/project checks
 * prevent a delayed result from publishing after a switch.
 */
function schedulePostSaveDerivedRefresh(
  request: PostSaveDerivedRefreshRequest,
): void {
  const workspaceKey = request.workspaceIdentity
    ? `${request.workspaceIdentity.path}:${request.workspaceIdentity.openRevision}`
    : "browser";
  recordCounter("editor.postSave.derived.scheduled");
  scheduleEditorAnalysisTask({
    key: `derived-save:${workspaceKey}:${request.projectId}:${request.sceneId}`,
    kind: "derived",
    delayMs: 0,
    run: async () => {
      recordCounter("editor.postSave.derived.started");
      try {
        if (!isPostSaveAuthorityCurrent(request)) return;

        if (request.aiRatio.kind !== "skip") {
          markStart("editor.postSave.refreshAiRatio");
          try {
            const treeState = useTreeStore.getState();
            if (request.aiRatio.kind === "precomputed") {
              treeState.setAiRatio(request.sceneId, request.aiRatio.value);
            } else {
              await treeState.refreshAiRatio(request.sceneId);
            }
          } catch {
            // A derived badge refresh must not turn a committed save into an
            // error. The next tree hydration or save refreshes it again.
          } finally {
            markEnd("editor.postSave.refreshAiRatio");
          }
        }

        if (!request.refreshContextLayers) return;
        // Let the AI-ratio store notification and its React subscribers commit
        // before context preparation begins. This is a real event-loop boundary,
        // not merely another Promise microtask.
        await yieldToMainThread();
        if (!isPostSaveAuthorityCurrent(request)) return;
        const chatState = useChatStore.getState();
        if (chatState.activeSceneId !== request.sceneId) return;

        markStart("editor.postSave.refreshContextLayers");
        try {
          await chatState.refreshContextLayers();
        } catch {
          // Context is rebuilt again before send; preserve the committed save.
        } finally {
          markEnd("editor.postSave.refreshContextLayers");
        }
      } finally {
        recordCounter("editor.postSave.derived.settled");
      }
    },
  });
}

async function runBodyMentionScan(sceneId: string): Promise<void> {
  const existing = bodyMentionScanTasks.get(sceneId);
  if (existing) return existing;

  const timer = bodyMentionScanTimers.get(sceneId);
  if (timer) clearTimeout(timer);
  bodyMentionScanTimers.delete(sceneId);
  const current = pendingBodyMentionScans.get(sceneId);
  pendingBodyMentionScans.delete(sceneId);
  if (!current) return;

  const task = (async () => {
    recordCounter("editor.postSave.bodyMention.started");
    markStart("editor.postSave.bodyMention");
    try {
      if (!isBodyMentionScanAuthoritative(current)) return;
      const allEntries = await listCodexMatchTargets(current.projectId);
      if (allEntries.length === 0 || !isBodyMentionScanAuthoritative(current)) {
        return;
      }
      await upsertSceneBodyMentions(
        current.sceneId,
        current.docJsonStr,
        allEntries,
      );
      if (!isBodyMentionScanAuthoritative(current)) return;
      await recordBodyMentionScans(current.projectId, allEntries, [
        {
          sceneId: current.sceneId,
          version: current.sceneVersion,
          updatedAt: current.sceneUpdatedAt,
        },
      ]);
    } catch (error) {
      if (
        !isIpcLifecycleCancellation(error) &&
        isBodyMentionScanAuthoritative(current)
      ) {
        debugLog.error(
          "persistSceneBody",
          "upsertSceneBodyMentions failed",
          errorDetail(error),
        );
      }
    } finally {
      recordCounter("editor.postSave.bodyMention.settled");
      markEnd("editor.postSave.bodyMention");
    }
  })();
  bodyMentionScanTasks.set(sceneId, task);
  try {
    await task;
  } finally {
    if (bodyMentionScanTasks.get(sceneId) === task) {
      bodyMentionScanTasks.delete(sceneId);
    }
    if (
      pendingBodyMentionScans.has(sceneId) &&
      !bodyMentionScanTimers.has(sceneId)
    ) {
      bodyMentionScanTimers.set(
        sceneId,
        setTimeout(() => void runBodyMentionScan(sceneId), 0),
      );
    }
  }
}

async function flushBodyMentionScans(): Promise<void> {
  for (;;) {
    for (const timer of bodyMentionScanTimers.values()) clearTimeout(timer);
    bodyMentionScanTimers.clear();
    for (const sceneId of pendingBodyMentionScans.keys()) {
      if (!bodyMentionScanTasks.has(sceneId)) {
        void runBodyMentionScan(sceneId);
      }
    }
    const tasks = [...bodyMentionScanTasks.values()];
    if (tasks.length > 0) await Promise.all(tasks);
    if (
      pendingBodyMentionScans.size === 0 &&
      bodyMentionScanTimers.size === 0 &&
      bodyMentionScanTasks.size === 0
    ) {
      return;
    }
  }
}

/**
 * Coalesce scene-body mention scans without borrowing the Codex panel's
 * filter-dependent collection. The complete project projection is resolved at
 * execution time so live saves and external imports use the same authority.
 */
export function scheduleBodyMentionScan(request: BodyMentionScanRequest): void {
  const { sceneId } = request;
  recordCounter("editor.postSave.bodyMention.scheduled");
  pendingBodyMentionScans.set(sceneId, {
    ...request,
    workspaceIdentity: getCurrentWorkspaceIdentity(),
  });
  if (bodyMentionScanTimers.has(sceneId) || bodyMentionScanTasks.has(sceneId)) {
    return;
  }

  bodyMentionScanTimers.set(
    sceneId,
    setTimeout(() => void runBodyMentionScan(sceneId), 0),
  );
}

/** @internal */
export function _resetBodyMentionScanSchedulerForTests(): void {
  for (const timer of bodyMentionScanTimers.values()) clearTimeout(timer);
  pendingBodyMentionScans.clear();
  bodyMentionScanTimers.clear();
  bodyMentionScanTasks.clear();
}

registerQuiescenceProvider({
  id: "scene-body-mention-scans",
  stage: "scoped-mutations",
  flush: flushBodyMentionScans,
  discard: _resetBodyMentionScanSchedulerForTests,
});

/**
 * Persist a scene body document and orchestrate every doc-derived side-effect.
 *
 * This is the single source of truth for "a scene body changed" — extracted
 * verbatim from EditorPane.coreSave's scene branch so that BOTH the live editor
 * and any off-screen / headless writer (e.g. agent auto-apply) run the exact
 * same cascade. Duplicating this logic is what historically caused provenance
 * (`source='ai'`) and cache drift, so all writers must funnel through here.
 *
 * `doc` is the ProseMirror document to persist (the live editor passes
 * `editor.state.doc`; a headless writer passes a `Node.fromJSON(...)` it has
 * mutated). `editor.getJSON()` is equivalent to `doc.toJSON()`, so the doc node
 * alone is sufficient.
 *
 * Side-effects covered: scene content + char_count + beat previews
 * (saveSceneContentInner — content と full-replace cascade は per-scene write
 * チェーンの単一単位として実行される)、file-backed write-back, authorship_spans,
 * foreshadow anchors, post-effect annotation anchors, beat mentions / POV
 * cache, body codex mentions, AI-ratio refresh, chat context-layer refresh,
 * and the debounced semantic re-index. The top-level `editor.coreSave` perf
 * span is owned by the caller, not this function.
 */
export async function persistSceneBody(
  id: string,
  doc: ProseMirrorNode,
  options: PersistSceneBodyOptions = {},
): Promise<PersistedSceneBody> {
  const beats = useUnplacedBeatsStore.getState().getBeats(id);
  const projectId = useTreeStore.getState().projectId;
  const workspaceIdentity = getCurrentWorkspaceIdentity();

  const fileBackedUri = useTreeStore
    .getState()
    .nodes.find((n) => n.id === id)?.sourceUri;
  const isFileBacked = !!fileBackedUri && isFileBackedNode(fileBackedUri);
  const useNativeBundle = isElectron();

  let nativeSnapshot: ReturnType<typeof deriveSceneBodySnapshot> | null = null;
  let charCount: number;
  let unplacedBeatsDoc: string;
  let sceneJsonStr: string;
  if (useNativeBundle) {
    markStart("editor.coreSave.deriveSnapshot");
    nativeSnapshot = deriveSceneBodySnapshot(doc, beats, !isFileBacked);
    markEnd("editor.coreSave.deriveSnapshot");
    charCount = nativeSnapshot.charCount;
    unplacedBeatsDoc = nativeSnapshot.unplacedBeatsDoc;
    sceneJsonStr = nativeSnapshot.contentJson;
  } else {
    // Browser fallback and the frozen Tauri compatibility shell retain the
    // existing per-service path. Electron uses the domain bundle below.
    markStart("editor.coreSave.countChars");
    charCount = countSceneBodyChars(doc);
    markEnd("editor.coreSave.countChars");
    unplacedBeatsDoc = JSON.stringify(beats);
    markStart("editor.coreSave.getJSON");
    sceneJsonStr = JSON.stringify(doc.toJSON());
    markEnd("editor.coreSave.getJSON");
  }
  // Payload size is recorded separately from elapsed serialization time. UTF-8
  // bytes match the bridge/SQLite payload more closely than JavaScript UTF-16
  // code units, especially for the canonical Japanese long-scene fixture.
  recordSerializedByteCounter("editor.coreSave.serializeBytes", sceneJsonStr);

  // content 書き込みと full-replace cascade (authorship / foreshadow /
  // annotation anchors) を **単一のチェーン単位** として実行する。cascade を
  // チェーン外に置くと、並行する persist が非公平 mutex の barge で割り込み
  // 「新 content + 旧 spans」(オフセットずれ = 帰属追跡の破壊、full-replace
  // なので検出不能) が黙って確定しうる (M3 review I1)。チェーン単位の内側では
  // 非チェーンの saveSceneContentInner を使う — 公開 saveSceneContent を呼ぶと
  // 同一チェーンへの自己 await でデッドロックする。file-backed scene は
  // schema 依存 cascade をスキップする既存挙動を維持 (単位は content のみ)。
  const commitScene = (coverage: TimelapseCoverageProof | undefined) =>
    serializeSceneWrite(id, async () => {
      markStart("editor.coreSave.invokeSave");
      // Generate one authoritative renderer-wide tree token for both the native
      // bundle and the browser fallback. Native must not independently sample
      // wall clock time after the JS monotonic clock has advanced past it.
      const contentUpdatedAt = nextTreeNodeMutationTimestamp();
      let previews: DerivedPreviews;
      let foreshadowRows: ForeshadowRow[] = [];
      if (nativeSnapshot) {
        recordCounter("editor.coreSave.domainIpc");
        const requestId = crypto.randomUUID();
        const bundledPreviews = await saveSceneBodyBundle({
          ...nativeSnapshot,
          foreshadowBaseVersions: {
            ...getSceneForeshadowBaseVersions(id, doc),
            ...nativeSnapshot.foreshadowBaseVersions,
          },
          sceneId: id,
          projectId,
          requestId,
          sessionId: getRecorderSessionId(),
          eventUid: requestId,
          origin: options.origin ?? "human",
          ...(options.timelapseSteps !== undefined && {
            timelapseSteps: options.timelapseSteps,
          }),
          ...(coverage ? { timelapseDocStepCoverage: coverage } : {}),
          includeSidecars: !isFileBacked,
          updatedAt: contentUpdatedAt,
          ...(options.baseVersion !== undefined && {
            baseVersion: options.baseVersion,
          }),
        });
        recordCounter(
          "editor.coreSave.dbTransaction",
          bundledPreviews.dbTransactionCount,
        );
        previews = bundledPreviews;
        foreshadowRows = bundledPreviews.foreshadowRows;
      } else {
        previews = await saveSceneContentInner(id, {
          content: sceneJsonStr,
          unplacedBeatsDoc,
          charCount,
          updatedAt: contentUpdatedAt,
          ...(options.baseVersion !== undefined && {
            baseVersion: options.baseVersion,
          }),
        });
        // The Web Editor compatibility path has no Native transaction that can
        // adopt replay steps. Preserve its existing replay behavior after the
        // fallback domain write; Electron never takes this non-atomic branch.
        if (options.timelapseSteps !== undefined) {
          recordChangeEvent({
            domain: "editor",
            opType: "doc.step",
            projectId,
            sceneId: id,
            entityType: "scene",
            entityId: id,
            payload: { steps: options.timelapseSteps },
          });
        }
      }
      markEnd("editor.coreSave.invokeSave");
      // Publish immediately after the authoritative content commit, before
      // fallible derived side effects. Chronicle and other read-only consumers
      // must invalidate even when a later authorship/anchor/cache write rejects.
      if (workspaceIdentity && projectId) {
        // The native bundle bypasses tree/api.ts, so publish its authoritative
        // row token here. The Drizzle fallback publishes inside
        // saveSceneContentInner and must not be emitted twice.
        if (nativeSnapshot) {
          publishTreeNodeMutation({
            workspacePath: workspaceIdentity.path,
            workspaceOpenRevision: workspaceIdentity.openRevision,
            projectId,
            nodeId: id,
            updatedAt: previews.contentUpdatedAt,
          });
        }
        publishSceneBodyCommit({
          workspacePath: workspaceIdentity.path,
          openRevision: workspaceIdentity.openRevision,
          projectId,
          sceneId: id,
          contentVersion: previews.contentVersion,
        });
      }
      if (nativeSnapshot && !isFileBacked) {
        // The former POV cache helper bumped this revision after its DB writes.
        // The bundle owns those writes now, so publish once after commit.
        bumpMatrixDataVersion();
      } else if (!nativeSnapshot && !isFileBacked) {
        markStart("editor.coreSave.saveAuthorship");
        await saveAuthorshipSpans(id, doc);
        markEnd("editor.coreSave.saveAuthorship");
        markStart("editor.coreSave.saveForeshadow");
        foreshadowRows = await saveForeshadowAnchors(id, doc);
        markEnd("editor.coreSave.saveForeshadow");
        markStart("editor.coreSave.saveAnnotations");
        await saveAnnotationAnchors(projectId, id, doc);
        markEnd("editor.coreSave.saveAnnotations");

        // Beat-derived caches are whole-set replacements (insert desired rows,
        // then prune stale rows). They must settle inside the same per-scene
        // chain as content: otherwise an older save can finish pruning after a
        // newer save and restore the old mention / POV set.
        markStart("editor.coreSave.extractBeatMentions");
        const beatMentions = extractBeatMentions(doc);
        markEnd("editor.coreSave.extractBeatMentions");
        markStart("editor.coreSave.upsertBeatMentions");
        try {
          await upsertSceneBeatMentions(id, beatMentions);
        } catch (e) {
          debugLog.error(
            "persistSceneBody",
            "upsertSceneBeatMentions failed",
            errorDetail(e),
          );
        } finally {
          markEnd("editor.coreSave.upsertBeatMentions");
        }

        markStart("editor.coreSave.extractBeatPovOverrides");
        const beatPovOverrides = extractBeatPovOverrides(doc);
        markEnd("editor.coreSave.extractBeatPovOverrides");
        markStart("editor.coreSave.upsertBeatPovOverrides");
        try {
          await upsertSceneBeatPovOverrides(id, beatPovOverrides);
        } catch (e) {
          debugLog.error(
            "persistSceneBody",
            "upsertSceneBeatPovOverrides failed",
            errorDetail(e),
          );
        } finally {
          markEnd("editor.coreSave.upsertBeatPovOverrides");
        }
      }
      publishAuthoritativeForeshadowRows(foreshadowRows);
      return { ...previews, foreshadowRows };
    });
  const documentIdentity: TimelapseDocumentIdentity =
    options.timelapseDocumentIdentity ?? {
      projectId,
      domain: "editor",
      entityType: "scene",
      entityId: id,
      storage: isFileBacked ? "file" : "database",
    };
  const committedScene = nativeSnapshot
    ? options.timelapseSteps !== undefined
      ? runTimelapseBodyReplacement(
          { projectId, documentIdentity },
          {
            commit: () => commitScene(undefined),
            project: async (committed) => committed,
          },
        )
      : options.timelapseDocument
        ? runTimelapseBodyWrite(
            {
              projectId,
              coverageReceipt: options.timelapseDocument,
              documentIdentity,
              content: sceneJsonStr,
            },
            {
              commit: commitScene,
              project: async (committed) => committed,
            },
          )
        : runTimelapseBodyReplacement(
            { projectId, documentIdentity },
            {
              commit: () => commitScene(undefined),
              project: async (committed) => committed,
            },
          )
    : runTimelapseMutation(projectId, () => commitScene(undefined));
  const {
    placedBeatPreview,
    unplacedBeatPreview,
    contentVersion,
    contentUpdatedAt,
    foreshadowRows,
  } = await committedScene;
  if (fileBackedUri && isFileBacked) {
    markStart("editor.save.finalize");
    try {
      scheduleWriteBack(id, fileBackedUri, sceneJsonStr);
      useTreeStore.getState().setCharCount(id, charCount);
      scheduleSceneIndex(id);

      // file-backed Scene でも schema 非依存の Codex 本文検出とチャット
      // context 再構築は実行する。他の schema 依存処理
      // (authorship/foreshadow/annotation/sceneBeat/aiRatio) は
      // file-backed editor 拡張で外しているため空打ちになるのでスキップ。
      scheduleBodyMentionScan({
        projectId,
        sceneId: id,
        docJsonStr: sceneJsonStr,
        sceneVersion: contentVersion,
        sceneUpdatedAt: contentUpdatedAt,
      });
      if (useChatStore.getState().activeSceneId === id) {
        schedulePostSaveDerivedRefresh({
          sceneId: id,
          projectId,
          workspaceIdentity,
          aiRatio: { kind: "skip" },
          refreshContextLayers: true,
        });
      }
    } finally {
      markEnd("editor.save.finalize");
    }
    return {
      contentJson: sceneJsonStr,
      contentVersion,
      contentUpdatedAt,
      foreshadowRows,
    };
  }

  markStart("editor.save.finalize");
  try {
    markStart("editor.coreSave.treeMirror");
    useTreeStore.getState().setNodePreview(id, {
      placed: placedBeatPreview ?? null,
      unplaced: unplacedBeatPreview ?? null,
    });
    markEnd("editor.coreSave.treeMirror");
    // Deferred body-mention scan — does not block the save response
    scheduleBodyMentionScan({
      projectId,
      sceneId: id,
      docJsonStr: sceneJsonStr,
      sceneVersion: contentVersion,
      sceneUpdatedAt: contentUpdatedAt,
    });
    schedulePostSaveDerivedRefresh({
      sceneId: id,
      projectId,
      workspaceIdentity,
      aiRatio: nativeSnapshot
        ? { kind: "precomputed", value: deriveSceneAiRatio(nativeSnapshot) }
        : { kind: "database" },
      refreshContextLayers: useChatStore.getState().activeSceneId === id,
    });
    // セマンティック検索の再インデックスを debounce 付きで予約する。
    // 連続入力中は 2.5s おきに後ろへずれ、ユーザが手を止めてから 1 度だけ
    // Rust 側 `semantic_index_scene` を呼ぶ。正しさは Rust 側 content_hash
    // 再検証で担保される (§3.4)。
    scheduleSceneIndex(id);
  } finally {
    markEnd("editor.save.finalize");
  }
  return {
    contentJson: sceneJsonStr,
    contentVersion,
    contentUpdatedAt,
    foreshadowRows,
  };
}
