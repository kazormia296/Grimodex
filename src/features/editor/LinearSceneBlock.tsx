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
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";
import { useTabStore } from "@/features/editor/tabStore";
import { subscribeLiveContentRafCoalesced } from "@/features/editor/sceneContentStore";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";
import { ExternalEditConflictBanner } from "@/features/editor/ExternalEditConflictBanner";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { useCursorOverlay } from "@/features/editor/useCursorOverlay";
import { useImeDiagnostics } from "@/features/editor/useImeDiagnostics";
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

// sceneContentStore の source-group sentinel。EditorPane の 0/1、agent resync
// (autoApplyProse / renameEngine) の -1 と衝突しない値であること — 一致すると
// subscribeLiveContentRafCoalesced が「自分の broadcast」とみなして捨てる。
const LINEAR_LIVE_GROUP = 2;

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
  // 外部 write feed (別プロセスの MCP 等) が「dirty でない scene の外部更新」
  // を検知すると nonce を進める。dep に入れて DB から再ロードする
  // (EditorPane の externalReloadNonce と同じ契約)。conflict バナーの
  // "Reload" もこの nonce 経由で再ロードに到達する。
  const externalReloadNonce = useExternalWriteStore(
    (s) => s.reloadNonce[sceneId] ?? 0,
  );

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
  // タイピング中の文字数同期 debounce タイマー (EditorStatsFooter と同じ
  // 200ms trailing)。
  const statTimerRef = useRef<number | null>(null);
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
    // 保存成功時のみ dirty 解除 (失敗時は saveFn の catch 側に飛ぶので残る)。
    useTabStore.getState().setTabDirty(sceneId, false);
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
        // 未保存編集の検出は dirtyTabIds が正本 (external-mount の conflict
        // 検出・post-effect/チャットの flush 列挙が参照する)。リニアはタブを
        // 持たないが、この Set に乗らないと外部変更が未保存編集をサイレントに
        // 上書きする。解除は coreSave 成功時と unmount cleanup。
        useTabStore.getState().setTabDirty(sceneId, true);

        // Auto-transition outline → draft: wasEmptyRef が true の間だけ
        // 全文 walk する (EditorPane.onUpdate と同じ制限 — 一度本文を観測
        // したらこの分岐は恒久 skip)。
        if (wasEmptyRef.current) {
          const count = getDocText(e.state.doc).length;
          if (count > 0) {
            wasEmptyRef.current = false;
            const nodeStatus = useTreeStore
              .getState()
              .nodes.find((n) => n.id === sceneId)?.status as
              | SceneStatus
              | null
              | undefined;
            if (shouldAutoDraftTransition(count, true, nodeStatus ?? null)) {
              useTreeStore
                .getState()
                .setStatus(sceneId, "draft")
                .catch(() => {});
            }
          }
        }

        // 文字数表示と tree store の charCount 同期は 200ms trailing debounce
        // で 1 回だけ full-doc walk + setState する (EditorStatsFooter と同じ
        // perf 契約)。毎打鍵で getDocText の O(doc) 走査と setCharCount による
        // ブロック全体の再レンダーを払わない。
        if (statTimerRef.current != null) {
          window.clearTimeout(statTimerRef.current);
        }
        statTimerRef.current = window.setTimeout(() => {
          statTimerRef.current = null;
          if (e.isDestroyed) return;
          const count = getDocText(e.state.doc).length;
          setCharCount(count);
          useTreeStore.getState().setCharCount(sceneId, count);
        }, 200);
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

  // saveScene(sceneId) で外部から flush 可能にする (EditorPane と同じ契約)。
  // これが無いと agent 書き込み (autoApplyProse) / Codex 改名波及 /
  // post-effect・チャット送信前 flush がリニアの未保存編集を flush できず、
  // stale な DB 本文を read-modify-write して直近編集を消す。
  useEffect(() => {
    registerSaveHandler(sceneId, saveFn);
    return () => unregisterSaveHandler(sceneId, saveFn);
  }, [sceneId, saveFn]);

  // unmount 時に dirty を確実に解除する (EditorPane の cleanup と同じ)。
  // unmount flush (useAutoSave cleanup) が保存を引き受けるため、残った
  // dirty フラグは「閉じたエディタの幽霊 dirty」になる。
  useEffect(() => {
    return () => useTabStore.getState().setTabDirty(sceneId, false);
  }, [sceneId]);

  // 打鍵 debounce タイマーの後始末 (unmount 後の setState を防ぐ)。
  useEffect(() => {
    return () => {
      if (statTimerRef.current != null) {
        window.clearTimeout(statTimerRef.current);
        statTimerRef.current = null;
      }
    };
  }, []);

  // agent 書き込み / Codex 改名波及の resync (setLiveContent) を受信して
  // editor doc を追従させる。受信しないと editor が古い doc を保持し続け、
  // 次の autosave が agent/改名の書き込みを上書きして消す (lost update)。
  useEffect(() => {
    if (!editor) return;
    return subscribeLiveContentRafCoalesced(
      sceneId,
      LINEAR_LIVE_GROUP,
      (next) => {
        isApplyingExternalUpdate.current = true;
        try {
          editor.commands.setContent(
            next as Parameters<typeof editor.commands.setContent>[0],
            { emitUpdate: false },
          );
        } finally {
          isApplyingExternalUpdate.current = false;
        }
        const count = getDocText(editor.state.doc).length;
        setCharCount(count);
        useTreeStore.getState().setCharCount(sceneId, count);
      },
    );
  }, [sceneId, editor]);

  // 外部ファイル変更の取り込み反映 (EditorPane と同じリスナー)。これが無いと
  // file-backed scene の外部編集取り込み後も editor が古い doc を保持し、
  // 次の編集の autosave が取り込んだ外部変更を上書きして消す。
  // dispatch 元 (applyExternalContent) は dirty でないときしか発火しないので
  // pending autosave の cancel で編集を失うことはない。
  useEffect(() => {
    function onExternalReload(e: Event) {
      const detail = (e as CustomEvent<{ sceneId: string; content: string }>)
        .detail;
      const ed = editorRef.current;
      if (detail.sceneId !== sceneId || !ed) return;
      cancel();
      isApplyingExternalUpdate.current = true;
      try {
        const parsed =
          detail.content && detail.content !== "{}"
            ? JSON.parse(detail.content)
            : "";
        ed.commands.setContent(parsed, { emitUpdate: false });
        useTabStore.getState().setTabDirty(sceneId, false);
      } finally {
        isApplyingExternalUpdate.current = false;
      }
      const count = getDocText(ed.state.doc).length;
      setCharCount(count);
      useTreeStore.getState().setCharCount(sceneId, count);
    }
    window.addEventListener("external-mount:reload-scene", onExternalReload);
    return () =>
      window.removeEventListener(
        "external-mount:reload-scene",
        onExternalReload,
      );
  }, [sceneId, cancel]);

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
  useImeDiagnostics(editor);

  // Load content
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;

    async function load() {
      cancel();
      // 再走 (reloadNonce bump) 中の in-flight 窓でも保存を禁止する。
      // 初回 mount は初期値 true なので no-op。ロード成功時のみ false に戻る。
      // 「未ロード/再ロード窓の保存禁止」は本文消失の最終防衛線 (59ab7c94)。
      loadFailedRef.current = true;
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
  }, [sceneId, editor, cancel, isFileBacked, externalReloadNonce]);

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
      {/* 外部 write conflict の解決 UI (タブモードは EditorPane が表示)。
          conflict が無ければ null を返すだけ。Reload は reloadNonce 経由で
          上の load effect に届く。 */}
      <ExternalEditConflictBanner nodeId={sceneId} />
      <div
        className={cn(editorSettings.showLineNumbers && "editor-line-numbers")}
        style={buildEditorContentStyle(editorSettings)}
        // contenteditable は spellcheck 属性を祖先から継承する
        spellCheck={editorSettings.spellCheck}
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
