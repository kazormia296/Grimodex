import type { GroupIndex, TabEntry } from "./tabStore";

export const TAB_STATE_KEY = "editor.tabState";

export interface TabPersistenceSnapshot {
  tabs: TabEntry[];
  activeTabId: string | null;
  secondaryTabs: TabEntry[];
  secondaryActiveTabId: string | null;
  activeGroupIndex: GroupIndex;
  secondaryGroupOpen: boolean;
  splitDirection: "right" | "below";
  isLinearMode: boolean;
}

function normalizeTabs(
  tabs: TabEntry[] | undefined,
  validNodeIds?: Set<string>,
): TabEntry[] {
  const normalized = (tabs ?? []).map((tab) => ({
    ...tab,
    contentType: tab.contentType ?? "scene",
  }));
  if (!validNodeIds) return normalized;
  return normalized.filter((tab) =>
    tab.contentType !== "scene" &&
    tab.contentType !== "codex" &&
    tab.contentType !== "snippet" &&
    tab.contentType !== "chronicle_event"
      ? false
      : tab.contentType !== "scene" || validNodeIds.has(tab.nodeId),
  );
}

export function parseTabPersistence(
  json: string,
  validNodeIds?: Set<string>,
): TabPersistenceSnapshot {
  const parsed = JSON.parse(json) as Partial<TabPersistenceSnapshot>;
  const tabs = normalizeTabs(parsed.tabs, validNodeIds);
  const secondaryTabs = normalizeTabs(parsed.secondaryTabs, validNodeIds);
  const activeTabId = tabs.some((tab) => tab.nodeId === parsed.activeTabId)
    ? (parsed.activeTabId ?? null)
    : (tabs[0]?.nodeId ?? null);
  const secondaryActiveTabId = secondaryTabs.some(
    (tab) => tab.nodeId === parsed.secondaryActiveTabId,
  )
    ? (parsed.secondaryActiveTabId ?? null)
    : (secondaryTabs[0]?.nodeId ?? null);
  const secondaryGroupOpen =
    parsed.secondaryGroupOpen ?? secondaryTabs.length > 0;
  return {
    tabs,
    activeTabId,
    secondaryTabs,
    secondaryActiveTabId,
    secondaryGroupOpen,
    activeGroupIndex: secondaryGroupOpen ? (parsed.activeGroupIndex ?? 0) : 0,
    splitDirection: parsed.splitDirection ?? "right",
    isLinearMode: parsed.isLinearMode ?? false,
  };
}

export function serializeTabPersistence(
  snapshot: TabPersistenceSnapshot,
): string {
  return JSON.stringify(snapshot);
}
