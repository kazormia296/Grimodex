import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { listCodexEntries, type CodexEntry } from "@/features/codex/api";
import {
  generateCorrelationBoard,
  type CorrelationProgress,
} from "./correlationBoard";
import { ForceLayoutProgress } from "./ForceLayoutProgress";

interface CorrelationDialogProps {
  projectId: string;
  onGenerated: (boardId: string) => void;
  onClose: () => void;
}

const PROGRESS_LABELS: Record<CorrelationProgress["phase"], string> = {
  "cross-reference": "本文の登場人物を解析中…",
  layout: "レイアウト計算中…",
  writing: "相関図を保存中…",
};

export function CorrelationDialog({
  projectId,
  onGenerated,
  onClose,
}: CorrelationDialogProps) {
  const [characters, setCharacters] = useState<CodexEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minShared, setMinShared] = useState(2);
  const [includeFrames, setIncludeFrames] = useState(false);
  const [progress, setProgress] = useState<CorrelationProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listCodexEntries(projectId, "character");
        if (cancelled) return;
        rows.sort((a, b) => a.name.localeCompare(b.name));
        setCharacters(rows);
        setSelected(new Set(rows.map((r) => r.id)));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const allSelected = useMemo(
    () => characters.length > 0 && selected.size === characters.length,
    [characters.length, selected.size],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(characters.map((c) => c.id)));
  };

  const running = progress !== null;
  const canRun =
    loaded && characters.length > 0 && selected.size > 0 && !running;

  const run = async () => {
    if (!canRun) return;
    setProgress({ phase: "cross-reference" });
    try {
      const { boardId } = await generateCorrelationBoard(
        projectId,
        {
          characterIds: allSelected ? null : [...selected],
          minSharedScenes: minShared,
          includeParentFrames: includeFrames,
        },
        (p) => setProgress(p),
      );
      onGenerated(boardId);
    } catch (e) {
      setProgress(null);
      toast.error(
        e instanceof Error ? e.message : "相関図の生成に失敗しました",
      );
    }
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={running ? undefined : onClose}
    >
      <div
        className="bg-popover border border-border rounded-lg shadow-xl"
        style={{ minWidth: 380, maxWidth: 480, padding: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--foreground)",
            marginBottom: 4,
          }}
        >
          人物相関図を生成
        </div>
        <p
          style={{
            fontSize: 12,
            color: "var(--muted-foreground)",
            marginBottom: 16,
            lineHeight: 1.5,
          }}
        >
          本文の共起と作成済みの関係から、キャラクター同士の相関図ボードを 1
          つ生成します。
        </p>

        {/* Character picker */}
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
              対象キャラクター（{selected.size}/{characters.length}）
            </span>
            {characters.length > 0 && (
              <button
                type="button"
                onClick={toggleAll}
                disabled={running}
                style={{
                  fontSize: 11,
                  color: "#534AB7",
                  background: "transparent",
                  border: "none",
                  cursor: running ? "default" : "pointer",
                }}
              >
                {allSelected ? "全解除" : "全選択"}
              </button>
            )}
          </div>
          <div
            style={{
              maxHeight: 180,
              overflowY: "auto",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 6,
            }}
          >
            {!loaded ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--muted-foreground)",
                  padding: 6,
                }}
              >
                読み込み中…
              </div>
            ) : characters.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--muted-foreground)",
                  padding: 6,
                }}
              >
                character タイプの Codex エントリがありません。
              </div>
            ) : (
              characters.map((c) => (
                <label
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "3px 4px",
                    fontSize: 13,
                    cursor: running ? "default" : "pointer",
                    color: "var(--foreground)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    disabled={running}
                  />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.name}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>

        {/* Options */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            fontSize: 12,
            color: "var(--foreground)",
          }}
        >
          共起のしきい値（共有シーン数）
          <input
            type="number"
            min={1}
            value={minShared}
            disabled={running}
            onChange={(e) =>
              setMinShared(Math.max(1, Number(e.target.value) || 1))
            }
            style={{
              width: 56,
              fontSize: 13,
              padding: "3px 6px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
            }}
          />
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--foreground)",
            marginBottom: 20,
            cursor: running ? "default" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={includeFrames}
            disabled={running}
            onChange={(e) => setIncludeFrames(e.target.checked)}
          />
          同じ親エントリのキャラクターを枠で囲む
        </label>

        {/* Progress */}
        {running && (
          <div
            style={{ marginBottom: 16, position: "relative", minHeight: 24 }}
          >
            {progress?.phase === "layout" ? (
              <div style={{ position: "relative", height: 24 }}>
                <ForceLayoutProgress alpha={progress.alpha ?? 1} />
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--muted-foreground)",
                }}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                {progress ? PROGRESS_LABELS[progress.phase] : ""}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            style={{
              padding: "5px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--foreground)",
              cursor: running ? "default" : "pointer",
            }}
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void run()}
            style={{
              padding: "5px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "none",
              background: canRun ? "#534AB7" : "var(--muted)",
              color: canRun ? "#fff" : "var(--muted-foreground)",
              cursor: canRun ? "pointer" : "not-allowed",
              fontWeight: 600,
            }}
          >
            生成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
