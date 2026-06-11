import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useLinearEditorStore } from "./linearEditorStore";
import { LinearSceneBlock } from "./LinearSceneBlock";
import { Toolbar } from "@/features/editor/Toolbar";
import { FindReplaceBar } from "@/features/editor/FindReplaceBar";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { EditorContextMenu } from "@/features/editor/EditorContextMenu";
import { SceneMetaPanel } from "@/features/editor/SceneMetaPanel";
import { MentionPopup } from "@/features/chat/components/MentionPopup";
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
  getLinearRootMargin,
  getLogicalScrollOffset,
  pickActiveSceneId,
  setLogicalScrollOffset,
} from "@/features/editor/editorLayout";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useVerticalWheelScroll } from "@/features/editor/useVerticalWheelScroll";
import { isMac } from "@/lib/platform";
import {
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";
import type { Editor } from "@tiptap/core";

const DEFAULT_HEIGHT = 300;
const DEBOUNCE_ACTIVE_MS = 100;

export function LinearEditorView() {
  const editorSettings = useEditorSettings();
  const verticalMode = editorSettings.verticalMode;
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  const focusedEditor = useLinearEditorStore((s) => s.focusedEditor);
  const pendingScrollToId = useLinearEditorStore((s) => s.pendingScrollToId);
  const editorsById = useLinearEditorStore((s) => s.editorsById);

  const scrollRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const heightMapRef = useRef<Map<string, number>>(new Map());
  const isScrollDetectionRef = useRef(false);
  const activeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Capture the active scene at mount time before any observer overwrites it
  const initialActiveSceneIdRef = useRef(activeSceneId);
  // プログラムスクロール (タブ切替ナビ / 初期スクロール) の進行中ターゲット。
  // 進行中はスクロール由来の active 検出を止める — placeholder 高さ確定で
  // 着地点がズレる途中経過を「ユーザーが見ているシーン」と誤認すると、
  // setActiveScene → openPreview が無関係なプレビュータブを開いてしまう。
  const navigatingRef = useRef<string | null>(null);
  const navCleanupRef = useRef<(() => void) | null>(null);

  const [mountedSet, setMountedSet] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(activeSceneId);
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

  // sortOrder は同じ parentId 内でのみ比較可能な fractional-indexing key
  // (各フォルダの最初の子は独立に "a0" を生成する)。グローバル sort だと
  // 別フォルダのシーンが章をまたいで interleave するので、zipExport /
  // exportEngine と同じく per-parent sort + DFS pre-order で flatten する。
  // notes は意図的に除外 (LinearSceneBlock が scene 専用ロード経路のため)。
  // DFS walk で到達できない孤児 scene (parentId が消失/循環) は末尾に append
  // して旧フラット sort の「全 scene を必ず出す」保証を維持する。
  const scenes = useMemo(() => {
    const childrenByParent = new Map<string | null, TreeNodeData[]>();
    for (const n of nodes) {
      const arr = childrenByParent.get(n.parentId) ?? [];
      arr.push(n);
      childrenByParent.set(n.parentId, arr);
    }
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
    }
    const out: TreeNodeData[] = [];
    const guard = new Set<string>();
    const walk = (parentId: string | null) => {
      if (parentId !== null) {
        if (guard.has(parentId)) return;
        guard.add(parentId);
      }
      for (const n of childrenByParent.get(parentId) ?? []) {
        if (n.nodeType === "scene") out.push(n);
        else if (n.nodeType === "folder") walk(n.id);
      }
    };
    walk(null);
    const seen = new Set(out.map((n) => n.id));
    const orphans = nodes
      .filter((n) => n.nodeType === "scene" && !seen.has(n.id))
      .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
    return orphans.length === 0 ? out : [...out, ...orphans];
  }, [nodes]);

  // --- IntersectionObserver: mount/unmount ---
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setMountedSet((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.sceneId;
            if (!id) continue;
            if (entry.isIntersecting) {
              if (!next.has(id)) {
                next.add(id);
                changed = true;
              }
            } else {
              if (next.has(id)) {
                next.delete(id);
                changed = true;
              }
            }
          }
          return changed ? next : prev;
        });
      },
      { root: container, rootMargin: getLinearRootMargin(verticalMode) },
    );

    const sentinels = container.querySelectorAll("[data-scene-id]");
    sentinels.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [scenes, verticalMode]);

  // --- IntersectionObserver: active scene detection ---
  // activeId は ref で参照する (deps に入れると active が変わるたびに observer
  // を張り替え、その瞬間の交差イベントを取りこぼしてスクロール中の
  // タブ名/チャットの追従が不安定になる)。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (_entries) => {
        // プログラムスクロール進行中の途中経過は active にしない
        if (navigatingRef.current) return;
        if (activeDebounceRef.current) clearTimeout(activeDebounceRef.current);

        activeDebounceRef.current = setTimeout(() => {
          if (navigatingRef.current) return;
          // Find the visible scene closest to the block-start edge of the
          // scroll container (top when horizontal, right when vertical).
          const containerRect = container.getBoundingClientRect();
          const items = Array.from(
            container.querySelectorAll("[data-scene-id]"),
          ).map((el) => ({
            id: (el as HTMLElement).dataset.sceneId ?? "",
            rect: el.getBoundingClientRect(),
          }));
          const closestId = pickActiveSceneId(
            containerRect,
            items,
            verticalMode,
          );

          if (closestId && closestId !== activeIdRef.current) {
            setActiveId(closestId);
            isScrollDetectionRef.current = true;
            useTreeStore.getState().setActiveScene(closestId);
            // Clear the flag in a microtask so external watchers can distinguish
            queueMicrotask(() => {
              isScrollDetectionRef.current = false;
            });
          }
        }, DEBOUNCE_ACTIVE_MS);
      },
      { root: container, rootMargin: "0px", threshold: [0, 0.5, 1.0] },
    );

    const sentinels = container.querySelectorAll("[data-scene-id]");
    sentinels.forEach((el) => observer.observe(el));

    return () => {
      observer.disconnect();
      if (activeDebounceRef.current) clearTimeout(activeDebounceRef.current);
    };
  }, [scenes, verticalMode]);

  // Placeholder sizes were measured along one writing mode's block axis —
  // toggling vertical mode invalidates them.
  useEffect(() => {
    heightMapRef.current.clear();
  }, [verticalMode]);

  // --- Programmatic navigation: scroll a scene to the block-start edge ---
  // 一発の scrollIntoView では足りない: 未マウントシーンは placeholder の
  // 推定高さで並んでいるため、着地後に IO mount → 実高さ確定 → ターゲットが
  // ズレる。ResizeObserver + rAF でターゲットを block-start に再アンカーし
  // 続け、高さが安定したら終了する (初期スクロールの retry パターンを一般化)。
  // 進行中は navigatingRef で active 検出を抑止 — 途中経過のシーンを active に
  // すると openPreview が無関係なプレビュータブを開く。
  const navigateToScene = useCallback((targetId: string) => {
    const container = scrollRef.current;
    const content = editorContainerRef.current;
    if (!container || !content) return;

    // 進行中のナビゲーションは置き換える
    navCleanupRef.current?.();
    navigatingRef.current = targetId;

    let done = false;
    let stableTicks = 0;
    let rafId = 0;
    let observer: ResizeObserver | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      observer?.disconnect();
      cancelAnimationFrame(rafId);
      if (timeout) clearTimeout(timeout);
      if (navigatingRef.current === targetId) navigatingRef.current = null;
      if (navCleanupRef.current === cleanup) navCleanupRef.current = null;
    };
    const cleanup = finish;

    const step = () => {
      if (done) return;
      // call-time read — モード切替を跨いでも正しい軸で動く
      const vertical = useSettingsStore
        .getState()
        .getBoolean("editor.verticalMode", false);
      const target = container.querySelector(`[data-scene-id="${targetId}"]`);
      if (!target) {
        finish();
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const offset = getBlockStartOffset(
        containerRect,
        target.getBoundingClientRect(),
        vertical,
      );
      if (Math.abs(offset) < 2) {
        // 着地済み — 高さ変動が続く間は維持し、安定したら終了
        stableTicks += 1;
        return;
      }
      const before = getLogicalScrollOffset(container, vertical);
      setLogicalScrollOffset(container, before + offset, vertical);
      const after = getLogicalScrollOffset(container, vertical);
      if (after === before) {
        // スクロールが動かない: コンテンツ末尾でこれ以上寄せられない。
        // ただしまだスクロール可能になっていない起動直後は、コンテンツの
        // 成長を待つ (ResizeObserver が再試行する)。
        if (canScrollBlockAxis(container, vertical)) {
          stableTicks += 1;
        }
      } else {
        stableTicks = 0;
      }
    };

    // コンテンツの成長 (シーン mount で高さ確定) のたびに再アンカー
    observer = new ResizeObserver(() => step());
    observer.observe(content);

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

    // Safety: stop after 2s regardless
    timeout = setTimeout(finish, 2000);

    navCleanupRef.current = cleanup;
  }, []);

  // Unmount: stop any in-flight navigation
  useEffect(() => {
    return () => {
      navCleanupRef.current?.();
    };
  }, []);

  // --- Initial scroll: jump to active scene on mount ---
  // At mount time, all scenes are short placeholders so the container may not
  // be scrollable yet — navigateToScene's grow-retry handles it.
  useEffect(() => {
    const targetId = initialActiveSceneIdRef.current;
    if (!targetId) return;
    navigateToScene(targetId);
  }, [navigateToScene]);

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
  const activeEditor =
    (activeId ? editorsById[activeId] : null) ?? focusedEditor;

  // 縦書きではホイールの縦回転を読み進み方向 (横) のスクロールに変換する
  useVerticalWheelScroll(scrollRef, verticalMode);

  // --- Scene meta panel (EditorPane と同じ設定キー・レイアウト永続化) ---
  const sceneMetaPanelOpen = editorSettings.sceneMetaPanelOpen;
  const sceneMetaPanelWidth = editorSettings.sceneMetaPanelWidth;
  const isPanelVisible = sceneMetaPanelOpen && activeId != null;
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
      className={`glass-editor-body flex-1 overflow-auto bg-content-background text-content-foreground-secondary p-4${verticalMode ? " editor-vertical" : ""}`}
    >
      <div
        ref={editorContainerRef}
        style={buildEditorMeasureStyle(editorSettings.maxContentWidth)}
      >
        {scenes.map((scene, i) => (
          <div key={scene.id}>
            {i > 0 && <div className="editor-scene-separator" />}
            <LinearSceneBlock
              sceneId={scene.id}
              isMounted={mountedSet.has(scene.id)}
              isActive={scene.id === activeId}
              placeholderHeight={
                heightMapRef.current.get(scene.id) ?? DEFAULT_HEIGHT
              }
              onHeightChange={handleHeightChange}
              onFocus={handleFocus}
            />
          </div>
        ))}
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
        onVerticalPreview={() => {}}
        actionsRef={undefined}
        panelOpen={sceneMetaPanelOpen}
        onTogglePanel={handleTogglePanel}
        sceneId={activeId ?? undefined}
        nodeType="scene"
      />
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
                editor={activeId ? (editorsById[activeId] ?? null) : null}
                setMentionPopup={setMentionPopup}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <CodexPopover editor={focusedEditor} />
      <EditorContextMenu editor={focusedEditor} containerRef={scrollRef} />
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
