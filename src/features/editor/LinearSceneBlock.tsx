import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  memo,
  lazy,
  Suspense,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getEditorExtensions } from "@/features/editor/extensions";
import { createEditorProjectionGuardExtension } from "@/features/editor/editorProjectionGuard";
import { resetEditorHistory } from "@/features/editor/editorDocumentLoad";
import {
  getFileBackedEditorExtensions,
  sanitizePastedMarkdown,
} from "@/features/external-mount/fileBackedEditorExtensions";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import {
  handleExternalPaste,
  notePlainPasteKeyDown,
} from "@/features/editor/markdownPaste";
import { useTreeStore } from "@/features/tree/treeStore";
import { getSceneVersion, loadSceneFull } from "@/features/tree/api";
import { persistSceneBody } from "@/features/editor/persistSceneBody";
import {
  registerDiscardHandler,
  registerRecoveryDraftProvider,
  registerSaveHandler,
  retainEditorRecoveryDraft,
  clearRetainedEditorRecoveryDraft,
  unregisterDiscardHandler,
  unregisterRecoveryDraftProvider,
  unregisterSaveHandler,
  dirtyGatedSaveHandler,
  registerPersistedBindingHandler,
  unregisterPersistedBindingHandler,
  announcePersistedBinding,
} from "@/features/editor/editorSaveRegistry";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { subscribeLiveContentRafCoalesced } from "@/features/editor/sceneContentStore";
import {
  externalDocumentStateKey,
  useExternalWriteStore,
} from "@/features/concurrency/externalWriteStore";
import { ExternalEditConflictBanner } from "@/features/editor/ExternalEditConflictBanner";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { useCursorOverlay } from "@/features/editor/useCursorOverlay";
import { useImeDiagnostics } from "@/features/editor/useImeDiagnostics";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCharacterFade } from "@/features/editor/useCharacterFade";
import { useTateChuYoko } from "@/features/editor/useTateChuYoko";
import { useShowInvisibles } from "@/features/editor/useShowInvisibles";
import { useCodexCompletion } from "@/features/editor/codexCompletion/useCodexCompletion";
import { handleZenEscapeKeyDown } from "@/features/editor/zenEscape";
import {
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import {
  useCurrentProject,
  useCurrentProjectId,
} from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { buildEditorContentStyle } from "@/features/editor/editorLayout";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { getDocText } from "@/features/editor/RubyNode";
import {
  countUnitLabelKey,
  countWords,
  primaryCountUnit,
} from "@/features/editor/charCountStats";
import { shouldAutoDraftTransition } from "@/features/editor/autoStatusTransition";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import { summarizeTransactionSteps } from "@/features/editor/transactionLogSummary";
import { EditorContentSkeleton } from "@/features/editor/EditorContentSkeleton";
import i18next from "@/lib/i18n";
import { useTranslation } from "react-i18next";
import type { SceneStatus, TreeNodeData } from "@/features/tree/treeStore";
import { useLinearEditorStore } from "./linearEditorStore";
import { useLinearInlineAi } from "./useLinearInlineAi";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { InlineAIToolbar } from "@/features/editor/inlineAi/InlineAIToolbar";
import { InlineAIPalette } from "@/features/editor/inlineAi/InlineAIPalette";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";
import {
  isInlineAiSaveBlocked,
  shouldHandleEditorUpdate,
} from "@/features/editor/editorEventPolicy";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import {
  AlreadyNotifiedSaveError,
  INLINE_AI_SAVE_BLOCKED_MESSAGE,
} from "@/features/editor/document/saveErrors";
import type { LoadedEditorBinding } from "@/features/editor/document/types";
import {
  shouldClearRetainedEditorRecoveryDraft,
  type EditorSaveAttemptResult,
} from "@/features/editor/document/editorSaveResult";
import {
  createEditorInstanceId,
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import {
  createEditorInputScopeKey,
  markEditorInputReady,
} from "@/features/editor/editorInputReady";
import { getTreeIndex } from "@/features/tree/treeIndex";
import {
  createDocumentSaveSession,
  runCoordinatedDocumentSave,
} from "@/features/editor/document/documentSaveCoordinator";
import {
  handleSceneEditorTransaction,
  type SceneBeatIndexState,
} from "@/features/editor/sceneEditorTransactionPipeline";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";

const LiveReaderCommentsEffect = lazy(
  () => import("@/features/post-effect/LiveReaderCommentsEffect"),
);

// sceneContentStore の source-group sentinel。EditorPane の 0/1、agent resync
// (autoApplyProse / renameEngine) の -1 と衝突しない値であること — 一致すると
// subscribeLiveContentRafCoalesced が「自分の broadcast」とみなして捨てる。
const LINEAR_LIVE_GROUP = 2;

interface LinearSceneBlockProps {
  sceneId: string;
  /** Parent-derived metadata avoids a nodes.find() selector in every block. */
  scene?: TreeNodeData;
  isMounted: boolean;
  isActive: boolean;
  placeholderHeight: number;
  onHeightChange: (sceneId: string, height: number) => void;
  onFocus: (sceneId: string, editor: Editor) => void;
}

function LinearSceneBlockImpl({
  sceneId,
  scene,
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
          scene={scene}
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

export const LinearSceneBlock = memo(LinearSceneBlockImpl);

interface MountedSceneBlockProps {
  sceneId: string;
  scene?: TreeNodeData;
  isActive: boolean;
  /** ロード中に skeleton を placeholder と同寸で出すための推定 block size。 */
  placeholderHeight: number;
  onHeightChange: (sceneId: string, height: number) => void;
  onFocus: (sceneId: string, editor: Editor) => void;
}

function MountedSceneBlock({
  sceneId,
  scene,
  isActive,
  placeholderHeight,
  onHeightChange,
  onFocus,
}: MountedSceneBlockProps) {
  const editorSettings = useEditorSettings();
  const currentProject = useCurrentProject();
  const currentProjectId = useCurrentProjectId();
  const lang = currentProject?.language;
  const liveReaderEnabled = useAnnotationStore((s) => s.liveReaderEnabled);
  const workspacePath = useWorkspaceStore((state) => state.activeWorkspacePath);
  const workspaceOpenRevision = useWorkspaceStore(
    (state) => state.workspaceOpenRevision,
  );
  const inputScopeKey = createEditorInputScopeKey({
    projectId: currentProjectId,
    workspacePath,
    workspaceOpenRevision,
  });
  const isEnglish = lang === "en";
  const filterSource = useAttributionStore((s) => s.filterSource);
  const fallbackNode = useTreeStore((s) =>
    scene ? null : (getTreeIndex(s.nodes).nodeById.get(sceneId) ?? null),
  );
  const activeNode = scene ?? fallbackNode;
  const treeNodeType = activeNode?.nodeType === "note" ? "note" : "scene";
  const nodeStatusRef = useRef<SceneStatus | null>(
    (activeNode?.status as SceneStatus | null | undefined) ?? null,
  );
  nodeStatusRef.current =
    (activeNode?.status as SceneStatus | null | undefined) ?? null;
  const title = activeNode?.title ?? "";
  const isFileBacked = isFileBackedNode(activeNode?.sourceUri);
  const documentKey = useMemo<DocumentKey>(
    () => ({
      kind: "tree",
      id: sceneId,
      storage: isFileBacked ? "file" : "database",
    }),
    [isFileBacked, sceneId],
  );
  const editorInstanceIdRef = useRef(createEditorInstanceId("linear"));
  const [documentSaveSession] = useState(createDocumentSaveSession);
  const isDirtyRef = useRef(false);
  // 外部 write feed (別プロセスの MCP 等) が「dirty でない scene の外部更新」
  // を検知すると nonce を進める。dep に入れて DB から再ロードする
  // (EditorPane の externalReloadNonce と同じ契約)。conflict バナーの
  // "Reload" もこの nonce 経由で再ロードに到達する。
  const externalReloadNonce = useExternalWriteStore(
    (s) => s.reloadNonce[externalDocumentStateKey(documentKey)] ?? 0,
  );
  const inputTargetProjectionKey = JSON.stringify([
    inputScopeKey,
    encodeDocumentKey(documentKey),
    externalReloadNonce,
  ]);
  const hasExternalConflict = useExternalWriteStore((state) =>
    state.conflicts.some(
      (conflict) =>
        externalDocumentStateKey(conflict.documentKey ?? conflict.sceneId) ===
        externalDocumentStateKey(documentKey),
    ),
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const isApplyingExternalUpdate = useRef(false);
  const isApplyingProgrammaticProjectionUpdate = useRef(false);
  const externalUpdateDepthRef = useRef(0);
  const beginApplyingExternalUpdate = useCallback(() => {
    externalUpdateDepthRef.current += 1;
    isApplyingExternalUpdate.current = true;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      externalUpdateDepthRef.current = Math.max(
        0,
        externalUpdateDepthRef.current - 1,
      );
      isApplyingExternalUpdate.current = externalUpdateDepthRef.current > 0;
    };
  }, []);
  const runProgrammaticProjectionUpdate = useCallback((fn: () => void) => {
    isApplyingProgrammaticProjectionUpdate.current = true;
    try {
      fn();
    } finally {
      isApplyingProgrammaticProjectionUpdate.current = false;
    }
  }, []);
  const sceneBeatIndexRef = useRef<SceneBeatIndexState | null>(null);
  const wasEmptyRef = useRef(false);
  // 「ロードに成功した本物の doc」以外は保存禁止 — 空/欠損 doc の autosave が
  // DB の本文を上書きする本文消失の最終防衛線。**初期値は true**: mount 直後は
  // content:"" の空 doc で、ロード完了前に scroll-out で unmount されると
  // useAutoSave の cleanup flush が走る。pending が arm されていた場合、
  // false 始まりだと空 doc がそのまま DB に書き込まれる。
  const loadFailedRef = useRef(true);
  // 編集世代カウンタ (EditorPane と同じ Fix)。onUpdate で dirty を立てるたび
  // ++ し、coreSave は「save 開始時と同世代のときのみ」dirty を解除する。
  // 無条件解除だと保存 (await) 中に入った編集の dirty=true をクロバーし、
  // 外部 flush の dirty ゲート (dirtyGatedSaveHandler) が clean 誤判定 →
  // headless 適用の resync がその編集を上書き消失させる。
  const editGenerationRef = useRef(0);
  const sceneVersionRef = useRef(0);
  const [charCount, setCharCount] = useState(0);
  // タイピング中の文字数同期 debounce タイマー (EditorStatsFooter と同じ
  // 200ms trailing)。
  const statTimerRef = useRef<number | null>(null);
  // ロード完了まで skeleton を placeholder と同寸で表示する (空エディタ +
  // 「0 chars」の一瞬の表示と、高さ崩壊によるスクロールのガタつきを防ぐ)。
  const [isLoading, setIsLoading] = useState(true);
  const [loadReady, setLoadReady] = useState(false);
  const [loadedInputProjectionKey, setLoadedInputProjectionKey] = useState("");
  const loadReadyRef = useRef(false);
  const inputProjectionReadyRef = useRef(false);
  const editorWritableRef = useRef(false);
  const inputProjectionKeyRef = useRef("");
  const inlineAiProjection = useMemo(
    () => ({
      keyRef: inputProjectionKeyRef,
      readyRef: inputProjectionReadyRef,
      writableRef: editorWritableRef,
    }),
    [],
  );
  const publishLoadReady = useCallback((ready: boolean) => {
    loadReadyRef.current = ready;
    setLoadReady(ready);
  }, []);

  const inputProjectionReady =
    loadReady && loadedInputProjectionKey === inputTargetProjectionKey;
  inputProjectionReadyRef.current = inputProjectionReady;
  inputProjectionKeyRef.current = inputTargetProjectionKey;

  // EditorPane と同じスキーマ選択。file-backed scene に full schema を使うと
  // (逆方向も同様に) 未知ノードで setContent が空 doc に化ける。
  const editorExtensions = useMemo(() => {
    const extensions = isFileBacked
      ? getFileBackedEditorExtensions()
      : getEditorExtensions();
    extensions.push(
      createEditorProjectionGuardExtension(
        inputProjectionReadyRef,
        isApplyingProgrammaticProjectionUpdate,
        editorWritableRef,
      ),
    );
    return extensions;
  }, [isFileBacked]);

  const coreSave = useCallback(async (): Promise<EditorSaveAttemptResult> => {
    const ed = editorRef.current;
    if (!ed) return { persisted: false, committed: false };
    if (loadFailedRef.current) {
      debugLog.warn(
        "LinearSceneBlock",
        `save skipped: load failed ${sceneId.slice(0, 8)}`,
      );
      return { persisted: false, committed: false };
    }
    const inlineAi = useInlineAiStore.getState();
    if (
      isInlineAiSaveBlocked({
        inlineAiStatus: inlineAi.status,
        activeEditor: inlineAi.activeEditor,
        editor: ed,
      })
    ) {
      guardInlineAiPending();
      throw new AlreadyNotifiedSaveError(INLINE_AI_SAVE_BLOCKED_MESSAGE);
    }
    debugLog.info(
      "LinearSceneBlock",
      `save ${sceneId.slice(0, 8)}`,
      JSON.stringify({ docLen: getDocText(ed.state.doc).length }),
    );
    // save 開始時の編集世代 (doc 捕捉と同期区間なので取りこぼし無し)。
    const editGenAtStart = editGenerationRef.current;
    // 本文保存の全副作用カスケード (file-backed writeBack / foreshadow・
    // annotation anchor / beat キャッシュ / 帰属 / semantic index) は
    // persistSceneBody が正本。タブエディタ (EditorPane) と同一経路。
    const docAtStart = ed.state.doc;
    const persistedContent = docAtStart.toJSON();
    const persisted = await persistSceneBody(sceneId, docAtStart, {
      baseVersion: sceneVersionRef.current,
    });
    if (persisted?.contentVersion !== undefined) {
      sceneVersionRef.current = persisted.contentVersion;
      announcePersistedBinding(
        documentKey,
        editorInstanceIdRef.current,
        {
          kind: "tree",
          id: sceneId,
          nodeType: treeNodeType,
          storage: isFileBacked ? "file" : "database",
          loadedVersion: persisted.contentVersion,
        },
        persistedContent,
      );
    }
    // 保存成功時のみ dirty 解除 (失敗時は saveFn の catch 側に飛ぶので残る)。
    // かつ保存 (await) 中に編集が入っていた場合は世代不一致 → dirty 維持
    // (editGenerationRef のコメント参照)。
    const committed = editGenerationRef.current === editGenAtStart;
    if (committed) {
      isDirtyRef.current = false;
      useEditorSessionStore
        .getState()
        .setDocumentDirty(documentKey, false, editorInstanceIdRef.current);
    }
    return { persisted: true, committed };
  }, [documentKey, isFileBacked, sceneId, treeNodeType]);

  const saveFn = useCallback(async () => {
    const result = await runCoordinatedDocumentSave(documentKey, coreSave, {
      session: documentSaveSession,
      didPersist: (attempt) => attempt.persisted,
    });
    if (shouldClearRetainedEditorRecoveryDraft(result)) {
      clearRetainedEditorRecoveryDraft(
        documentKey,
        editorInstanceIdRef.current,
      );
    }
  }, [coreSave, documentKey, documentSaveSession]);

  const { schedule, cancel, pause, resume } = useAutoSave(
    saveFn,
    editorSettings.autoSaveDelay,
    {
      onActivate: documentSaveSession.activate,
      onRetire: () => documentSaveSession.retire(documentKey),
      documentKey: () => documentKey,
    },
  );

  useEffect(() => {
    if (hasExternalConflict) pause();
    else resume();
  }, [hasExternalConflict, pause, resume]);

  const handleKeepExternalEdit = useCallback(async () => {
    sceneVersionRef.current = await getSceneVersion(sceneId);
    schedule();
  }, [schedule, sceneId]);

  const handleReloadExternalEdit = useCallback(() => {
    cancel();
  }, [cancel]);

  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: "",
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
        },
        handlePaste(_view, event) {
          // 外部テキストの Markdown 変換は共有ハンドラに委譲 (EditorPane と同経路)。
          // file-backed シーンは ruby 記法を除去してから変換する。
          return handleExternalPaste(
            editorRef.current,
            event,
            isFileBacked ? { sanitize: sanitizePastedMarkdown } : {},
          );
        },
        handleKeyDown(view, event) {
          if (handleZenEscapeKeyDown(view, event)) return true;
          notePlainPasteKeyDown(event);
          return false;
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
        const aiState = useInlineAiStore.getState();
        if (
          !inputProjectionReadyRef.current ||
          (!editorWritableRef.current && !isApplyingExternalUpdate.current)
        ) {
          return;
        }
        // setEditable 等の doc 未変更 'update' を保存に流さない
        // (EditorPane.onUpdate と同じガード — 詳細はそちらのコメント参照)。
        if (
          !shouldHandleEditorUpdate({
            docChanged: transaction.docChanged,
            isApplyingExternalUpdate: isApplyingExternalUpdate.current,
            isInlineAiRollback:
              transaction.getMeta("inlineAiRollback") === true,
            inlineAiStatus: aiState.status,
            activeEditor: aiState.activeEditor,
            editor: e,
          })
        ) {
          return;
        }
        // インライン AI の生成中・diff 表示中は "このエディタ" の編集をオート
        // セーブしない (EditorPane.onUpdate と同じ契約)。未 accept の生成テキスト
        // が autosave で焼き込まれる (= 未帰属保存・本文消失) のを防ぐ。Accept/
        // Reject が idle に戻した時点の reset+dispatch の onUpdate が改めて
        // schedule する。owner 判定 (activeEditor === e) なので、別シーンで AI
        // 実行中でも当シーンの通常編集は通常どおり保存される (リニアは複数
        // エディタがグローバル単一 store を共有するため status だけでは不可)。
        if (loadFailedRef.current) {
          // The shared editable gate and registry projection exclude this
          // surface while loading/failed. Reject any programmatic bystander
          // that still reaches onUpdate instead of arming an unsaveable draft.
          debugLog.warn(
            "LinearSceneBlock",
            `doc changed while unloaded ${sceneId.slice(0, 8)}`,
            {
              sensitivity: "content-derived",
              fields: {
                steps: summarizeTransactionSteps(transaction.steps),
              },
            },
          );
          return;
        }
        schedule();
        // 未保存編集の検出は dirtyTabIds が正本 (external-mount の conflict
        // 検出・post-effect/チャットの flush 列挙が参照する)。リニアはタブを
        // 持たないが、この Set に乗らないと外部変更が未保存編集をサイレントに
        // 上書きする。解除は coreSave 成功時と unmount cleanup。
        // 世代カウンタは dirty 立てと同時に ++ (coreSave の条件付き解除用)。
        editGenerationRef.current += 1;
        isDirtyRef.current = true;
        useEditorSessionStore
          .getState()
          .setDocumentDirty(documentKey, true, editorInstanceIdRef.current);

        // Auto-transition outline → draft: wasEmptyRef が true の間だけ
        // 全文 walk する (EditorPane.onUpdate と同じ制限 — 一度本文を観測
        // したらこの分岐は恒久 skip)。
        if (wasEmptyRef.current) {
          const count = getDocText(e.state.doc).length;
          if (count > 0) {
            wasEmptyRef.current = false;
            if (shouldAutoDraftTransition(count, true, nodeStatusRef.current)) {
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
      onTransaction({ transaction }) {
        handleSceneEditorTransaction({
          transaction,
          id: sceneId,
          isEntryMode: false,
          isCodexMode: false,
          isSnippetMode: false,
          isChronicleEventMode: false,
          isApplyingExternalUpdate: isApplyingExternalUpdate.current,
          beatIndexRef: sceneBeatIndexRef,
        });
      },
      onFocus() {
        const ed = editorRef.current;
        // useEditor callback configuration is stable across renders, so avoid
        // capturing the initial `loadReady=false` state forever.
        if (
          ed &&
          inputProjectionReadyRef.current &&
          editorWritableRef.current
        ) {
          onFocus(sceneId, ed);
        }
      },
    },
    [editorExtensions],
  );

  editorRef.current = editor;

  const editorReadOnly = useLicenseEditableSync(
    editor,
    !inputProjectionReady,
    documentKey,
  );
  const editorWritable = inputProjectionReady && !editorReadOnly;
  editorWritableRef.current = editorWritable;
  useLayoutEffect(() => {
    const state = useLinearEditorStore.getState();
    if (!editorWritable && state.focusedSceneId === sceneId) {
      state.setFocusedEditor(null, null);
    }
  }, [editorWritable, sceneId]);

  // inline-AI がこのブロックで生成/プレビュー中 (非 idle = 未 accept の
  // テキストが doc に入っている) は、arm 済みの autosave タイマーも解除する
  // (EditorPane と同じ Fix)。onUpdate の gate は「新規 schedule の抑止」しか
  // せず、直前の編集で arm 済みのタイマーは発火して未 accept のプレビュー
  // 本文ごと persist してしまう (無帰属 AI テキストの焼き込み)。owner 判定は
  // onUpdate と同じ activeEditor 一致 (リニアは複数エディタがグローバル単一
  // store を共有するため status だけでは不可)。accept/reject で idle に戻る
  // と reset+dispatch の onUpdate が改めて schedule するので、消した打鍵分の
  // 保存は取りこぼされない。save 関数側でも owner 判定を行うため、unmount
  // flush / workspace quiesce を含む全てのこのブロック経由の入口で拒否する。
  const inlineAiStatus = useInlineAiStore((s) => s.status);
  const inlineAiOwnerEditor = useInlineAiStore((s) => s.activeEditor);
  useEffect(() => {
    if (inlineAiStatus !== "idle" && inlineAiOwnerEditor === editor) {
      cancel();
    }
  }, [inlineAiStatus, inlineAiOwnerEditor, editor, cancel]);

  // contenteditable の accessible name。editorProps.attributes は生成時に固定
  // されるため、リネームに追従できるよう view.dom へ動的に付与する
  // (EditorPane と同じ契約)。
  const { t } = useTranslation();
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dom.setAttribute(
      "aria-label",
      title
        ? t("editor.a11y.editorBody", { title })
        : t("editor.a11y.editorBodyUntitled"),
    );
  }, [editor, title, t]);

  // SlashCommandExtension が dispatch する inlineai:slash-command の実行配線
  // (構造挿入 sceneBeat + AI 生成系の generate/palette/toolbar)。グローバル単一
  // store と複数ブロックの両立 (owner ルーティング / 1 セッション / 中止) は
  // useLinearInlineAi に集約する。file-backed は Inline AI 非対象なので null を渡す。
  const inlineAi = useLinearInlineAi({
    sceneId,
    editor,
    inlineAiEditor: isFileBacked ? null : editor,
    projection: inlineAiProjection,
    projectionKey: inputTargetProjectionKey,
    projectionReady: inputProjectionReady,
    projectionWritable: editorWritable,
  });

  // saveScene(sceneId) で外部から flush 可能にする (EditorPane と同じ契約)。
  // これが無いと agent 書き込み (autoApplyProse) / Codex 改名波及 /
  // post-effect・チャット送信前 flush がリニアの未保存編集を flush できず、
  // stale な DB 本文を read-modify-write して直近編集を消す。
  // dirty ゲート付き: clean な editor への外部 flush は no-op (詳細は
  // dirtyGatedSaveHandler)。リニアの dirty 正本は dirtyTabIds
  // (onUpdate で同期セット / coreSave 成功時とunmount で解除)。
  useLayoutEffect(() => {
    const instanceId = editorInstanceIdRef.current;
    const handler = dirtyGatedSaveHandler(() => isDirtyRef.current, saveFn);
    const recoveryProvider = () => {
      const currentEditor = editorRef.current;
      if (!isDirtyRef.current || !currentEditor || currentEditor.isDestroyed) {
        return null;
      }
      return {
        plainText: currentEditor.getText(),
        prosemirror: currentEditor.getJSON(),
      };
    };
    registerSaveHandler(documentKey, instanceId, handler);
    registerRecoveryDraftProvider(documentKey, instanceId, recoveryProvider);
    return () => {
      const draft = recoveryProvider();
      if (draft) {
        retainEditorRecoveryDraft(documentKey, instanceId, draft);
      }
      unregisterSaveHandler(documentKey, instanceId, handler);
      unregisterRecoveryDraftProvider(
        documentKey,
        instanceId,
        recoveryProvider,
      );
    };
  }, [documentKey, saveFn]);

  // A split tab editor can persist the same scene while this linear block is
  // mounted. Adopt its returned OCC version before the next linear save.
  useEffect(() => {
    const instanceId = editorInstanceIdRef.current;
    const persistedBindingHandler = (
      binding: LoadedEditorBinding,
      persistedContent?: object,
    ) => {
      if (binding.kind !== "tree" || binding.id !== sceneId) return;
      if (isDirtyRef.current) return;
      if (binding.loadedVersion < sceneVersionRef.current) return;
      const currentEditor = editorRef.current;
      if (persistedContent && currentEditor && !currentEditor.isDestroyed) {
        const finishExternalUpdate = beginApplyingExternalUpdate();
        try {
          runProgrammaticProjectionUpdate(() => {
            currentEditor.commands.setContent(persistedContent, {
              emitUpdate: false,
              errorOnInvalidContent: true,
            });
          });
        } catch (error) {
          debugLog.error(
            "LinearSceneBlock",
            `peer snapshot failed ${sceneId.slice(0, 8)}`,
            errorDetail(error),
          );
          return;
        } finally {
          finishExternalUpdate();
        }
        const count = getDocText(currentEditor.state.doc).length;
        setCharCount(count);
        useTreeStore.getState().setCharCount(sceneId, count);
      }
      sceneVersionRef.current = binding.loadedVersion;
    };
    registerPersistedBindingHandler(
      documentKey,
      instanceId,
      persistedBindingHandler,
    );
    return () =>
      unregisterPersistedBindingHandler(
        documentKey,
        instanceId,
        persistedBindingHandler,
      );
  }, [
    beginApplyingExternalUpdate,
    documentKey,
    runProgrammaticProjectionUpdate,
    sceneId,
  ]);

  useEffect(() => {
    const instanceId = editorInstanceIdRef.current;
    const discard = () => {
      cancel();
      isDirtyRef.current = false;
      useEditorSessionStore
        .getState()
        .setDocumentDirty(documentKey, false, instanceId);
      useExternalWriteStore.getState().shiftConflict(documentKey);
    };
    registerDiscardHandler(documentKey, instanceId, discard);
    return () => unregisterDiscardHandler(documentKey, instanceId, discard);
  }, [cancel, documentKey]);

  // unmount 時に dirty を確実に解除する (EditorPane の cleanup と同じ)。
  // unmount flush (useAutoSave cleanup) が保存を引き受けるため、残った
  // dirty フラグは「閉じたエディタの幽霊 dirty」になる。
  useEffect(() => {
    const instanceId = editorInstanceIdRef.current;
    return () => {
      isDirtyRef.current = false;
      useEditorSessionStore
        .getState()
        .setDocumentDirty(documentKey, false, instanceId);
    };
  }, [documentKey]);

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
    const subscribedProjectionKey = inputProjectionKeyRef.current;
    return subscribeLiveContentRafCoalesced(
      documentKey,
      LINEAR_LIVE_GROUP,
      (next) => {
        if (
          !inputProjectionReadyRef.current ||
          inputProjectionKeyRef.current !== subscribedProjectionKey
        ) {
          return;
        }
        // Do not replace a local draft with a queued full-document mirror
        // update. The dirty editor remains the writer and must rebase or
        // surface an OCC conflict instead of adopting the peer version.
        if (isDirtyRef.current) return;
        const finishExternalUpdate = beginApplyingExternalUpdate();
        try {
          editor.commands.setContent(
            next as Parameters<typeof editor.commands.setContent>[0],
            { emitUpdate: false },
          );
        } finally {
          finishExternalUpdate();
        }
        const count = getDocText(editor.state.doc).length;
        setCharCount(count);
        useTreeStore.getState().setCharCount(sceneId, count);
      },
    );
  }, [
    beginApplyingExternalUpdate,
    documentKey,
    editor,
    inputTargetProjectionKey,
    sceneId,
  ]);

  // CodexQuick: only update matchedIds for the active scene
  useCodexHighlight(editor, isActive ? undefined : { skipMatchedIds: true });
  // EditorPane と同じく帰属系は DB-native 限定 (file-backed schema に
  // authorship mark が無い)。
  useAttribution(isFileBacked ? null : editor);
  // active シーンの editor を Toolbar / SceneMetaPanel がフォーカス無しで
  // 参照できるよう registry へ登録する (linearEditorStore.editorsById)。
  useEffect(() => {
    if (!editor || !inputProjectionReady || !editorWritable) return;
    useLinearEditorStore.getState().registerEditor(sceneId, editor);
    return () => {
      useLinearEditorStore.getState().unregisterEditor(sceneId, editor);
    };
  }, [sceneId, editor, editorWritable, inputProjectionReady]);
  const inputReadyMarkedRef = useRef(false);
  useEffect(() => {
    if (
      !isActive ||
      !loadReady ||
      loadedInputProjectionKey !== inputTargetProjectionKey ||
      !editor ||
      editorReadOnly
    ) {
      if (
        !isActive ||
        !loadReady ||
        loadedInputProjectionKey !== inputTargetProjectionKey
      ) {
        inputReadyMarkedRef.current = false;
      }
      return;
    }
    if (inputReadyMarkedRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (
        editor.isDestroyed ||
        inputReadyMarkedRef.current ||
        !editor.isEditable
      ) {
        return;
      }
      if (
        markEditorInputReady(documentKey, editor.view.dom, editor.isEditable, {
          authority: "linear",
          groupIndex: null,
          foreground: isActive,
          scopeKey: inputScopeKey,
        })
      ) {
        inputReadyMarkedRef.current = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    documentKey,
    editor,
    editorReadOnly,
    inputScopeKey,
    inputTargetProjectionKey,
    isActive,
    loadedInputProjectionKey,
    loadReady,
  ]);
  useCharacterFade(editor);
  // スムースキャレット (EditorPane と同じ overlay)。focus 中の block でのみ
  // 表示される (overlay は view.hasFocus() でゲートされる)。
  useCursorOverlay(editor);
  useImeDiagnostics(editor);
  useTateChuYoko(editor);
  useShowInvisibles(editor);
  useCodexCompletion(editor);

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
      publishLoadReady(false);
      setLoadedInputProjectionKey("");
      // State/effect propagation is asynchronous. Close the native input
      // window synchronously before the first await on both initial load and
      // external reload; only the shared hook may re-enable after success.
      editor.setEditable(false, false);
      const finishExternalUpdate = beginApplyingExternalUpdate();
      try {
        const full = await loadSceneFull(sceneId);
        if (cancelled) return;
        sceneVersionRef.current = full.version ?? 0;
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
          publishLoadReady(false);
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
        finishExternalUpdate();
      }

      const text = getDocText(editor!.state.doc);
      const count = text.length;
      setCharCount(count);
      setIsLoading(false);
      wasEmptyRef.current = count === 0;
      useTreeStore.getState().setCharCount(sceneId, count);

      // Load authorship spans. This sidecar is optional: failure must not leave
      // a successfully loaded body permanently read-only.
      try {
        const spans = await loadAuthorshipSpans(sceneId);
        if (!cancelled && spans.length > 0) {
          const markData = spansToMarkData(spans);
          const authorshipType = editor!.schema.marks["authorship"];
          if (authorshipType) {
            const finishExternalUpdate = beginApplyingExternalUpdate();
            try {
              runProgrammaticProjectionUpdate(() => {
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
              });
            } finally {
              finishExternalUpdate();
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          debugLog.error(
            "LinearSceneBlock",
            `load authorship failed ${sceneId.slice(0, 8)}`,
            errorDetail(error),
          );
        }
      }

      if (!cancelled) {
        resetEditorHistory(editor!.view);
        isDirtyRef.current = false;
        useEditorSessionStore
          .getState()
          .setDocumentDirty(documentKey, false, editorInstanceIdRef.current);
        useExternalWriteStore.getState().shiftConflict(documentKey);
        // Re-enable input only after authorship application and history/dirty
        // reset. Earlier publication creates a window where user edits are
        // later cleared as if they belonged to document hydration.
        loadFailedRef.current = false;
        setLoadedInputProjectionKey(inputTargetProjectionKey);
        publishLoadReady(true);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [
    sceneId,
    editor,
    cancel,
    isFileBacked,
    externalReloadNonce,
    documentKey,
    inputTargetProjectionKey,
    publishLoadReady,
    beginApplyingExternalUpdate,
    runProgrammaticProjectionUpdate,
  ]);

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

  // 一次メトリクスは PROJECT 言語で決める (en=語数 / それ以外=文字数)。
  // tree 同期する charCount は常に文字数のまま。語数は表示時に live doc から導出
  // (charCount を本文変化の proxy として再計算; ja では算出しない)。
  const primaryUnit = primaryCountUnit(lang);
  // charCount (debounce で更新される文字数) を本文変化の proxy 兼空判定に使う:
  // 空 doc は語数 0 で countWords をスキップでき、charCount 変化で再計算が走る。
  const wordCount = useMemo(
    () =>
      primaryUnit === "word" && editor && charCount > 0
        ? countWords(getDocText(editor.state.doc), lang)
        : 0,
    [primaryUnit, lang, editor, charCount],
  );
  const primaryCount = primaryUnit === "word" ? wordCount : charCount;
  const primaryUnitLabel = i18next.t(countUnitLabelKey(primaryUnit));

  return (
    <div
      ref={containerRef}
      data-editor-target-document-id={sceneId}
      data-editor-target-document-kind="tree"
      data-editor-target-document-key={encodeDocumentKey(documentKey)}
      data-editor-target-projection-key={inputTargetProjectionKey}
      data-editor-loaded-document-id={loadReady ? sceneId : ""}
      data-editor-loaded-document-key={
        loadReady ? encodeDocumentKey(documentKey) : ""
      }
      data-editor-loaded-document-kind={loadReady ? "tree" : ""}
      data-editor-loaded-projection-key={loadedInputProjectionKey}
      data-editor-document-loading={isLoading ? "true" : "false"}
      data-editor-input-authority="linear"
      data-editor-input-group="none"
      data-editor-input-scope-key={inputScopeKey}
      data-editor-loaded-scope-key={
        loadReady && loadedInputProjectionKey === inputTargetProjectionKey
          ? inputScopeKey
          : ""
      }
      data-editor-input-foreground={isActive ? "true" : "false"}
    >
      {isActive && loadReady && !isLoading && liveReaderEnabled && (
        <Suspense fallback={null}>
          <LiveReaderCommentsEffect
            editor={editor}
            sceneId={sceneId}
            enabled
            persona={lang?.startsWith("en") ? "General Reader" : "一般読者"}
            genre={currentProject?.genre ?? null}
            targetReaders={currentProject?.targetReaders ?? null}
            lang={lang ?? "ja"}
          />
        </Suspense>
      )}
      {/* 外部 write conflict の解決 UI (タブモードは EditorPane が表示)。
          conflict が無ければ null を返すだけ。Reload は reloadNonce 経由で
          上の load effect に届く。 */}
      <ExternalEditConflictBanner
        nodeId={sceneId}
        documentKey={documentKey}
        editorInstanceId={editorInstanceIdRef.current}
        onKeepMine={handleKeepExternalEdit}
        onReload={handleReloadExternalEdit}
      />
      <div
        className={cn(
          editorSettings.showLineNumbers && "editor-line-numbers",
          editorSettings.showInvisibles && "editor-show-invisibles",
          isEnglish && "editor-en-typography",
        )}
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
              {primaryCount.toLocaleString()} {primaryUnitLabel}
            </div>
          </div>
        </div>
      </div>
      {/* 引数入力パレットは fixed overlay。開いている owner ブロックだけが
          マウントする (画面内で 1 個)。isActive ではなく paletteOpen でゲート
          するのは、モーダル表示中のスクロールで active が切り替わっても
          入力中のパレットが消えないようにするため。 */}
      {editor && inlineAi.paletteOpen && (
        <InlineAIPalette
          editor={editor}
          open={inlineAi.paletteOpen}
          preselectedCommand={inlineAi.paletteCommand}
          onClose={inlineAi.closePalette}
          onSubmit={inlineAi.submitPalette}
        />
      )}
      {/* diff の Accept/Reject/Retry ツールバー。owner ブロックだけがマウント
          する (画面に 1 個・keydown も 1 本)。可視性は status で自前にゲートする。 */}
      {inlineAi.isOwner && (
        <InlineAIToolbar
          onAccept={inlineAi.onAccept}
          onReject={inlineAi.onReject}
          onRetry={inlineAi.onRetry}
          anchorRef={containerRef}
          isOwner={inlineAi.isOwner}
        />
      )}
    </div>
  );
}
