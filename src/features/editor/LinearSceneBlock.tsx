import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getEditorExtensions } from "@/features/editor/extensions";
import { getFileBackedEditorExtensions } from "@/features/external-mount/fileBackedEditorExtensions";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { loadSceneFull } from "@/features/tree/api";
import { persistSceneBody } from "@/features/editor/persistSceneBody";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { useCursorOverlay } from "@/features/editor/useCursorOverlay";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCharacterFade } from "@/features/editor/useCharacterFade";
import {
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import { buildEditorContentStyle } from "@/features/editor/editorLayout";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { getDocText } from "@/features/editor/RubyNode";
import { shouldAutoDraftTransition } from "@/features/editor/autoStatusTransition";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import { EditorContentSkeleton } from "@/features/editor/EditorContentSkeleton";
import i18next from "@/lib/i18n";
import type { SceneStatus } from "@/features/tree/treeStore";
import { useLinearEditorStore } from "./linearEditorStore";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";

interface LinearSceneBlockProps {
  sceneId: string;
  isMounted: boolean;
  isActive: boolean;
  placeholderHeight: number;
  onHeightChange: (sceneId: string, height: number) => void;
  onFocus: (sceneId: string, editor: Editor) => void;
}

export function LinearSceneBlock({
  sceneId,
  isMounted,
  isActive,
  placeholderHeight,
  onHeightChange,
  onFocus,
}: LinearSceneBlockProps) {
  // Stable outer div so IntersectionObserver never loses track when mount state flips
  return (
    <div data-scene-id={sceneId} className="shrink-0">
      {isMounted ? (
        <MountedSceneBlock
          sceneId={sceneId}
          isActive={isActive}
          placeholderHeight={placeholderHeight}
          onHeightChange={onHeightChange}
          onFocus={onFocus}
        />
      ) : (
        <div style={{ blockSize: placeholderHeight }} />
      )}
    </div>
  );
}

interface MountedSceneBlockProps {
  sceneId: string;
  isActive: boolean;
  /** ロード中に skeleton を placeholder と同寸で出すための推定 block size。 */
  placeholderHeight: number;
  onHeightChange: (sceneId: string, height: number) => void;
  onFocus: (sceneId: string, editor: Editor) => void;
}

function MountedSceneBlock({
  sceneId,
  isActive,
  placeholderHeight,
  onHeightChange,
  onFocus,
}: MountedSceneBlockProps) {
  const editorSettings = useEditorSettings();
  const filterSource = useAttributionStore((s) => s.filterSource);
  const activeNode = useTreeStore((s) => s.nodes.find((n) => n.id === sceneId));
  const title = activeNode?.title ?? "";

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const isApplyingExternalUpdate = useRef(false);
  const wasEmptyRef = useRef(false);
  // 「ロードに成功した本物の doc」以外は保存禁止 — 空/欠損 doc の autosave が
  // DB の本文を上書きする本文消失の最終防衛線。**初期値は true**: mount 直後は
  // content:"" の空 doc で、ロード完了前に scroll-out で unmount されると
  // useAutoSave の cleanup flush が走る。pending が arm されていた場合、
  // false 始まりだと空 doc がそのまま DB に書き込まれる。
  const loadFailedRef = useRef(true);
  const [charCount, setCharCount] = useState(0);
  // ロード完了まで skeleton を placeholder と同寸で表示する (空エディタ +
  // 「0 chars」の一瞬の表示と、高さ崩壊によるスクロールのガタつきを防ぐ)。
  const [isLoading, setIsLoading] = useState(true);

  // EditorPane と同じスキーマ選択。file-backed scene に full schema を使うと
  // (逆方向も同様に) 未知ノードで setContent が空 doc に化ける。
  const isFileBacked = isFileBackedNode(activeNode?.sourceUri);
  const editorExtensions = useMemo(
    () =>
      isFileBacked ? getFileBackedEditorExtensions() : getEditorExtensions(),
    [isFileBacked],
  );

  const coreSave = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    if (loadFailedRef.current) {
      debugLog.warn(
        "LinearSceneBlock",
        `save skipped: load failed ${sceneId.slice(0, 8)}`,
      );
      return;
    }
    debugLog.info(
      "LinearSceneBlock",
      `save ${sceneId.slice(0, 8)}`,
      JSON.stringify({ docLen: getDocText(ed.state.doc).length }),
    );
    // 本文保存の全副作用カスケード (file-backed writeBack / foreshadow・
    // annotation anchor / beat キャッシュ / 帰属 / semantic index) は
    // persistSceneBody が正本。タブエディタ (EditorPane) と同一経路。
    await persistSceneBody(sceneId, ed.state.doc);
  }, [sceneId]);

  const saveFn = useCallback(async () => {
    try {
      await coreSave();
    } catch (e) {
      debugLog.error("LinearSceneBlock", "save failed", errorDetail(e));
    }
  }, [coreSave]);

  const { schedule, cancel } = useAutoSave(
    saveFn,
    editorSettings.autoSaveDelay,
  );

  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: "",
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
        },
      },
      onDestroy() {
        // このシーンがフォーカスを持っていた場合、破棄時に参照をリセットする
        const state = useLinearEditorStore.getState();
        if (state.focusedSceneId === sceneId) {
          state.setFocusedEditor(null, null);
        }
      },
      onUpdate({ editor: e, transaction }) {
        if (isApplyingExternalUpdate.current) return;
        // setEditable 等の doc 未変更 'update' を保存に流さない
        // (EditorPane.onUpdate と同じガード — 詳細はそちらのコメント参照)。
        if (!transaction.docChanged) return;
        if (loadFailedRef.current) {
          // 調査ログ: 未ロード窓で doc を変更している犯人の特定用。
          // 保存自体は coreSave 側 guard で skip される。
          debugLog.warn(
            "LinearSceneBlock",
            `doc changed while unloaded ${sceneId.slice(0, 8)}`,
            JSON.stringify(transaction.steps.map((s) => s.toJSON())).slice(
              0,
              300,
            ),
          );
        }
        schedule();
        const text = getDocText(e.state.doc);
        const count = text.length;
        setCharCount(count);
        useTreeStore.getState().setCharCount(sceneId, count);

        // Auto-transition outline → draft
        const nodeStatus = useTreeStore
          .getState()
          .nodes.find((n) => n.id === sceneId)?.status as
          | SceneStatus
          | null
          | undefined;
        if (
          shouldAutoDraftTransition(
            count,
            wasEmptyRef.current,
            nodeStatus ?? null,
          )
        ) {
          wasEmptyRef.current = false;
          useTreeStore
            .getState()
            .setStatus(sceneId, "draft")
            .catch(() => {});
        }
      },
      onFocus() {
        const ed = editorRef.current;
        if (ed) onFocus(sceneId, ed);
      },
    },
    [editorExtensions],
  );

  editorRef.current = editor;

  // active シーンの editor を Toolbar / SceneMetaPanel がフォーカス無しで
  // 参照できるよう registry へ登録する (linearEditorStore.editorsById)。
  useEffect(() => {
    if (!editor) return;
    useLinearEditorStore.getState().registerEditor(sceneId, editor);
    return () => {
      useLinearEditorStore.getState().unregisterEditor(sceneId, editor);
    };
  }, [sceneId, editor]);

  // CodexQuick: only update matchedIds for the active scene
  useCodexHighlight(editor, isActive ? undefined : { skipMatchedIds: true });
  // EditorPane と同じく帰属系は DB-native 限定 (file-backed schema に
  // authorship mark が無い)。
  useAttribution(isFileBacked ? null : editor);
  useLicenseEditableSync(editor);
  useCharacterFade(editor);
  // スムースキャレット (EditorPane と同じ overlay)。focus 中の block でのみ
  // 表示される (overlay は view.hasFocus() でゲートされる)。
  useCursorOverlay(editor);

  // Load content
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;

    async function load() {
      cancel();
      isApplyingExternalUpdate.current = true;
      try {
        const full = await loadSceneFull(sceneId);
        if (cancelled) return;
        const content = full.content;
        // persistSceneBody が unplacedBeatsDoc を store から読んで書き戻す
        // ため、保存前に必ず store へロードしておく (空のままだと beat 消失)。
        try {
          const beats = JSON.parse(full.unplacedBeatsDoc);
          useUnplacedBeatsStore.getState().setBeats(sceneId, beats, "load");
        } catch {
          useUnplacedBeatsStore.getState().setBeats(sceneId, [], "load");
        }
        const parsed = content && content !== "{}" ? JSON.parse(content) : "";
        // errorOnInvalidContent: スキーマ未知ノードを TipTap の silent
        // fallback (console.warn + 空 doc) に流さず throw させる。silent に
        // 流すと次の autosave が空 doc を DB に書き戻して本文が消える。
        editor!.commands.setContent(parsed, {
          emitUpdate: false,
          errorOnInvalidContent: true,
        });
        loadFailedRef.current = false;
        debugLog.info(
          "LinearSceneBlock",
          `load ${sceneId.slice(0, 8)}`,
          JSON.stringify({
            dbLen: content.length,
            docLen: getDocText(editor!.state.doc).length,
            fileBacked: isFileBacked,
          }),
        );
      } catch (e) {
        if (!cancelled) {
          loadFailedRef.current = true;
          editor!.setEditable(false, false);
          setIsLoading(false);
          debugLog.error(
            "LinearSceneBlock",
            `load failed ${sceneId.slice(0, 8)}`,
            errorDetail(e),
          );
          toast.error(i18next.t("sceneLoad.failed", { reason: rootCause(e) }));
        }
        return;
      } finally {
        isApplyingExternalUpdate.current = false;
      }

      const text = getDocText(editor!.state.doc);
      const count = text.length;
      setCharCount(count);
      setIsLoading(false);
      wasEmptyRef.current = count === 0;
      useTreeStore.getState().setCharCount(sceneId, count);

      // Load authorship spans
      const spans = await loadAuthorshipSpans(sceneId);
      if (!cancelled && spans.length > 0) {
        const markData = spansToMarkData(spans);
        const authorshipType = editor!.schema.marks["authorship"];
        if (authorshipType) {
          isApplyingExternalUpdate.current = true;
          try {
            editor!
              .chain()
              .command(({ tr }) => {
                tr.setMeta("programmaticInsert", true);
                for (const { from, to, attrs } of markData) {
                  const docSize = tr.doc.content.size;
                  const clampedFrom = Math.min(from, docSize);
                  const clampedTo = Math.min(to, docSize);
                  if (clampedFrom < clampedTo) {
                    tr.addMark(
                      clampedFrom,
                      clampedTo,
                      authorshipType.create(attrs),
                    );
                  }
                }
                return true;
              })
              .run();
          } finally {
            isApplyingExternalUpdate.current = false;
          }
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [sceneId, editor, cancel, isFileBacked]);

  // Report block-axis size changes. contentBoxSize is logical (resolved
  // against the element's writing-mode), so the same code measures height
  // when horizontal and width when vertical — matching the placeholder's
  // blockSize style.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const size = entry.contentBoxSize?.[0];
        onHeightChange(
          sceneId,
          size ? size.blockSize : entry.contentRect.height,
        );
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [sceneId, onHeightChange]);

  return (
    <div ref={containerRef}>
      <div
        className={cn(editorSettings.showLineNumbers && "editor-line-numbers")}
        style={buildEditorContentStyle(editorSettings)}
      >
        {title && (
          <div
            className="mb-4 border-b border-border/40 pb-3"
            style={{
              fontSize: `${Math.round(editorSettings.fontSize * 1.4)}px`,
            }}
          >
            <div className="select-none font-semibold text-content-foreground/60">
              {title}
            </div>
          </div>
        )}
        <div
          className="relative"
          style={isLoading ? { blockSize: placeholderHeight } : undefined}
        >
          {isLoading && (
            <div className="absolute inset-0 z-10 overflow-hidden bg-content-background">
              <EditorContentSkeleton />
            </div>
          )}
          <div className={cn(isLoading && "invisible")}>
            <div
              data-linear-beat-display={editorSettings.linearBeatDisplay}
              className={
                filterSource ? `attribution-filter-${filterSource}` : ""
              }
            >
              <EditorContent editor={editor} />
            </div>
            <div className="mt-2 text-right text-xs text-muted-foreground/50">
              {charCount.toLocaleString()} chars
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
