import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useLinearEditorStore } from "./linearEditorStore";
import { LinearSceneBlock } from "./LinearSceneBlock";
import { Toolbar } from "@/features/editor/Toolbar";
import { FindReplaceBar } from "@/features/editor/FindReplaceBar";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { EditorContextMenu } from "@/features/editor/EditorContextMenu";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
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
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  const focusedEditor = useLinearEditorStore((s) => s.focusedEditor);
  const pendingScrollToId = useLinearEditorStore((s) => s.pendingScrollToId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const heightMapRef = useRef<Map<string, number>>(new Map());
  const isScrollDetectionRef = useRef(false);
  const activeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Capture the active scene at mount time before any observer overwrites it
  const initialActiveSceneIdRef = useRef(activeSceneId);

  const [mountedSet, setMountedSet] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(activeSceneId);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);

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
      { root: container, rootMargin: "200% 0px" },
    );

    const sentinels = container.querySelectorAll("[data-scene-id]");
    sentinels.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [scenes]);

  // --- IntersectionObserver: active scene detection ---
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (_entries) => {
        if (activeDebounceRef.current) clearTimeout(activeDebounceRef.current);

        activeDebounceRef.current = setTimeout(() => {
          // Find the visible scene closest to the top of the scroll container
          const containerRect = container.getBoundingClientRect();
          let closestId: string | null = null;
          let closestDist = Infinity;

          const visibleEls = container.querySelectorAll("[data-scene-id]");
          for (const el of visibleEls) {
            const rect = el.getBoundingClientRect();
            // Only consider elements at least partially visible
            if (
              rect.bottom < containerRect.top ||
              rect.top > containerRect.bottom
            )
              continue;
            const dist = Math.abs(rect.top - containerRect.top);
            if (dist < closestDist) {
              closestDist = dist;
              closestId = (el as HTMLElement).dataset.sceneId ?? null;
            }
          }

          if (closestId && closestId !== activeId) {
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
  }, [scenes, activeId]);

  // --- Initial scroll: jump to active scene on mount ---
  // At mount time, all scenes are short placeholders so the container may not
  // be scrollable yet (scrollHeight === clientHeight). We use a ResizeObserver
  // on the inner content to re-attempt scrolling each time content grows
  // (editors mount and load their text). Stops after 2s to avoid indefinite observation.
  useEffect(() => {
    const targetId = initialActiveSceneIdRef.current;
    if (!targetId) return;
    const container = scrollRef.current;
    const content = editorContainerRef.current;
    if (!container || !content) return;

    let done = false;

    function scrollToTarget() {
      if (done) return;
      if (container!.scrollHeight <= container!.clientHeight) return;
      const target = container!.querySelector(`[data-scene-id="${targetId}"]`);
      if (!target) return;
      const containerRect = container!.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const offset = targetRect.top - containerRect.top;
      // Already at target
      if (Math.abs(offset) < 2) {
        done = true;
        return;
      }
      container!.scrollTop += offset;
      // Verify target actually reached the top of the container.
      // If the content isn't tall enough yet, scrollTop can't reach far enough
      // and we must NOT mark done — ResizeObserver will retry when content grows.
      const afterRect = target.getBoundingClientRect();
      const remaining = Math.abs(afterRect.top - containerRect.top);
      if (remaining < 5) done = true;
    }

    // Try immediately in case content is already tall enough
    scrollToTarget();
    if (done) return;

    // Otherwise wait for content to grow
    const observer = new ResizeObserver(() => {
      scrollToTarget();
      if (done) observer.disconnect();
    });
    observer.observe(content);

    // Safety: stop after 2s regardless
    const timeout = setTimeout(() => observer.disconnect(), 2000);

    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, []);

  // --- External navigation: scroll to scene ---
  useEffect(() => {
    if (!activeSceneId) return;
    // Skip if this change came from scroll detection
    if (isScrollDetectionRef.current) return;
    // Skip if already viewing this scene
    if (activeSceneId === activeId) return;

    setActiveId(activeSceneId);
    const container = scrollRef.current;
    if (!container) return;
    const target = container.querySelector(
      `[data-scene-id="${activeSceneId}"]`,
    );
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [activeSceneId, activeId]);

  // --- Consume pendingScrollToId ---
  useEffect(() => {
    if (!pendingScrollToId) return;
    useLinearEditorStore.getState().setPendingScrollToId(null);
    const container = scrollRef.current;
    if (!container) return;
    const target = container.querySelector(
      `[data-scene-id="${pendingScrollToId}"]`,
    );
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [pendingScrollToId]);

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

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Toolbar
        editor={focusedEditor}
        onFindReplace={() => {
          setFindOpen(true);
          setFindShowReplace(true);
        }}
        onVerticalPreview={() => {}}
        actionsRef={undefined}
      />
      <FindReplaceBar
        editor={focusedEditor}
        open={findOpen}
        showReplace={findShowReplace}
        onClose={() => setFindOpen(false)}
      />
      <div
        ref={scrollRef}
        className="glass-editor-body flex-1 overflow-auto bg-content-background text-content-foreground-secondary p-4"
      >
        <div
          ref={editorContainerRef}
          style={{
            maxWidth: `${editorSettings.maxContentWidth}px`,
            margin: "0 auto",
          }}
        >
          {scenes.map((scene, i) => (
            <div key={scene.id}>
              {i > 0 && <div className="my-6 border-t border-border/50" />}
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
      <CodexPopover editor={focusedEditor} />
      <EditorContextMenu editor={focusedEditor} containerRef={scrollRef} />
    </div>
  );
}
