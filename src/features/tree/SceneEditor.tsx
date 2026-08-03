import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSceneStore } from "./store";
import { useTreeStore } from "./treeStore";
import { TabBar } from "@/features/editor/TabBar";
import { Breadcrumb } from "@/features/editor/Breadcrumb";
import { SceneMetaChipRow } from "@/features/editor/SceneMetaChipRow";
import { EditorPane } from "@/features/editor/EditorPane";
import { useTabStore } from "@/features/editor/tabStore";
import { useRevisionStore } from "@/features/revision/revisionStore";
import { AsciiSplash } from "@/features/editor/AsciiSplash";
import { cn } from "@/lib/utils";
import { DRAG_DATA_KEY, DRAG_GROUP_KEY } from "@/features/editor/TabBar";
import type { GroupIndex } from "@/features/editor/tabStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { resolvePhoneEditorGroup } from "@/features/editor/phoneEditorGroup";
import { createEditorInputScopeKey } from "@/features/editor/editorInputReady";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";
import { PhoneEmptySceneBootstrap } from "./PhoneEmptySceneBootstrap";

const LinearEditorView = lazy(async () => {
  const module = await import("@/features/editor/LinearEditorView");
  return { default: module.LinearEditorView };
});

const RevisionHistoryModal = lazy(async () => {
  const module = await import("@/features/revision/RevisionHistoryModal");
  return { default: module.RevisionHistoryModal };
});

interface DragPayload {
  nodeId: string;
  groupIndex: GroupIndex;
}

function EmptyGroupPlaceholder({ groupIndex }: { groupIndex: GroupIndex }) {
  return (
    <AsciiSplash
      onClick={() => useTabStore.getState().setActiveGroup(groupIndex)}
    />
  );
}

/**
 * Full-area drop zone: overlaid on a group's content area.
 * Accepts drops from the OTHER group only (same-group drags are handled by the TabBar).
 */
function FullAreaDropZone({ targetGroup }: { targetGroup: GroupIndex }) {
  const [isOver, setIsOver] = useState(false);
  const otherGroup: GroupIndex = targetGroup === 0 ? 1 : 0;

  return (
    <div
      className={cn(
        "absolute inset-0 z-20 transition-colors",
        isOver
          ? "bg-primary/10 ring-2 ring-inset ring-primary/40"
          : "bg-transparent",
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_DATA_KEY)) return;
        // Only accept from the OTHER group
        if (!e.dataTransfer.types.includes(DRAG_GROUP_KEY(otherGroup))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setIsOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        const raw = e.dataTransfer.getData(DRAG_DATA_KEY);
        if (!raw) return;
        const { nodeId, groupIndex: srcGroup } = JSON.parse(raw) as DragPayload;
        if (srcGroup === targetGroup) return;
        useTabStore
          .getState()
          .moveTabBetweenGroups(nodeId, srcGroup, targetGroup);
        const newActive =
          targetGroup === 0
            ? useTabStore.getState().activeTabId
            : useTabStore.getState().secondaryActiveTabId;
        if (newActive) useTreeStore.getState().setActiveScene(newActive);
      }}
    />
  );
}

/**
 * Edge drop zones shown on the single (non-split) primary group.
 * Dropping on the right edge creates a right-split; bottom edge creates a below-split.
 */
function EdgeDropZones() {
  const [hoveredEdge, setHoveredEdge] = useState<"right" | "below" | null>(
    null,
  );

  function makeHandlers(direction: "right" | "below") {
    return {
      onDragOver(e: React.DragEvent) {
        if (!e.dataTransfer.types.includes(DRAG_DATA_KEY)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setHoveredEdge(direction);
      },
      onDragLeave(e: React.DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setHoveredEdge(null);
        }
      },
      onDrop(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        setHoveredEdge(null);
        const raw = e.dataTransfer.getData(DRAG_DATA_KEY);
        if (!raw) return;
        const { nodeId, groupIndex: srcGroup } = JSON.parse(raw) as DragPayload;
        useTabStore
          .getState()
          .moveTabBetweenGroups(nodeId, srcGroup, 1, undefined, direction);
        useTreeStore.getState().setActiveScene(nodeId);
      },
    };
  }

  return (
    <>
      {/* Right edge — 25% width, full height, lower z-index */}
      <div
        className={cn(
          "absolute bottom-0 right-0 top-0 z-20 w-1/4 transition-colors",
          hoveredEdge === "right"
            ? "bg-primary/20 ring-2 ring-inset ring-primary/50"
            : "bg-transparent",
        )}
        {...makeHandlers("right")}
      />
      {/* Bottom edge — 25% height, full width, higher z-index (covers corner) */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 z-30 h-1/4 transition-colors",
          hoveredEdge === "below"
            ? "bg-primary/20 ring-2 ring-inset ring-primary/50"
            : "bg-transparent",
        )}
        {...makeHandlers("below")}
      />
    </>
  );
}

