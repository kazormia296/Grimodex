import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useLayoutStore } from "@/features/layout/layoutStore";

const PROJECT_ID = "default-project";
const DEBOUNCE_MS = 200;

interface SearchResult {
  sourceType: "scene" | "codex" | "snippet";
  id: string;
  title: string;
  excerpt: string;
}

interface GlobalSearchDialogProps {
  onClose: () => void;
}

const SOURCE_LABELS: Record<SearchResult["sourceType"], string> = {
  scene: "Scene",
  codex: "Codex",
  snippet: "Snippet",
};

const SOURCE_COLORS: Record<SearchResult["sourceType"], string> = {
  scene: "#534AB7",
  codex: "#059669",
  snippet: "#D97706",
};

export function GlobalSearchDialog({ onClose }: GlobalSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const requestSelectEntry = useCodexStore((s) => s.requestSelectEntry);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced search
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timerRef.current = setTimeout(async () => {
      try {
        const res = await invoke<SearchResult[]>("fts_search", {
          projectId: PROJECT_ID,
          query: q,
          scope: "all",
          limit: 30,
        });
        setResults(res);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
  }, [query]);

  const openResult = useCallback(
    (result: SearchResult) => {
      const { showPanel } = useLayoutStore.getState();
      onClose();
      if (result.sourceType === "scene") {
        setActiveScene(result.id);
        showPanel("editor");
      } else if (result.sourceType === "codex") {
        requestSelectEntry(result.id);
        showPanel("codex");
      } else if (result.sourceType === "snippet") {
        showPanel("snippets");
      }
    },
    [onClose, setActiveScene, requestSelectEntry],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[selectedIndex]) {
        e.preventDefault();
        openResult(results[selectedIndex]);
      }
    },
    [results, selectedIndex, openResult],
  );

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 560,
          maxWidth: "90vw",
          background: "var(--popover)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 16, color: "var(--muted-foreground)" }}>
            🔍
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="シーン・Codex・スニペットを検索…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 14,
              color: "var(--foreground)",
            }}
          />
          {loading && (
            <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
              検索中…
            </span>
          )}
        </div>

        {/* Results */}
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {results.length === 0 && query.trim() && !loading && (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                fontSize: 13,
                color: "var(--muted-foreground)",
              }}
            >
              「{query}」の結果なし
            </div>
          )}
          {results.length === 0 && !query.trim() && (
            <div
              style={{
                padding: "16px 14px",
                fontSize: 12,
                color: "var(--muted-foreground)",
              }}
            >
              <div style={{ marginBottom: 6 }}>
                キーワードを入力してください
              </div>
              <div style={{ opacity: 0.7 }}>
                シーン・Codexエントリ・スニペットを横断検索します
              </div>
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.sourceType}:${r.id}`}
              type="button"
              onClick={() => openResult(r)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "8px 14px",
                background:
                  i === selectedIndex ? "var(--accent)" : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: SOURCE_COLORS[r.sourceType],
                  background: `${SOURCE_COLORS[r.sourceType]}18`,
                  border: `1px solid ${SOURCE_COLORS[r.sourceType]}40`,
                  borderRadius: 3,
                  padding: "1px 5px",
                  flexShrink: 0,
                  minWidth: 46,
                  textAlign: "center",
                }}
              >
                {SOURCE_LABELS[r.sourceType]}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--foreground)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.title || "(無題)"}
                </div>
                {r.excerpt && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--muted-foreground)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      marginTop: 1,
                    }}
                  >
                    {r.excerpt}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "6px 14px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 12,
            fontSize: 10,
            color: "var(--muted-foreground)",
          }}
        >
          <span>↑↓ 選択</span>
          <span>Enter 開く</span>
          <span>Esc 閉じる</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
