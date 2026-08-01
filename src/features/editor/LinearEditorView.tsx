import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTreeStore } from "@/features/tree/treeStore";
import { flattenSceneNodes, getTreeIndex } from "@/features/tree/treeIndex";
import { useLinearEditorStore } from "./linearEditorStore";
import { LinearSceneBlock } from "./LinearSceneBlock";
import { AccessibleLinearReaderDialog } from "./AccessibleLinearReaderDialog";
import { Toolbar } from "@/features/editor/Toolbar";
import { FindReplaceBar } from "@/features/editor/FindReplaceBar";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { EditorContextMenu } from "@/features/editor/EditorContextMenu";
import { CodexSemanticLinkPopover } from "@/features/editor/CodexSemanticLinkPopover";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { SceneMetaPanel } from "@/features/editor/SceneMetaPanel";
import { MentionPopup } from "@/features/chat/components/MentionPopup";
import { SlashCommandPopup } from "@/features/editor/inlineAi/SlashCommandPopup";
import type {
  CodexMentionPopupState,
  MentionItem,
  MentionRole,
} from "@/features/codex/CodexMentionExtension";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import {
  buildEditorMeasureStyle,
  canScrollBlockAxis,
  getBlockStartOffset,
  getLogicalScrollOffset,
  pickActiveSceneId,
  setLogicalScrollOffset,
} from "@/features/editor/editorLayout";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useVerticalWheelScroll } from "@/features/editor/useVerticalWheelScroll";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { isMac } from "@/lib/platform";
import {
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";
import type { Editor } from "@tiptap/core";
import { buildEditorPaperStyle } from "@/features/editor/editorPaperStyle";
import { useZenBackgroundEnabled } from "@/features/editor/zen/useZenBackgroundAppearance";
import { useEditorSessionStore } from "./editorSessionStore";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";
import {
  buildLinearPinnedIndexes,
  extractLinearVirtualIndexes,
} from "./linearVirtualization";
import {
  measurePerfSync,
  recordCounter,
  recordMaxCounter,
} from "@/lib/perfLog";

const DEFAULT_HEIGHT = 300;
const DEBOUNCE_ACTIVE_MS = 100;

export function LinearEditorView() {
  const editorSettings = useEditorSettings();
  const backgroundEnabled = useZenBackgroundEnabled();
  const verticalMode = editorSettings.verticalMode;
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const dirtyDocumentIds = useEditorSessionStore(
    (state) => state.dirtyDocumentIds,
  );
  const externalConflicts = useExternalWriteStore((state) => state.conflicts);
  const conflictedSceneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const conflict of externalConflicts) {
      if (
        conflict.documentKey === undefined ||
        conflict.documentKey.kind === "tree"
      ) {
        ids.add(conflict.documentKey?.id ?? conflict.sceneId);
      }
    }
    return ids;
  }, [externalConflicts]);

  const focusedEditor = useLinearEditorStore((s) => s.focusedEditor);
  const focusedSceneId = useLinearEditorStore((s) => s.focusedSceneId);
  const pendingScrollToId = useLinearEditorStore((s) => s.pendingScrollToId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const heightMapRef = useRef<Map<string, number>>(new Map());
  const visibleRectsRef = useRef<Map<string, DOMRectReadOnly>>(new Map());
  const rowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const activeObserverRef = useRef<IntersectionObserver | null>(null);
  const isScrollDetectionRef = useRef(false);
  const activeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Capture the active scene at mount time before any observer overwrites it
  const initialActiveSceneIdRef = useRef(activeSceneId);
  const initialNavigationStartedRef = useRef(false);
  // プログラムスクロール (タブ切替ナビ / 初期スクロール) の進行中ターゲット。
  // 進行中はスクロール由来の active 検出を止める — placeholder 高さ確定で
  // 着地点がズレる途中経過を「ユーザーが見ているシーン」と誤認すると、
  // setActiveScene → openPreview が無関係なプレビュータブを開いてしまう。
  const navigatingRef = useRef<string | null>(null);
  const navCleanupRef = useRef<(() => void) | null>(null);

  const [activeId, setActiveId] = useState<string | null>(activeSceneId);
  // editorsById 全体を購読すると、スクロールでブロックが mount/unmount する
  // たび (register/unregister の spread 差し替え) に view 全体が再レンダーされ
  // scenes.map が全シーン分再実行される。active シーンの editor だけを引く
  // selector なら、active 以外の登録/解除では出力同一 (Object.is) で
  // 再レンダーされない。
  const activeRegisteredEditor = useLinearEditorStore((s) =>
    activeId !== null ? (s.editorsById[activeId] ?? null) : null,
  );
  // IntersectionObserver を activeId 変更のたびに張り替えないための ref ミラー
  // (張り替えの瞬間に交差イベントを取りこぼし、スクロール中の active 同期が
  // 不安定になる)。
  const activeIdRef = useRef<string | null>(activeSceneId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [mentionPopup, setMentionPopupState] =
    useState<CodexMentionPopupState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  // Shared per-parent index preserves DFS order and keeps unreachable scenes.
  const treeIndex = useMemo(() => getTreeIndex(nodes), [nodes]);
  const scenes = useMemo(() => flattenSceneNodes(treeIndex), [treeIndex]);
  const sceneIds = useMemo(() => scenes.map((scene) => scene.id), [scenes]);
  const sceneIndexById = useMemo(
    () => new Map(sceneIds.map((id, index) => [id, index])),
    [sceneIds],
  );
  const focusedScene =
    focusedSceneId === null
      ? null
      : (treeIndex.nodeById.get(focusedSceneId) ?? null);
  const canEditCodexSemanticLink =
    focusedScene?.nodeType === "scene" &&
    !isFileBackedNode(focusedScene.sourceUri) &&
    focusedEditor?.isEditable === true;

  const pinnedIndexes = useMemo(
    () =>
      buildLinearPinnedIndexes(
        sceneIds,
        activeId,
        dirtyDocumentIds,
        conflictedSceneIds,
      ),
    [activeId, conflictedSceneIds, dirtyDocumentIds, sceneIds],
  );
  const rangeExtractor = useCallback(
    (range: {
      startIndex: number;
      endIndex: number;
      overscan: number;
      count: number;
    }) => extractLinearVirtualIndexes(range, pinnedIndexes),
    [pinnedIndexes],
  );
  const linearVirtualizer = useVirtualizer({
    horizontal: verticalMode,
    isRtl: verticalMode,
    count: scenes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      heightMapRef.current.get(scenes[index]?.id ?? "") ??
      DEFAULT_HEIGHT + (index > 0 ? 49 : 0),
    overscan: 3,
    getItemKey: (index) => scenes[index]?.id ?? index,
    rangeExtractor,
    scrollToFn: (offset, { adjustments = 0, behavior }) => {
      const element = scrollRef.current;
      if (!element) return;
      const target = offset + adjustments;
      element.scrollTo(
        verticalMode ? { left: -target, behavior } : { top: target, behavior },
      );
    },
  });

  const scheduleActiveDetection = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (navigatingRef.current) return;
    if (activeDebounceRef.current) clearTimeout(activeDebounceRef.current);
    activeDebounceRef.current = setTimeout(() => {
      if (navigatingRef.current) return;
      const closestId = measurePerfSync("linear.activeDetection", () => {
        const visibleRects = [...visibleRectsRef.current].map(([id, rect]) => ({
          id,
          rect,
        }));
        recordMaxCounter(
          "linear.activeDetection.maxVisibleRects",
          visibleRects.length,
        );
        // The application reads one container rect and zero scene rects.
        // Scene geometry comes from IntersectionObserver entries.
        recordCounter("linear.activeDetection.containerRectReads");
        recordCounter("linear.activeDetection.sceneRectReads", 0);
        return pickActiveSceneId(
          container.getBoundingClientRect(),
          visibleRects,
          verticalMode,
        );
      });
      if (!closestId || closestId === activeIdRef.current) return;
      setActiveId(closestId);
      isScrollDetectionRef.current = true;
      useTreeStore.getState().setActiveScene(closestId);
      queueMicrotask(() => {
        isScrollDetectionRef.current = false;
      });
    }, DEBOUNCE_ACTIVE_MS);
  }, [verticalMode]);

  // The observer supplies boundingClientRect for intersecting virtual rows.
  // Active detection compares only this small map and never reads every scene.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const visibleRects = visibleRectsRef.current;
    visibleRects.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.linearSceneId;
          if (!id) continue;
          if (entry.isIntersecting) {
            visibleRects.set(id, entry.boundingClientRect);
          } else {
            visibleRects.delete(id);
          }
        }
        scheduleActiveDetection();
      },
      { root: container, rootMargin: "0px", threshold: [0, 0.5, 1] },
    );
    activeObserverRef.current = observer;
    for (const element of rowElementsRef.current.values()) {
      observer.observe(element);
    }

    return () => {
      observer.disconnect();
      if (activeObserverRef.current === observer) {
        activeObserverRef.current = null;
      }
      visibleRects.clear();
      if (activeDebounceRef.current) clearTimeout(activeDebounceRef.current);
    };
  }, [scheduleActiveDetection]);

  // Measurements belong to one physical block axis; invalidate on mode flips.
  useEffect(() => {
    heightMapRef.current.clear();
    (
      linearVirtualizer as typeof linearVirtualizer & {
        measure?: () => void;
      }
    ).measure?.();
  }, [linearVirtualizer, verticalMode]);

  // Virtualizer navigation first materializes the target, then a short
  // re-anchor loop absorbs variable-height measurements as editors load.
  const navigateToScene = useCallback(
    (targetId: string) => {
      const container = scrollRef.current;
      const targetIndex = sceneIndexById.get(targetId);
      if (!container || targetIndex === undefined) return;

      navCleanupRef.current?.();
      navigatingRef.current = targetId;
      linearVirtualizer.scrollToIndex(targetIndex, { align: "start" });

      let done = false;
      let stableTicks = 0;
      let rafId = 0;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(rafId);
        if (timeout) clearTimeout(timeout);
        if (navigatingRef.current === targetId) navigatingRef.current = null;
        if (navCleanupRef.current === cleanup) navCleanupRef.current = null;
      };
      const cleanup = finish;

      const step = () => {
        if (done) return;
        const vertical = useSettingsStore
          .getState()
          .getBoolean("editor.verticalMode", false);
        const target = rowElementsRef.current.get(targetId);
        if (!target) {
          linearVirtualizer.scrollToIndex(targetIndex, { align: "start" });
          return;
        }
        const offset = getBlockStartOffset(
          container.getBoundingClientRect(),
          target.getBoundingClientRect(),
          vertical,
        );
        if (Math.abs(offset) < 2) {
          stableTicks += 1;
          return;
        }
        const before = getLogicalScrollOffset(container, vertical);
        setLogicalScrollOffset(container, before + offset, vertical);
        const after = getLogicalScrollOffset(container, vertical);
        stableTicks =
          after === before && canScrollBlockAxis(container, vertical)
            ? stableTicks + 1
            : 0;
      };
      const tick = () => {
        if (done) return;
        step();
        if (stableTicks >= 3) {
          finish();
          return;
        }
        rafId = requestAnimationFrame(tick);
      };
      step();
      rafId = requestAnimationFrame(tick);
      timeout = setTimeout(finish, 2000);
      navCleanupRef.current = cleanup;
    },
    [linearVirtualizer, sceneIndexById],
  );

  // Unmount: stop any in-flight navigation
  useEffect(() => {
    return () => {
      navCleanupRef.current?.();
      // React Strict Mode replays mount effects after cleanup. Let that replay
      // restart the initial navigation that this cleanup just cancelled.
      initialNavigationStartedRef.current = false;
    };
  }, []);

  // --- Initial scroll: jump to active scene on mount ---
  // At mount time, all scenes are short placeholders so the container may not
  // be scrollable yet — navigateToScene's grow-retry handles it.
  useEffect(() => {
    const targetId = initialActiveSceneIdRef.current;
    if (
      initialNavigationStartedRef.current ||
      !targetId ||
      !sceneIndexById.has(targetId)
    ) {
      return;
    }
    initialNavigationStartedRef.current = true;
    navigateToScene(targetId);
  }, [navigateToScene, sceneIndexById]);

  // --- External navigation: scroll to scene ---
  useEffect(() => {
    if (!activeSceneId) return;
    // Skip if this change came from scroll detection
    if (isScrollDetectionRef.current) return;
    // Skip if already viewing this scene
    if (activeSceneId === activeId) return;

    setActiveId(activeSceneId);
    navigateToScene(activeSceneId);
  }, [activeSceneId, activeId, navigateToScene]);

  // --- Consume pendingScrollToId ---
  useEffect(() => {
    if (!pendingScrollToId) return;
    useLinearEditorStore.getState().setPendingScrollToId(null);
    navigateToScene(pendingScrollToId);
  }, [pendingScrollToId, navigateToScene]);

  const registerRowElement = useCallback(
    (sceneId: string, element: HTMLDivElement | null) => {
      const previous = rowElementsRef.current.get(sceneId);
      if (previous && previous !== element) {
        activeObserverRef.current?.unobserve(previous);
      }
      if (!element) {
        rowElementsRef.current.delete(sceneId);
        visibleRectsRef.current.delete(sceneId);
        return;
      }
      rowElementsRef.current.set(sceneId, element);
      linearVirtualizer.measureElement(element);
      activeObserverRef.current?.observe(element);
    },
    [linearVirtualizer],
  );

  // --- Height change callback ---
  const handleHeightChange = useCallback((sceneId: string, height: number) => {
    heightMapRef.current.set(sceneId, height);
  }, []);

  // --- Focus callback ---
  const handleFocus = useCallback((sceneId: string, editor: Editor) => {
    useLinearEditorStore.getState().setFocusedEditor(editor, sceneId);
    setActiveId(sceneId);
    isScrollDetectionRef.current = true;
    useTreeStore.getState().setActiveScene(sceneId);
    queueMicrotask(() => {
      isScrollDetectionRef.current = false;
    });
  }, []);

  // active シーンの editor (フォーカス不要)。Toolbar / FindReplaceBar /
  // SceneMetaPanel に常時供給する — focusedEditor だとクリックするまで null で
  // ツールバーが消える (Toolbar は editor 無しのとき null を返す)。
  const activeEditor = activeRegisteredEditor ?? focusedEditor;

  // 縦書きではホイールの縦回転を読み進み方向 (横) のスクロールに変換する
  useVerticalWheelScroll(scrollRef, verticalMode);

  // --- Scene meta panel (EditorPane と同じ設定キー・レイアウト永続化) ---
  const sceneMetaPanelOpen = editorSettings.sceneMetaPanelOpen;
  const sceneMetaPanelWidth = editorSettings.sceneMetaPanelWidth;
  const zenMode = useCursorSettingsStore((state) => state.zenMode);
  const isPanelVisible = sceneMetaPanelOpen && activeId != null && !zenMode;
  const handleTogglePanel = useCallback(() => {
    useSettingsStore
      .getState()
      .set("editor.sceneMetaPanelOpen", String(!sceneMetaPanelOpen));
  }, [sceneMetaPanelOpen]);
  const handlePanelLayoutChanged = useCallback(
    (layout: Record<string, number>) => {
      const w = layout["scene-meta"];
      if (w !== undefined) {
        useSettingsStore
          .getState()
          .set("editor.sceneMetaPanelWidth", String(Math.round(w)));
      }
    },
    [],
  );
  const setMentionPopup = useCallback((s: CodexMentionPopupState | null) => {
    setMentionPopupState(s);
    setMentionIndex(0);
  }, []);
  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      mentionPopup?.command?.(item);
      setMentionPopupState(null);
    },
    [mentionPopup],
  );
  const handleMentionSelectWithRole = useCallback(
    (item: MentionItem, role: MentionRole) => {
      mentionPopup?.command?.(item, role);
      setMentionPopupState(null);
    },
    [mentionPopup],
  );

  // --- Keyboard shortcuts ---
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const merged = getMergedBindings();
      const mac = isMac();
      if (matchesBinding(e, merged.find ?? "", mac)) {
        e.preventDefault();
        setFindOpen(true);
        setFindShowReplace(false);
      } else if (!mac && matchesBinding(e, merged.findReplace ?? "", mac)) {
        // findReplace is Windows/Linux only — ⌘H is macOS "Hide".
        e.preventDefault();
        setFindOpen(true);
        setFindShowReplace(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const scrollContainer = (
    <div
      ref={scrollRef}
      className={`glass-editor-body relative isolate flex-1 overflow-auto bg-transparent text-content-foreground-secondary p-4${verticalMode ? " editor-vertical" : ""}`}
    >
      <div
        ref={editorContainerRef}
        data-zen-editor-column={zenMode ? "true" : undefined}
        className="zen-editor-paper"
        style={{
          ...buildEditorMeasureStyle(editorSettings.maxContentWidth),
          ...buildEditorPaperStyle({
            enabled: backgroundEnabled,
          }),
          blockSize: `${linearVirtualizer.getTotalSize()}px`,
        }}
      >
        {linearVirtualizer.getVirtualItems().map((virtualItem) => {
          const scene = scenes[virtualItem.index];
          if (!scene) return null;
          return (
            <div
              key={scene.id}
              ref={(element) => registerRowElement(scene.id, element)}
              data-index={virtualItem.index}
              data-linear-scene-id={scene.id}
              data-linear-virtual-row=""
              style={{
                position: "absolute",
                insetBlockStart: 0,
                insetInline: 0,
                inlineSize: "100%",
                transform: verticalMode
                  ? `translateX(${-virtualItem.start}px)`
                  : `translateY(${virtualItem.start}px)`,
              }}
            >
              {virtualItem.index > 0 && (
                <div className="editor-scene-separator" />
              )}
              <LinearSceneBlock
                sceneId={scene.id}
                scene={scene}
                // Only virtual rows exist in the DOM. Dirty/conflicted ids are
                // pinned by rangeExtractor, so their local TipTap owner remains
                // mounted even when it is far outside the viewport.
                isMounted
                isActive={scene.id === activeId}
                placeholderHeight={
                  heightMapRef.current.get(scene.id) ?? DEFAULT_HEIGHT
                }
                onHeightChange={handleHeightChange}
                onFocus={handleFocus}
              />
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Toolbar
        editor={activeEditor}
        onFindReplace={() => {
          setFindOpen(true);
          setFindShowReplace(true);
        }}
        actionsRef={undefined}
        panelOpen={sceneMetaPanelOpen}
        onTogglePanel={handleTogglePanel}
        sceneId={activeId ?? undefined}
        nodeType="scene"
      />
      {scenes.length > 0 && <AccessibleLinearReaderDialog scenes={scenes} />}
      <FindReplaceBar
        editor={activeEditor}
        open={findOpen}
        showReplace={findShowReplace}
        onClose={() => setFindOpen(false)}
      />
      {/* Group は常時マウントし、パネル側だけ条件描画する。三項分岐で親を
          差し替えると scroll container ごと remount され、全シーンの
          unmount flush + 再ロードとスクロール位置喪失が起きる。 */}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        onLayoutChanged={handlePanelLayoutChanged}
      >
        <ResizablePanel
          id="editor-main"
          minSize="40%"
          className="flex flex-col overflow-hidden"
        >
          {scrollContainer}
        </ResizablePanel>
        {isPanelVisible && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              id="scene-meta"
              minSize="15%"
              maxSize="50%"
              defaultSize={`${sceneMetaPanelWidth}%`}
              className="flex flex-col overflow-hidden"
            >
              <SceneMetaPanel
                sceneId={activeId!}
                // registry から「active シーンの editor」を直接引く。
                // focusedEditor だと別シーンの doc に Beat が誤挿入されうる。
                editor={activeRegisteredEditor}
                setMentionPopup={setMentionPopup}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <CodexPopover editor={focusedEditor} />
      {canEditCodexSemanticLink && (
        <CodexSemanticLinkPopover editor={focusedEditor} />
      )}
      <EditorContextMenu
        editor={focusedEditor}
        containerRef={scrollRef}
        canEditCodexSemanticLink={canEditCodexSemanticLink}
      />
      {/* / コマンドのサジェスト。グローバル store (useSlashCommandStore) を
          読む消費者なのでビュー全体で 1 個マウントすれば全ブロックに効く。
          これが無いと SlashCommandExtension は store.open するのに描画する
          コンポーネントが存在せず、リニアモードでだけサジェストが出ない。 */}
      <SlashCommandPopup />
      {mentionPopup &&
        createPortal(
          <MentionPopup
            items={mentionPopup.items}
            selectedIndex={mentionIndex}
            onSelect={handleMentionSelect}
            onChangeIndex={setMentionIndex}
            clientRect={mentionPopup.clientRect}
            onSelectWithRole={handleMentionSelectWithRole}
          />,
          document.body,
        )}
    </div>
  );
}
