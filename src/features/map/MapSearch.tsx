import { useCallback, useEffect, useRef, useState } from "react";
import type { Node } from "@xyflow/react";

interface SearchResult {
  nodeId: string;
  label: string;
}

interface MapSearchProps {
  nodes: Node[];
  onFocus: (nodeId: string) => void;
  onClose: () => void;
}

export function MapSearch({ nodes, onFocus, onClose }: MapSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(
    (q: string) => {
      const trimmed = q.trim().toLowerCase();
      if (!trimmed) {
        setResults([]);
        setCursor(0);
        return;
      }

      const hits: SearchResult[] = [];
      for (const node of nodes) {
        const d = node.data as Record<string, unknown>;
        const title = String(d.title ?? d.name ?? "").toLowerCase();
        const synopsis = String(d.synopsis ?? d.summary ?? "").toLowerCase();
        if (title.includes(trimmed) || synopsis.includes(trimmed)) {
          hits.push({
            nodeId: node.id,
            label: String(d.title ?? d.name ?? node.id),
          });
        }
      }
      setResults(hits);
      setCursor(0);
    },
    [nodes],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (e.key === "Enter" && results.length > 0) {
        onFocus(results[cursor].nodeId);
      }
    },
    [results, cursor, onFocus, onClose],
  );

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        width: 320,
        zIndex: 20,
        background: "var(--background)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
        overflow: "hidden",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 10px",
          gap: 6,
        }}
      >
        <span style={{ fontSize: 14, color: "var(--muted-foreground)" }}>
          🔍
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            search(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="ノードを検索..."
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 13,
            color: "var(--foreground)",
          }}
        />
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--muted-foreground)",
            fontSize: 14,
            padding: "0 2px",
          }}
        >
          ✕
        </button>
      </div>

      {results.length > 0 && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {results.map((r, i) => (
            <div
              key={r.nodeId}
              onClick={() => onFocus(r.nodeId)}
              style={{
                padding: "6px 12px",
                cursor: "pointer",
                background: i === cursor ? "var(--accent)" : "transparent",
                color:
                  i === cursor
                    ? "var(--accent-foreground)"
                    : "var(--foreground)",
                fontSize: 12,
              }}
              onMouseEnter={() => setCursor(i)}
            >
              {r.label}
            </div>
          ))}
        </div>
      )}

      {query.trim() && results.length === 0 && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "8px 12px",
            fontSize: 12,
            color: "var(--muted-foreground)",
          }}
        >
          見つかりません
        </div>
      )}
    </div>
  );
}