/**
 * SceneEditor renders one or two EditorPane instances.
 * Empty editor groups are allowed — they show a placeholder instead of an editor.
 */
export function SceneEditor() {
  const zenMode = useCursorSettingsStore((state) => state.zenMode);
  const viewportProfile = useWorkspaceViewportProfile();
  const projectId = useProjectStore((state) => state.currentProjectId);
  const workspacePath = useWorkspaceStore((state) => state.activeWorkspacePath);
  const workspaceOpenRevision = useWorkspaceStore(
    (state) => state.workspaceOpenRevision,
  );
  const inputScopeKey = createEditorInputScopeKey({
    projectId,
    workspacePath,
    workspaceOpenRevision,
  });
  const rawPhoneProjection = viewportProfile === "phone";
  const inlineAiStatus = useInlineAiStore((state) => state.status);
  const inlineAiOwnerGroup = useInlineAiStore(
    (state) => state.activeEditorGroup,
  );
  const inlineAiPending =
    inlineAiStatus === "generating" ||
    inlineAiStatus === "diffShown" ||
    inlineAiStatus === "error";
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const previousPhoneProjectionRef = useRef(rawPhoneProjection);
  const attemptingToLeavePhone =
    !rawPhoneProjection && previousPhoneProjectionRef.current;
  // An unaccepted inline-AI diff belongs to the projected phone editor. Keep
  // that editor mounted and visible across a resize until Accept/Reject makes
  // the document safe to swap back to its desktop tab projection.
  const phoneProjection =
    rawPhoneProjection || (attemptingToLeavePhone && inlineAiPending);
  const singleGroupProjection = zenMode || phoneProjection;
  const desktopSceneContextRef = useRef(activeSceneId);
  const activePhoneDocument = useTreeStore((state) =>
    state.nodes.find(
      (node) =>
        node.id === state.activeSceneId &&
        (node.nodeType === "scene" || node.nodeType === "note"),
    ),
  );
  const isLinearMode = useTabStore((s) => s.isLinearMode);
  const tabStateHydrated = useTabStore((s) => s.tabStateHydrated);
  const revisionHistoryOpen = useRevisionStore((s) => s.isOpen);

  const primaryActiveTabId = useTabStore((s) => s.activeTabId);
  const secondaryActiveTabId = useTabStore((s) => s.secondaryActiveTabId);
  const secondaryGroupOpen = useTabStore((s) => s.secondaryGroupOpen);
  const activeGroupIndex = useTabStore((s) => s.activeGroupIndex);
  const splitDirection = useTabStore((s) => s.splitDirection);
  const primaryTab = useTabStore((s) =>
    s.tabs.find((t) => t.nodeId === s.activeTabId),
  );
  const secondaryTab = useTabStore((s) =>
    s.secondaryTabs.find((t) => t.nodeId === s.secondaryActiveTabId),
  );
  const focusedTab =
    activeGroupIndex === 1 && secondaryGroupOpen ? secondaryTab : primaryTab;
  const restoredNonSceneTabHasFocus =
    focusedTab !== undefined && focusedTab.contentType !== "scene";
  const hasDesktopDocumentProjection =
    primaryActiveTabId != null ||
    (secondaryGroupOpen && secondaryActiveTabId != null);
  const restoringDesktopProjection =
    !phoneProjection &&
    previousPhoneProjectionRef.current &&
    hasDesktopDocumentProjection;

  const isDraggingTab = useTabStore((s) => s.isDraggingTab);

  useEffect(() => {
    function onDragEnd() {
      useTabStore.getState().setIsDraggingTab(false);
    }
    document.addEventListener("dragend", onDragEnd);
    return () => {
      document.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  // Mobile document selection is intentionally independent from desktop tabs.
  // Restore the last desktop scene context before tab-ensuring effects run when
  // leaving phone, otherwise the mobile-only document would become a new tab.
  useEffect(() => {
    if (!restoringDesktopProjection) return;
    const desktopSceneId = desktopSceneContextRef.current;
    const node = useTreeStore
      .getState()
      .nodes.find((candidate) => candidate.id === desktopSceneId);
    if (node?.nodeType === "scene" || node?.nodeType === "note") {
      useTreeStore.getState().setActiveScene(desktopSceneId);
    }
  }, [restoringDesktopProjection]);

  // Ensure the active scene always has a tab (handles external changes like node creation).
  useEffect(() => {
    if (
      !tabStateHydrated ||
      phoneProjection ||
      restoringDesktopProjection ||
      restoredNonSceneTabHasFocus ||
      !activeSceneId
    )
      return;
    const node = useTreeStore
      .getState()
      .nodes.find((n) => n.id === activeSceneId);
    if (!node || (node.nodeType !== "scene" && node.nodeType !== "note"))
      return;
    const { tabs, secondaryTabs } = useTabStore.getState();
    const inAnyGroup =
      tabs.some((t) => t.nodeId === activeSceneId) ||
      secondaryTabs.some((t) => t.nodeId === activeSceneId);
    if (!inAnyGroup) {
      openEditorDocument(
        {
          target: { kind: "scene", documentId: activeSceneId },
          mode: "preview",
          revealEditor: false,
          focusEditor: false,
          syncSceneContext: false,
        },
        defaultEditorNavigationPorts,
      );
    }
  }, [
    activeSceneId,
    phoneProjection,
    restoredNonSceneTabHasFocus,
    restoringDesktopProjection,
    tabStateHydrated,
  ]);

  // Sync activeGroupIndex → treeStore.activeSceneId (skip for codex/snippet tabs)
  useEffect(() => {
    if (phoneProjection) return;
    if (activeGroupIndex === 0 && primaryActiveTabId) {
      if (primaryTab?.contentType === "scene") {
        useTreeStore.getState().setActiveScene(primaryActiveTabId);
      }
    } else if (activeGroupIndex === 1 && secondaryActiveTabId) {
      if (secondaryTab?.contentType === "scene") {
        useTreeStore.getState().setActiveScene(secondaryActiveTabId);
      }
    }
  }, [
    activeGroupIndex,
    primaryActiveTabId,
    secondaryActiveTabId,
    primaryTab,
    secondaryTab,
    phoneProjection,
  ]);

  useEffect(() => {
    if (!phoneProjection) {
      desktopSceneContextRef.current = useTreeStore.getState().activeSceneId;
    }
    previousPhoneProjectionRef.current = phoneProjection;
  }, [activeSceneId, phoneProjection]);

  // --- Linear mode: all scenes in a single scroll view ---
  if (isLinearMode && !phoneProjection) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        {!zenMode && !phoneProjection && <Breadcrumb />}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!zenMode && <TabBar groupIndex={0} />}
          {/* メタチップ行はタブバー直下 (タブ=どのシーンか、チップ=その中身) */}
          {!zenMode && !phoneProjection && <SceneMetaChipRow />}
          <div className="relative flex flex-1 flex-col overflow-hidden">
            <Suspense fallback={null}>
              <LinearEditorView />
            </Suspense>
          </div>
        </div>
        {revisionHistoryOpen && (
          <Suspense fallback={null}>
            <RevisionHistoryModal />
          </Suspense>
        )}
      </div>
    );
  }

  const projectedActiveGroup = phoneProjection
    ? resolvePhoneEditorGroup(
        {
          activeTabId: primaryActiveTabId,
          secondaryActiveTabId,
          secondaryGroupOpen,
          activeGroupIndex,
        },
        activePhoneDocument?.id,
        inlineAiPending ? inlineAiOwnerGroup : null,
      )
    : secondaryGroupOpen
      ? activeGroupIndex
      : 0;
  const primaryOwnsPhoneProjection =
    phoneProjection && projectedActiveGroup === 0;
  const secondaryOwnsPhoneProjection =
    phoneProjection && projectedActiveGroup === 1;
  const primarySceneId = primaryOwnsPhoneProjection
    ? activePhoneDocument?.id
    : primaryActiveTabId;
  const secondarySceneId = secondaryOwnsPhoneProjection
    ? activePhoneDocument?.id
    : secondaryActiveTabId;
  const splitClass = singleGroupProjection
    ? "flex flex-1 overflow-hidden"
    : secondaryGroupOpen && splitDirection === "below"
      ? "flex flex-1 flex-col overflow-hidden"
      : "flex flex-1 overflow-hidden";

  const primaryClass = singleGroupProjection
    ? cn("flex min-w-0 flex-1 flex-col", projectedActiveGroup !== 0 && "hidden")
    : secondaryGroupOpen
      ? splitDirection === "below"
        ? "flex h-1/2 flex-col border-b border-border"
        : "flex w-1/2 flex-col border-r border-border"
      : "flex min-w-0 flex-1 flex-col";

  const secondaryClass = singleGroupProjection
    ? cn("flex min-w-0 flex-1 flex-col", projectedActiveGroup !== 1 && "hidden")
    : splitDirection === "below"
      ? "flex h-1/2 flex-col"
      : "flex w-1/2 flex-col";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {!zenMode && !phoneProjection && <Breadcrumb />}

      <div className={splitClass}>
        {/* ---- Primary group ---- */}
        <div
          data-editor-group="0"
          className={primaryClass}
          aria-hidden={
            singleGroupProjection && projectedActiveGroup !== 0
              ? true
              : undefined
          }
          inert={
            singleGroupProjection && projectedActiveGroup !== 0
              ? true
              : undefined
          }
        >
          {!zenMode && !phoneProjection && <TabBar groupIndex={0} />}
          {/* メタチップ行はタブバー直下。split view では各グループに置き、
              アクティブシーンを表示しているグループにだけ出る */}
          {!zenMode && !phoneProjection && <SceneMetaChipRow groupIndex={0} />}
          <div className="relative flex flex-1 flex-col overflow-hidden">
            {primarySceneId ? (
              <EditorPane
                nodeId={primarySceneId}
                contentType={
                  primaryOwnsPhoneProjection
                    ? "scene"
                    : (primaryTab?.contentType ?? "scene")
                }
                groupIndex={0}
                inputProjectionAuthority="workspace"
                inputProjectionScopeKey={inputScopeKey}
                isForegroundInputProjection={projectedActiveGroup === 0}
                onFocus={() => {
                  if (!phoneProjection) {
                    useTabStore.getState().setActiveGroup(0);
                  }
                  if (
                    primaryOwnsPhoneProjection ||
                    primaryTab?.contentType === "scene"
                  ) {
                    useTreeStore.getState().setActiveScene(primarySceneId);
                  }
                }}
              />
            ) : primaryOwnsPhoneProjection ? (
              <PhoneEmptySceneBootstrap />
            ) : (
              <EmptyGroupPlaceholder groupIndex={0} />
            )}

            {!zenMode &&
              !phoneProjection &&
              isDraggingTab &&
              (secondaryGroupOpen ? (
                // Split view: accept drops from the secondary group across the full area
                <FullAreaDropZone targetGroup={0} />
              ) : (
                // Single group: right/bottom edge zones create a new split
                <EdgeDropZones />
              ))}
          </div>
        </div>

        {/* ---- Secondary group ---- */}
        {secondaryGroupOpen && (
          <div
            data-editor-group="1"
            className={secondaryClass}
            aria-hidden={
              singleGroupProjection && projectedActiveGroup !== 1
                ? true
                : undefined
            }
            inert={
              singleGroupProjection && projectedActiveGroup !== 1
                ? true
                : undefined
            }
          >
            {!zenMode && !phoneProjection && <TabBar groupIndex={1} />}
            {!zenMode && !phoneProjection && (
              <SceneMetaChipRow groupIndex={1} />
            )}
            <div className="relative flex flex-1 flex-col overflow-hidden">
              {secondarySceneId ? (
                <EditorPane
                  nodeId={secondarySceneId}
                  contentType={
                    secondaryOwnsPhoneProjection
                      ? "scene"
                      : (secondaryTab?.contentType ?? "scene")
                  }
                  groupIndex={1}
                  inputProjectionAuthority="workspace"
                  inputProjectionScopeKey={inputScopeKey}
                  isForegroundInputProjection={projectedActiveGroup === 1}
                  onFocus={() => {
                    if (!phoneProjection) {
                      useTabStore.getState().setActiveGroup(1);
                    }
                    if (
                      secondaryOwnsPhoneProjection ||
                      secondaryTab?.contentType === "scene"
                    ) {
                      useTreeStore.getState().setActiveScene(secondarySceneId);
                    }
                  }}
                />
              ) : secondaryOwnsPhoneProjection ? (
                <PhoneEmptySceneBootstrap />
              ) : (
                <EmptyGroupPlaceholder groupIndex={1} />
              )}

              {/* Secondary always accepts drops from primary across the full area */}
              {!zenMode && !phoneProjection && isDraggingTab && (
                <FullAreaDropZone targetGroup={1} />
              )}
            </div>
          </div>
        )}
      </div>

      {revisionHistoryOpen && (
        <Suspense fallback={null}>
          <RevisionHistoryModal />
        </Suspense>
      )}
    </div>
  );
}
