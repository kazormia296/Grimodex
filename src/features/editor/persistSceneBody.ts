import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { markStart, markEnd } from "@/lib/perfLog";
import { countSceneBodyChars } from "@/features/editor/charCountForBody";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { saveSceneContentInner } from "@/features/tree/api";
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
import { useChatStore } from "@/features/chat/chatStore";
import { scheduleSceneIndex } from "@/features/semantic-search/scheduler";
import { debugLog, errorDetail } from "@/lib/debugLog";

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
  markStart("editor.coreSave.countChars");
  const charCount = countSceneBodyChars(doc);
  markEnd("editor.coreSave.countChars");
  const beats = useUnplacedBeatsStore.getState().getBeats(id);
  const unplacedBeatsDoc = JSON.stringify(beats);
  markStart("editor.coreSave.getJSON");
  const sceneJsonStr = JSON.stringify(doc.toJSON());
  markEnd("editor.coreSave.getJSON");

  const fileBackedUri = useTreeStore
    .getState()
    .nodes.find((n) => n.id === id)?.sourceUri;
  const isFileBacked = !!fileBackedUri && isFileBackedNode(fileBackedUri);

  // content 書き込みと full-replace cascade (authorship / foreshadow /
  // annotation anchors) を **単一のチェーン単位** として実行する。cascade を
  // チェーン外に置くと、並行する persist が非公平 mutex の barge で割り込み
  // 「新 content + 旧 spans」(オフセットずれ = 帰属追跡の破壊、full-replace
  // なので検出不能) が黙って確定しうる (M3 review I1)。チェーン単位の内側では
  // 非チェーンの saveSceneContentInner を使う — 公開 saveSceneContent を呼ぶと
  // 同一チェーンへの自己 await でデッドロックする。file-backed scene は
  // schema 依存 cascade をスキップする既存挙動を維持 (単位は content のみ)。
  const { placedBeatPreview, unplacedBeatPreview } = await serializeSceneWrite(
    id,
    async () => {
      markStart("editor.coreSave.invokeSave");
      const previews = await saveSceneContentInner(id, {
        content: sceneJsonStr,
        unplacedBeatsDoc,
        charCount,
      });
      markEnd("editor.coreSave.invokeSave");
      if (!isFileBacked) {
        markStart("editor.coreSave.saveAuthorship");
        await saveAuthorshipSpans(id, doc);
        markEnd("editor.coreSave.saveAuthorship");
        markStart("editor.coreSave.saveForeshadow");
        await saveForeshadowAnchors(id, doc);
        markEnd("editor.coreSave.saveForeshadow");
        markStart("editor.coreSave.saveAnnotations");
        await saveAnnotationAnchors(useTreeStore.getState().projectId, id, doc);
        markEnd("editor.coreSave.saveAnnotations");
      }
      return previews;
    },
  );

  if (fileBackedUri && isFileBacked) {
    scheduleWriteBack(id, fileBackedUri, sceneJsonStr);
    useTreeStore.getState().setCharCount(id, charCount);
    scheduleSceneIndex(id);

    // file-backed Scene でも schema 非依存の Codex 本文検出とチャット
    // context 再構築は実行する。他の schema 依存処理
    // (authorship/foreshadow/annotation/sceneBeat/aiRatio) は
    // file-backed editor 拡張で外しているため空打ちになるのでスキップ。
    const allEntries = useCodexStore.getState().entries;
    if (allEntries.length > 0) {
      setTimeout(() => {
        markStart("editor.coreSave.bodyMentionUpsert");
        upsertSceneBodyMentions(id, sceneJsonStr, allEntries)
          .catch((e) => {
            debugLog.error(
              "persistSceneBody",
              "upsertSceneBodyMentions failed (file-backed)",
              errorDetail(e),
            );
          })
          .finally(() => {
            markEnd("editor.coreSave.bodyMentionUpsert");
          });
      }, 0);
    }
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
  markStart("editor.coreSave.extractBeatMentions");
  const beatMentions = extractBeatMentions(doc);
  markEnd("editor.coreSave.extractBeatMentions");
  markStart("editor.coreSave.upsertBeatMentions");
  upsertSceneBeatMentions(id, beatMentions)
    .catch((e) => {
      debugLog.error(
        "persistSceneBody",
        "upsertSceneBeatMentions failed",
        errorDetail(e),
      );
    })
    .finally(() => markEnd("editor.coreSave.upsertBeatMentions"));
  markStart("editor.coreSave.extractBeatPovOverrides");
  const beatPovOverrides = extractBeatPovOverrides(doc);
  markEnd("editor.coreSave.extractBeatPovOverrides");
  markStart("editor.coreSave.upsertBeatPovOverrides");
  upsertSceneBeatPovOverrides(id, beatPovOverrides)
    .catch((e) => {
      debugLog.error(
        "persistSceneBody",
        "upsertSceneBeatPovOverrides failed",
        errorDetail(e),
      );
    })
    .finally(() => markEnd("editor.coreSave.upsertBeatPovOverrides"));
  // Deferred body-mention scan — does not block the save response
  const allEntries = useCodexStore.getState().entries;
  if (allEntries.length > 0) {
    markStart("editor.coreSave.bodyMentionGetJSON");
    const docJsonStr = JSON.stringify(doc.toJSON());
    markEnd("editor.coreSave.bodyMentionGetJSON");
    setTimeout(() => {
      markStart("editor.coreSave.bodyMentionUpsert");
      upsertSceneBodyMentions(id, docJsonStr, allEntries)
        .catch((e) => {
          debugLog.error(
            "persistSceneBody",
            "upsertSceneBodyMentions failed",
            errorDetail(e),
          );
        })
        .finally(() => {
          markEnd("editor.coreSave.bodyMentionUpsert");
        });
    }, 0);
  }
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
