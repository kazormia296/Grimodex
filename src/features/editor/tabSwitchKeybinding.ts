import { useTreeStore } from "@/features/tree/treeStore";
import {
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";
import { isMac } from "@/lib/platform";
import { useTabStore } from "./tabStore";

/**
 * Handles desktop editor-tab cycling. Phone workspaces deliberately project a
 * single active document and must never mutate the hidden desktop tab model.
 */
export function handleEditorTabSwitchKeydown(
  event: KeyboardEvent,
  phoneWorkspace: boolean,
): boolean {
  if (phoneWorkspace) return false;

  const merged = getMergedBindings();
  const mac = isMac();
  const isPrevious = matchesBinding(event, merged.prevTab ?? "", mac);
  const isNext = matchesBinding(event, merged.nextTab ?? "", mac);
  if (!isPrevious && !isNext) return false;
  event.preventDefault();

  const {
    activeGroupIndex,
    tabs,
    activeTabId,
    secondaryTabs,
    secondaryActiveTabId,
    setActiveTab,
    setSecondaryActiveTab,
  } = useTabStore.getState();
  const currentTabs = activeGroupIndex === 0 ? tabs : secondaryTabs;
  const currentActiveId =
    activeGroupIndex === 0 ? activeTabId : secondaryActiveTabId;

  if (currentTabs.length < 2) return true;
  const currentIndex = currentTabs.findIndex(
    (tab) => tab.nodeId === currentActiveId,
  );
  if (currentIndex === -1) return true;

  const nextIndex = isPrevious
    ? (currentIndex - 1 + currentTabs.length) % currentTabs.length
    : (currentIndex + 1) % currentTabs.length;
  const nextTab = currentTabs[nextIndex]!;

  if (activeGroupIndex === 0) {
    setActiveTab(nextTab.nodeId);
  } else {
    setSecondaryActiveTab(nextTab.nodeId);
  }
  if (nextTab.contentType === "scene") {
    useTreeStore.getState().setActiveScene(nextTab.nodeId);
  }
  return true;
}
