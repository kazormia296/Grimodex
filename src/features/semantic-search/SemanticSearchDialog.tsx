import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { semanticSearch, type SemanticSearchHit } from "./api";
import { useSemanticNavStore } from "./semanticNavStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useSearchModeStore } from "@/features/search/searchModeStore";

/**
 * 本文セマンティック検索 Dialog (Step 9)。
 *
 * 同じ Ctrl+Shift+F で `GlobalSearchDialog` (字句検索) と交互に出る。
 * モードは `useSearchModeStore` で永続化 (localStorage)。
 *
 * 結果クリックで該当シーンを開き、`useSemanticNavStore` に chunk_text を渡して
 * エディタ側 (`EditorPane`) で findChunkInDoc → scrollIntoView + setTextSelection
 * によりハイライト+スクロールさせる (§3.6)。
 */

// GlobalSearchDialog と一致させる必要は無いが、frontend 全体で project id を
// 持たない方針なので同じ DEFAULT を使う。
const PROJECT_ID = "default-project";
const DEBOUNCE_MS = 300; // FTS5 (200ms) より長めに

interface SemanticSearchDialogProps {
  onClose: () => void;
}

export function SemanticSearchDialog({ onClose }: SemanticSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [descriptionMode, setDescriptionMode] = useState(false);
  const [results, setResults] = useState<SemanticSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setMode = useSearchModeStore((s) => s.setMode);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced search. query / descriptionMode のどちらが変わっても再実行する。
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    timerRef.current = setTimeout(async () => {
      try {
        const hits = await semanticSearch({
          projectId: PROJECT_ID,
          query: q,
          limit: 20,
          descriptionMode,
        });
        setResults(hits);
        setSelectedIndex(0);
      } catch (e) {
        setResults([]);
        setError(String((e as Error)?.message ?? e));
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
  }, [query, descriptionMode]);

  const openHit = useCallback(
    (hit: SemanticSearchHit) => {
      const { showPanel } = useLayoutStore.getState();
      // setActiveScene 前に jump を登録しておく。EditorPane の switchScene
      // 経路は同一 microtask で consume するため、ここで先に書く。
      useSemanticNavStore.getState().requestJump({
        sceneId: hit.sceneId,
        chunkText: hit.chunkText,
      });
      onClose();
      setActiveScene(hit.sceneId);
      showPanel("editor");
    },
    [onClose, setActiveScene],
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
        openHit(results[selectedIndex]);
      }
    },
    [results, selectedIndex, openHit],
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
          width: 600,
          maxWidth: "92vw",
          background: "var(--popover)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mode tabs */}
        <SearchModeTabs current="semantic" onSelect={setMode} />

        {/* Input row */}
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
            🔎
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="意味で本文を検索 (例: 嵐の描写、後悔している場面)"
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

        {/* Description mode toggle */}
        <div
          style={{
            padding: "6px 14px",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--muted-foreground)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={descriptionMode}
              onChange={(e) => setDescriptionMode(e.target.checked)}
            />
            地の文を優先 (会話文比率が高いチャンクのスコアを下げる)
          </label>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 380, overflowY: "auto" }}>
          {error && (
            <div
              style={{
                padding: "16px 14px",
                fontSize: 12,
                color: "var(--destructive)",
              }}
            >
              {error}
            </div>
          )}
          {!error && results.length === 0 && query.trim() && !loading && (
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
          {!error && results.length === 0 && !query.trim() && (
            <div
              style={{
                padding: "16px 14px",
                fontSize: 12,
                color: "var(--muted-foreground)",
              }}
            >
              <div style={{ marginBottom: 6 }}>本文を意味で検索します</div>
              <div style={{ opacity: 0.7 }}>
                字句一致ではなく、意味的に近い場面を返します。
              </div>
            </div>
          )}
          {results.map((hit, i) => (
            <HitRow
              key={`${hit.sceneId}:${hit.charStart}:${i}`}
              hit={hit}
              selected={i === selectedIndex}
              onClick={() => openHit(hit)}
              onHover={() => setSelectedIndex(i)}
            />
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
          <span>Enter シーンを開く</span>
          <span>Esc 閉じる</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * モードタブ。両 Dialog で共通レイアウトを保つため、export して
 * `GlobalSearchDialog` 側でも同じものを使う。
 */
export function SearchModeTabs({
  current,
  onSelect,
}: {
  current: "lexical" | "semantic";
  onSelect: (mode: "lexical" | "semantic") => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        borderBottom: "1px solid var(--border)",
        background: "var(--muted)",
      }}
    >
      <TabButton
        label="字句検索"
        active={current === "lexical"}
        onClick={() => onSelect("lexical")}
      />
      <TabButton
        label="意味検索"
        active={current === "semantic"}
        onClick={() => onSelect("semantic")}
      />
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px 12px",
        background: active ? "var(--popover)" : "transparent",
        border: "none",
        borderBottom: active
          ? "2px solid var(--primary)"
          : "2px solid transparent",
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function HitRow({
  hit,
  selected,
  onClick,
  onHover,
}: {
  hit: SemanticSearchHit;
  selected: boolean;
  onClick: () => void;
  onHover: () => void;
}) {
  // 表示の都合: chunk_text は改行を 1 行に潰し、長すぎる場合は ellipsis。
  const oneLine = hit.chunkText.replace(/\s+/g, " ").trim();
  // dialogue ratio はバッジ色分けに使う (>0.6 で会話寄り)。
  const isDialogue = hit.dialogueRatio > 0.6;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "10px 14px",
        background: selected ? "var(--accent)" : "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <ScoreBadge score={hit.score} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--muted-foreground)",
            marginBottom: 2,
          }}
        >
          <span
            style={{
              fontWeight: 500,
              color: "var(--foreground)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 220,
            }}
          >
            {hit.sceneTitle || "(無題シーン)"}
          </span>
          <span
            style={{
              fontSize: 10,
              padding: "1px 5px",
              borderRadius: 3,
              border: `1px solid ${isDialogue ? "#D9770655" : "#05966944"}`,
              background: isDialogue ? "#D9770618" : "#05966914",
              color: isDialogue ? "#D97706" : "#059669",
            }}
            title={`dialogueRatio=${hit.dialogueRatio.toFixed(2)}`}
          >
            {isDialogue ? "会話" : "地"}
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--foreground)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {oneLine}
        </div>
      </div>
    </button>
  );
}

function ScoreBadge({ score }: { score: number }) {
  // 0.0 ~ 1.0 を色強度に。L2 正規化済みドット積 → コサインなので大体 [0,1] レンジ。
  const clipped = Math.max(0, Math.min(1, score));
  const alpha = 0.15 + clipped * 0.5;
  return (
    <span
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        fontWeight: 600,
        color: "var(--foreground)",
        background: `rgba(83, 74, 183, ${alpha})`,
        border: "1px solid rgba(83, 74, 183, 0.4)",
        borderRadius: 3,
        padding: "2px 5px",
        flexShrink: 0,
        minWidth: 42,
        textAlign: "center",
      }}
      title={`cosine score=${score.toFixed(4)}`}
    >
      {clipped.toFixed(2)}
    </span>
  );
}
