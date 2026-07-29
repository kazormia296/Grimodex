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
import { saveForeshadowAnchors } from "@/features/foreshadow/saveAnchors";
import { saveAnnotationAnchors } from "@/features/post-effect/syncAnnotations";
import { extractBeatMentions } from "@/features/editor/beat/extractBeatMentions";
import { upsertSceneBeatMentions } from "@/features/editor/beat/mentionApi";
import { extractBeatPovOverrides } from "@/features/editor/beat/extractBeatPovOverrides";
import { upsertSceneBeatPovOverrides } from "@/features/editor/beat/beatPovCacheApi";
import { useChatStore } from "@/features/chat/chatStore";
import { scheduleSceneIndex } from "@/features/semantic-search/scheduler";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { isElectron } from "@/lib/shell";
import { deriveSceneBodySnapshot } from "./sceneBodySnapshot";
import { saveSceneBodyBundle } from "./sceneBodyBundleApi";
import { bumpMatrixDataVersion } from "@/features/matrix/matrixDataVersion";
import { listCodexMatchTargets } from "@/features/codex/api";
import { recordBodyMentionScans } from "@/features/codex/bodyMentionIndexState";
import { upsertSceneBodyMentions } from "@/features/editor/beat/bodyMentionApi";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { publishSceneBodyCommit } from "@/lib/sceneBodyCommitRegistry";
import { publishTreeNodeMutation } from "@/lib/treeNodeMutationRegistry";

export interface BodyMentionScanRequest {
  projectId: string;
  sceneId: string;
  docJsonStr: string;
  sceneVersion: number;
  sceneUpdatedAt: string;
}

const pendingBodyMentionScans = new Map<string, BodyMentionScanRequest>();
const bodyMentionScanTimers = new Map<string, ReturnType<typeof setTimeout>>();
const bodyMentionScanRunning = new Set<string>();

/**
 * Coalesce scene-body mention scans without borrowing the Codex panel's
 * filter-dependent collection. The complete project projection is resolved at
 * execution time so live saves and external imports use the same authority.
 */
export function scheduleBodyMentionScan(request: BodyMentionScanRequest): void {
  const { sceneId } = request;
  pendingBodyMentionScans.set(sceneId, request);
  if (
    bodyMentionScanTimers.has(sceneId) ||
    bodyMentionScanRunning.has(sceneId)
  ) {
    return;
  }

  const run = async () => {
    bodyMentionScanTimers.delete(sceneId);
    const current = pendingBodyMentionScans.get(sceneId);
    pendingBodyMentionScans.delete(sceneId);
    if (!current) return;
    bodyMentionScanRunning.add(sceneId);

    markStart("editor.coreSave.bodyMentionUpsert");
    try {
      const allEntries = await listCodexMatchTargets(current.projectId);
      if (allEntries.length === 0) return;
      await upsertSceneBodyMentions(
        current.sceneId,
        current.docJsonStr,
        allEntries,
      );
      await recordBodyMentionScans(current.projectId, allEntries, [
        {
          sceneId: current.sceneId,
          version: current.sceneVersion,
          updatedAt: current.sceneUpdatedAt,
        },
      ]);
    } catch (error) {
      debugLog.error(
        "persistSceneBody",
        "upsertSceneBodyMentions failed",
        errorDetail(error),
      );
    } finally {
      markEnd("editor.coreSave.bodyMentionUpsert");
      bodyMentionScanRunning.delete(sceneId);
      if (
        pendingBodyMentionScans.has(sceneId) &&
        !bodyMentionScanTimers.has(sceneId)
      ) {
        bodyMentionScanTimers.set(
          sceneId,
          setTimeout(() => void run(), 0),
        );
      }
    }
  };

  bodyMentionScanTimers.set(
    sceneId,
    setTimeout(() => void run(), 0),
  );
}

/** @internal */
export function _resetBodyMentionScanSchedulerForTests(): void {
  for (const timer of bodyMentionScanTimers.values()) clearTimeout(timer);
  pendingBodyMentionScans.clear();
  bodyMentionScanTimers.clear();
  bodyMentionScanRunning.clear();
}

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
): Promise<void> {
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
  const {
    placedBeatPreview,
    unplacedBeatPreview,
    contentVersion,
    contentUpdatedAt,
  } = await serializeSceneWrite(id, async () => {
    markStart("editor.coreSave.invokeSave");
    let previews: DerivedPreviews;
    if (nativeSnapshot) {
      recordCounter("editor.coreSave.domainIpc");
      const bundledPreviews = await saveSceneBodyBundle({
        ...nativeSnapshot,
        sceneId: id,
        projectId,
        includeSidecars: !isFileBacked,
      });
      recordCounter(
        "editor.coreSave.dbTransaction",
        bundledPreviews.dbTransactionCount,
      );
      previews = bundledPreviews;
    } else {
      previews = await saveSceneContentInner(id, {
        content: sceneJsonStr,
        unplacedBeatsDoc,
        charCount,
      });
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
      await saveForeshadowAnchors(id, doc);
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
    return previews;
  });

  if (fileBackedUri && isFileBacked) {
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
    const chatState = useChatStore.getState();
    if (chatState.activeSceneId === id) {
      markStart("editor.coreSave.refreshContextLayers");
      chatState
        .refreshContextLayers()
        .catch(() => {})
        .finally(() => markEnd("editor.coreSave.refreshContextLayers"));
    }
    return;
  }

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
  markStart("editor.coreSave.refreshAiRatio");
  useTreeStore
    .getState()
    .refreshAiRatio(id)
    .catch(() => {})
    .finally(() => markEnd("editor.coreSave.refreshAiRatio"));
  const chatState = useChatStore.getState();
  if (chatState.activeSceneId === id) {
    markStart("editor.coreSave.refreshContextLayers");
    chatState
      .refreshContextLayers()
      .catch(() => {})
      .finally(() => markEnd("editor.coreSave.refreshContextLayers"));
  }
  // セマンティック検索の再インデックスを debounce 付きで予約する。
  // 連続入力中は 2.5s おきに後ろへずれ、ユーザが手を止めてから 1 度だけ
  // Rust 側 `semantic_index_scene` を呼ぶ。正しさは Rust 側 content_hash
  // 再検証で担保される (§3.4)。
  scheduleSceneIndex(id);
}
