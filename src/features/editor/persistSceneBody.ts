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
import { upsertSceneBodyMentions } from "@/features/editor/beat/bodyMentionApi";
import { useCodexStore } from "@/features/codex/codexStore";
import { listCodexMatchTargets } from "@/features/codex/api";
import { useChatStore } from "@/features/chat/chatStore";
import { scheduleSceneIndex } from "@/features/semantic-search/scheduler";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { recordBodyMentionScans } from "@/features/codex/bodyMentionIndexState";
import { isElectron } from "@/lib/shell";
import { deriveSceneBodySnapshot } from "./sceneBodySnapshot";
import { saveSceneBodyBundle } from "./sceneBodyBundleApi";
import { bumpMatrixDataVersion } from "@/features/matrix/matrixDataVersion";

interface PendingBodyMentionScan {
  projectId: string;
  docJsonStr: string;
  /** Compatibility input for callers backed by the pre-completionTargets store. */
  allEntries?: Parameters<typeof upsertSceneBodyMentions>[2];
  sceneVersion: number;
  sceneUpdatedAt: string;
}

const pendingBodyMentionScans = new Map<string, PendingBodyMentionScan>();
const bodyMentionScanTimers = new Map<string, ReturnType<typeof setTimeout>>();
const bodyMentionScanRunning = new Set<string>();

function scheduleBodyMentionScan(
  projectId: string,
  id: string,
  docJsonStr: string,
  allEntries: PendingBodyMentionScan["allEntries"],
  sceneVersion: number,
  sceneUpdatedAt: string,
): void {
  pendingBodyMentionScans.set(id, {
    projectId,
    docJsonStr,
    allEntries,
    sceneVersion,
    sceneUpdatedAt,
  });
  if (bodyMentionScanTimers.has(id) || bodyMentionScanRunning.has(id)) return;

  const run = async () => {
    bodyMentionScanTimers.delete(id);
    const scan = pendingBodyMentionScans.get(id);
    pendingBodyMentionScans.delete(id);
    if (!scan) return;
    bodyMentionScanRunning.add(id);

    markStart("editor.coreSave.bodyMentionUpsert");
    try {
      // Always resolve the complete project projection at execution time. The
      // panel's `entries` collection is filter-dependent, while even the
      // completion cache can be empty/stale during a project switch.
      const allEntries =
        scan.allEntries ?? (await listCodexMatchTargets(scan.projectId));
      // With no match targets there can be no derived mention rows. The index
      // readiness contract already treats an empty project as ready, so avoid
      // parsing the 50k document or recording a redundant scan revision.
      if (allEntries.length === 0) return;
      await upsertSceneBodyMentions(id, scan.docJsonStr, allEntries);
      await recordBodyMentionScans(scan.projectId, allEntries, [
        {
          sceneId: id,
          version: scan.sceneVersion,
          updatedAt: scan.sceneUpdatedAt,
        },
      ]);
    } catch (e) {
      debugLog.error(
        "persistSceneBody",
        "upsertSceneBodyMentions failed",
        errorDetail(e),
      );
    } finally {
      markEnd("editor.coreSave.bodyMentionUpsert");
      bodyMentionScanRunning.delete(id);
      if (pendingBodyMentionScans.has(id) && !bodyMentionScanTimers.has(id)) {
        bodyMentionScanTimers.set(
          id,
          setTimeout(() => void run(), 0),
        );
      }
    }
  };

  bodyMentionScanTimers.set(
    id,
    setTimeout(() => void run(), 0),
  );
}

function scheduleCurrentBodyMentionScan(
  projectId: string,
  id: string,
  docJsonStr: string,
  sceneVersion: number,
  sceneUpdatedAt: string,
): void {
  const codexState = useCodexStore.getState() as {
    entries: Parameters<typeof upsertSceneBodyMentions>[2];
    completionTargets?: Parameters<typeof upsertSceneBodyMentions>[2];
  };
  // Current stores expose completionTargets, so the deferred job performs an
  // authoritative project-scoped read. The fallback keeps older embedded
  // store implementations functional during rolling upgrades.
  const legacyEntries =
    codexState.completionTargets === undefined ? codexState.entries : undefined;
  if (legacyEntries && legacyEntries.length === 0) return;
  scheduleBodyMentionScan(
    projectId,
    id,
    docJsonStr,
    legacyEntries,
    sceneVersion,
    sceneUpdatedAt,
  );
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
    scheduleCurrentBodyMentionScan(
      projectId,
      id,
      sceneJsonStr,
      contentVersion,
      contentUpdatedAt,
    );
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
  scheduleCurrentBodyMentionScan(
    projectId,
    id,
    sceneJsonStr,
    contentVersion,
    contentUpdatedAt,
  );
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
