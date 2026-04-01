import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Trash2, Copy } from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useSnippetStore } from "./snippetStore";
import { SnippetDetailContent } from "./SnippetDetailContent";
import {
  copyWithAttribution,
  handleCopyWithAttribution,
} from "@/lib/clipboardAttribution";
import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";
import type { Snippet } from "./api";

export function SnippetPanel() {
  const entries = useSnippetStore((s) => s.entries);
  const searchQuery = useSnippetStore((s) => s.searchQuery);
  const isLoading = useSnippetStore((s) => s.isLoading);
  const loadEntries = useSnippetStore((s) => s.loadEntries);
  const search = useSnippetStore((s) => s.search);
  const update = useSnippetStore((s) => s.update);
  const remove = useSnippetStore((s) => s.remove);

  const [selectedSnippet, setSelectedSnippet] = useState<Snippet | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const handleSearchChange = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        search(value);
      }, 300);
    },
    [search],
  );

  const handleDragStart = useCallback(
    (
      e: React.DragEvent,
      snippet: {
        id: string;
        content: string;
      },
    ) => {
      e.dataTransfer.setData("text/plain", snippet.content);
      e.dataTransfer.setData(
        "application/x-grimodex-snippet",
        JSON.stringify({
          id: snippet.id,
          content: snippet.content,
          source: "human",
          originalContent: null,
        }),
      );
    },
    [],
  );

  const handleSave = useCallback(
    async (
      id: string,
      data: { title: string; content: string; tags: string },
    ) => {
      await update(id, data);
    },
    [update],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await remove(id);
      setSelectedSnippet(null);
    },
    [remove],
  );

  return (
    <div className="flex h-full flex-col" data-testid="snippet-panel">
      <ResizablePanelGroup orientation="horizontal">
        {/* Left Panel: List */}
        <ResizablePanel defaultSize={40} minSize={25}>
          <div
            data-testid="snippet-list-panel"
            className="flex h-full flex-col"
          >
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  data-testid="snippet-search-input"
                  type="text"
                  defaultValue={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Snippetを検索…"
                  className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {isLoading && (
                <div
                  data-testid="snippet-loading"
                  className="flex items-center justify-center py-8"
                >
                  <span className="text-xs text-muted-foreground animate-pulse">
                    読み込み中…
                  </span>
                </div>
              )}

              {!isLoading && entries.length === 0 && (
                <div
                  data-testid="snippet-empty-state"
                  className="flex h-full items-center justify-center"
                >
                  <p className="text-xs text-muted-foreground">
                    Snippetはまだありません
                  </p>
                </div>
              )}

              {!isLoading && entries.length > 0 && (
                <div className="space-y-1 p-2">
                  {entries.map((snippet) => (
                    <div
                      key={snippet.id}
                      data-testid={`snippet-item-${snippet.id}`}
                      draggable="true"
                      onClick={() => setSelectedSnippet(snippet)}
                      onDragStart={(e) =>
                        handleDragStart(e, {
                          id: snippet.id,
                          content: snippet.content,
                        })
                      }
                      onCopy={(e) =>
                        handleCopyWithAttribution(
                          e,
                          "human" as AuthorshipSource,
                        )
                      }
                      className={`group cursor-grab rounded-md border border-border p-2 hover:bg-accent/50 active:cursor-grabbing ${
                        selectedSnippet?.id === snippet.id ? "bg-accent" : ""
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <h4 className="text-xs font-medium text-foreground truncate">
                          {snippet.title}
                        </h4>
                        <div className="flex shrink-0 gap-0.5">
                          <button
                            type="button"
                            data-testid={`snippet-copy-${snippet.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              copyWithAttribution(
                                snippet.content,
                                "human" as AuthorshipSource,
                              );
                            }}
                            className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-accent-foreground group-hover:opacity-100"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            data-testid={`snippet-delete-${snippet.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              remove(snippet.id);
                            }}
                            className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {snippet.content}
                      </p>
                      {snippet.tags && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {snippet.tags
                            .split(",")
                            .filter(Boolean)
                            .map((tag) => (
                              <span
                                key={tag}
                                className="inline-block rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground"
                              >
                                {tag.trim()}
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel: Detail */}
        <ResizablePanel defaultSize={60} minSize={30}>
          <div data-testid="snippet-detail-panel" className="h-full">
            {selectedSnippet ? (
              <SnippetDetailContent
                snippet={selectedSnippet}
                onSave={handleSave}
                onDelete={handleDelete}
              />
            ) : (
              <div
                data-testid="snippet-detail-placeholder"
                className="flex h-full items-center justify-center"
              >
                <p className="text-xs text-muted-foreground">
                  Snippetを選択してください
                </p>
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
