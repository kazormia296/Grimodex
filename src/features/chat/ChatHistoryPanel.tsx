import React, { useEffect, useRef, useCallback, useMemo } from "react";
import { Search, X, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useChatStore } from "./chatStore";
import {
  useChatHistoryStore,
  filterAndSortSessions,
  groupSessionsByScope,
} from "./chatHistoryStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { SessionCard } from "./components/SessionCard";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTabStore } from "@/features/editor/tabStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import type { SortMode } from "./chatHistoryStore";
import { ChatHistorySkeletonList } from "@/components/ui/skeleton-patterns";

/** Render FTS5 snippet: \x01 = highlight start, \x02 = highlight end */
function renderHighlight(text: string): React.ReactNode {
  // eslint-disable-next-line no-control-regex
  const parts = text.split(/(\x01[^\x02]*\x02)/);
  return parts.map((part, i) => {
    if (part.startsWith("\x01")) {
      return (
        <mark
          key={i}
          className="bg-yellow-200/70 text-foreground dark:bg-yellow-700/50"
        >
          {part.slice(1, -1)}
        </mark>
      );
    }
    return part;
  });
}

const SORT_LABELS: Record<SortMode, string> = {
  recent: "Recent",
  oldest: "Oldest",
  most_messages: "Most messages",
  most_extractions: "Most extractions",
};

