import { createPortal } from "react-dom";
import { useState, useEffect, useRef } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { upsertNodePosition } from "./mapApi";
import type { MapNodePositionRecord } from "./types";

type EntityType = "scene" | "note" | "codex" | "snippet";

const TYPE_LABELS: Record<EntityType, string> = {
  scene: "シーン",
  note: "ノート",
  codex: "Codex",
  snippet: "スニペット",
};

interface AddToMapPickerDialogProps {
  boardId: string;
  initialType?: EntityType;
  /** Map 中心 (flow 座標) を返す。MapCanvas の getSpawnPosition を渡す。
   *  window.innerWidth/2 ベースの自前計算だと Map が region に部分占有
   *  しているレイアウトでズレるため必須。 */
  getSpawnPosition: () => { x: number; y: number };
  onPicked?: (position: MapNodePositionRecord) => void;
  onClose: () => void;
}

export function AddToMapPickerDialog({
  boardId,
  initialType = "scene",
  getSpawnPosition,
  onPicked,
  onClose,
}: AddToMapPickerDialogProps) {
  const [entityType, setEntityType] = useState<EntityType>(initialType);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const treeNodes = useTreeStore((s) => s.nodes);
  const codexEntries = useCodexStore((s) => s.entries);
  const snippetEntries = useSnippetStore((s) => s.entries);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setQuery("");
  }, [entityType]);

  const lower = query.toLowerCase();

  const items: { id: string; label: string }[] = (() => {
    if (entityType === "scene") {
      return treeNodes
        .filter(
          (n) =>
            n.nodeType === "scene" &&
            (lower === "" || n.title.toLowerCase().includes(lower)),
        )
        .map((n) => ({ id: n.id, label: n.title || "(無題)" }));
    }
    if (entityType === "note") {
      return treeNodes
        .filter(
          (n) =>
            n.nodeType === "note" &&
            (lower === "" || n.title.toLowerCase().includes(lower)),
        )
        .map((n) => ({ id: n.id, label: n.title || "(無題)" }));
    }
    if (entityType === "codex") {
      return codexEntries
        .filter((e) => lower === "" || e.name.toLowerCase().includes(lower))
        .map((e) => ({ id: e.id, label: e.name || "(無題)" }));
    }
    // snippet
    return snippetEntries
      .filter((s) => {
        const text = s.title || s.content.slice(0, 80);
        return lower === "" || text.toLowerCase().includes(lower);
      })
      .map((s) => ({
        id: s.id,
        label: s.title || s.content.slice(0, 60) || "(空)",
      }));
  })();

  async function handleSelect(id: string) {
    const { x, y } = getSpawnPosition();

    const args =
      entityType === "scene" || entityType === "note"
        ? { boardId, nodeRefType: entityType, treeNodeId: id, x, y }
        : entityType === "codex"
          ? { boardId, nodeRefType: "codex" as const, codexEntryId: id, x, y }
          : { boardId, nodeRefType: "snippet" as const, snippetId: id, x, y };

    const inserted = await upsertNodePosition(args);
    onPicked?.(inserted as MapNodePositionRecord);
    onClose();
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 400,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--popover)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Type tabs */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid var(--border)",
            padding: "4px 8px 0",
            gap: 2,
          }}
        >
          {(["scene", "note", "codex", "snippet"] as EntityType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setEntityType(t)}
              style={{
                padding: "4px 12px",
                fontSize: 12,
                border: "none",
                borderBottom:
                  entityType === t
                    ? "2px solid #534AB7"
                    : "2px solid transparent",
                background: "transparent",
                color:
                  entityType === t
                    ? "var(--foreground)"
                    : "var(--muted-foreground)",
                cursor: "pointer",
                fontWeight: entityType === t ? 600 : 400,
              }}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>

        {/* Search */}
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={`${TYPE_LABELS[entityType]}を検索…`}
            style={{
              width: "100%",
              padding: "6px 10px",
              fontSize: 13,
              border: "1px solid var(--border)",
              borderRadius: 5,
              background: "var(--background)",
              color: "var(--foreground)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {items.length === 0 ? (
            <div
              style={{
                padding: "16px 12px",
                textAlign: "center",
                fontSize: 12,
                color: "var(--muted-foreground)",
              }}
            >
              {query
                ? "一致するものがありません"
                : `${TYPE_LABELS[entityType]}がありません`}
            </div>
          ) : (
            items.slice(0, 50).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void handleSelect(item.id)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "7px 14px",
                  textAlign: "left",
                  fontSize: 13,
                  border: "none",
                  background: "transparent",
                  color: "var(--foreground)",
                  cursor: "pointer",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--accent)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                {item.label}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