export function ChatHistoryPanel() {
  const { t } = useTranslation();
  const {
    sessions,
    isLoading,
    searchQuery,
    searchResults,
    isSearchMode,
    isSearching,
    sceneFilter,
    hasExtractionsOnly,
    projectScopeOnly,
    sortMode,
    loadSessions,
    setSearchQuery,
    runSearch,
    setSceneFilter,
    toggleHasExtractionsOnly,
    toggleProjectScopeOnly,
    setSortMode,
  } = useChatHistoryStore();

  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectSession = useChatStore((s) => s.selectSession);

  const nodes = useTreeStore((s) => s.nodes);
  const codexEntries = useCodexStore((s) => s.entries);

  const searchRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build nodeMap for grouping labels
  const nodeMap = useMemo(() => {
    const map: Record<string, { title: string; parentId: string | null }> = {};
    for (const n of nodes) {
      map[n.id] = { title: n.title, parentId: n.parentId };
    }
    return map;
  }, [nodes]);

  // Scene filter dropdown: Folder > Scene hierarchy
  const sceneGroups = useMemo(() => {
    const folderMap = new Map(
      nodes.filter((n) => n.nodeType === "folder").map((n) => [n.id, n.title]),
    );
    const sceneNodes = nodes.filter((n) => n.nodeType === "scene");

    const byFolder = new Map<
      string | null,
      { groupLabel: string; scenes: typeof sceneNodes }
    >();
    for (const scene of sceneNodes) {
      const folderId = scene.parentId;
      if (!byFolder.has(folderId)) {
        const groupLabel =
          folderId === null
            ? "Uncategorized"
            : (folderMap.get(folderId) ?? folderId);
        byFolder.set(folderId, { groupLabel, scenes: [] });
      }
      byFolder.get(folderId)!.scenes.push(scene);
    }
    return [...byFolder.values()];
  }, [nodes]);

  useEffect(() => {
    loadSessions(getCurrentProjectId());
  }, [loadSessions]);

  const handleSearchChange = useCallback(
    (q: string) => {
      setSearchQuery(q);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (q.trim()) {
        searchTimerRef.current = setTimeout(() => {
          runSearch(getCurrentProjectId());
        }, 300);
      }
    },
    [setSearchQuery, runSearch],
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      selectSession(sessionId).catch(() => {});
    },
    [selectSession],
  );

  // Derived: filtered + sorted sessions
  const filteredSessions = useMemo(
    () =>
      filterAndSortSessions(sessions, {
        sceneFilter,
        hasExtractionsOnly,
        projectScopeOnly,
        sortMode,
      }),
    [sessions, sceneFilter, hasExtractionsOnly, projectScopeOnly, sortMode],
  );

  const codexEntryMap = useMemo(() => {
    const map: Record<string, { name: string }> = {};
    for (const e of codexEntries) {
      map[e.id] = { name: e.name };
    }
    return map;
  }, [codexEntries]);

  const sessionGroups = useMemo(
    () => groupSessionsByScope(filteredSessions, nodeMap, codexEntryMap),
    [filteredSessions, nodeMap, codexEntryMap],
  );

  // Search results grouped by session
  const searchGrouped = useMemo(() => {
    if (!isSearchMode) return [];
    const bySession = new Map<
      string,
      {
        sessionTitle: string;
        nodeId: string | null;
        codexAnchorId: string | null;
        hits: typeof searchResults;
      }
    >();
    for (const hit of searchResults) {
      if (!bySession.has(hit.sessionId)) {
        bySession.set(hit.sessionId, {
          sessionTitle: hit.sessionTitle,
          nodeId: hit.nodeId,
          codexAnchorId: hit.codexAnchorId,
          hits: [],
        });
      }
      bySession.get(hit.sessionId)!.hits.push(hit);
    }
    return [...bySession.entries()];
  }, [searchResults, isSearchMode]);

  const totalHits = searchResults.length;
  const totalCount = filteredSessions.length;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div
        data-panel-header
        className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-2"
      >
        <span className="text-xs font-semibold text-foreground">
          Chat history
        </span>
        <span className="text-[10px] text-muted-foreground">
          {isSearchMode ? `${totalHits} hits` : `${totalCount} sessions`}
        </span>
      </div>

      {/* Search bar */}
      <div className="flex-shrink-0 border-b border-border px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                handleSearchChange("");
                searchRef.current?.blur();
              }
            }}
            placeholder="Search messages..."
            className="w-full rounded border border-border bg-background py-0.5 pl-6 pr-6 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => handleSearchChange("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        {/* Scene filter dropdown */}
        <select
          value={sceneFilter ?? ""}
          onChange={(e) => setSceneFilter(e.target.value || null)}
          className="h-5 max-w-[110px] rounded border border-border bg-background px-1 text-[10px] text-foreground focus:outline-none"
        >
          <option value="">All scenes</option>
          {sceneGroups.map((group) => (
            <optgroup key={group.groupLabel} label={group.groupLabel}>
              {group.scenes.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {scene.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Has extractions toggle */}
        <button
          type="button"
          onClick={toggleHasExtractionsOnly}
          className={cn(
            "flex h-5 items-center gap-0.5 rounded-full border px-1.5 text-[10px] transition-colors",
            hasExtractionsOnly
              ? "border-teal-500 bg-teal-500/15 text-teal-600 dark:text-teal-400"
              : "border-border text-muted-foreground hover:bg-accent",
          )}
        >
          {hasExtractionsOnly && <Check className="h-2.5 w-2.5" />}
          Has extractions
        </button>

        {/* Project scope toggle */}
        <button
          type="button"
          onClick={toggleProjectScopeOnly}
          className={cn(
            "flex h-5 items-center gap-0.5 rounded-full border px-1.5 text-[10px] transition-colors",
            projectScopeOnly
              ? "border-blue-500 bg-blue-500/15 text-blue-600 dark:text-blue-400"
              : "border-border text-muted-foreground hover:bg-accent",
          )}
        >
          {projectScopeOnly && <Check className="h-2.5 w-2.5" />}
          Project scope
        </button>

        {/* Sort dropdown */}
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="ml-auto h-5 rounded border border-border bg-background px-1 text-[10px] text-foreground focus:outline-none"
        >
          {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
            <option key={m} value={m}>
              {SORT_LABELS[m]}
            </option>
          ))}
        </select>
      </div>

      {/* Main list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {isLoading && sessions.length === 0 && (
          <ChatHistorySkeletonList testId="chat-history-loading" />
        )}

        {/* Search mode */}
        {isSearchMode && (
          <>
            {isSearching && (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("chat.searching")}
              </p>
            )}
            {!isSearching && searchGrouped.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("chat.noSearchResults", { query: searchQuery })}
              </p>
            )}
            {searchGrouped.map(([sessionId, group]) => (
              <div key={sessionId} className="mb-3">
                <button
                  type="button"
                  onClick={() => handleSessionClick(sessionId)}
                  className="mb-1 w-full text-left text-[10px] font-semibold text-muted-foreground hover:text-foreground"
                >
                  {group.codexAnchorId
                    ? codexEntryMap[group.codexAnchorId]?.name
                      ? `Codex: ${codexEntryMap[group.codexAnchorId]!.name}`
                      : `Codex: ${group.codexAnchorId}`
                    : group.nodeId
                      ? (nodeMap[group.nodeId]?.title ?? group.nodeId)
                      : "Project scope"}{" "}
                  › {group.sessionTitle}
                  <span className="ml-1 font-normal opacity-60">
                    ({group.hits.length})
                  </span>
                </button>
                <div className="space-y-1">
                  {group.hits.map((hit) => (
                    <button
                      key={hit.msgId}
                      type="button"
                      onClick={() => handleSessionClick(sessionId)}
                      className="w-full rounded border border-border/50 bg-background px-2 py-1.5 text-left hover:bg-accent/50"
                    >
                      <p className="text-[10px] text-muted-foreground">
                        {hit.role === "user" ? "You" : "AI"} ·{" "}
                        {new Date(hit.createdAt).toLocaleTimeString("ja-JP", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-foreground">
                        {renderHighlight(hit.highlightedContent)}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}

        {/* Normal grouped list */}
        {!isSearchMode && (
          <>
            {filteredSessions.length === 0 && !isLoading && (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("chat.noSessions")}
              </p>
            )}
            {sessionGroups.map((group) => (
              <div
                key={
                  group.codexAnchorId
                    ? `codex-${group.codexAnchorId}`
                    : (group.nodeId ?? "project-scope")
                }
                className="mb-3"
              >
                {/* Group header */}
                {group.nodeId ? (
                  <button
                    type="button"
                    onClick={() => {
                      useTreeStore.getState().setActiveScene(group.nodeId!);
                      useTabStore.getState().openPinned(group.nodeId!);
                    }}
                    className="mb-1 w-full text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  >
                    {group.groupLabel}
                  </button>
                ) : (
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.groupLabel}
                  </p>
                )}
                <div className="space-y-1">
                  {group.sessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      onClick={() => handleSessionClick(session.id)}
                      onDoubleClick={() => {
                        handleSessionClick(session.id);
                        // Focus chat panel via store (no direct DOM access needed)
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
