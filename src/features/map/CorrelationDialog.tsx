import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
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

const progressLabels = (): Record<CorrelationProgress["phase"], string> => ({
  "cross-reference": i18next.t("map.correlationDialog.progressCrossReference"),
  layout: i18next.t("map.correlationDialog.progressLayout"),
  writing: i18next.t("map.correlationDialog.progressWriting"),
});

export function CorrelationDialog({
  projectId,
  onGenerated,
  onClose,
}: CorrelationDialogProps) {
  const { t } = useTranslation();
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

  // Escape でキーボードからも閉じられるようにする (WCAG 2.1.1)。
  // 背景クリック同様、生成実行中は閉じない。
  useEffect(() => {
    if (running) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [running, onClose]);

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
        e instanceof Error
          ? e.message
          : t("map.correlationDialog.generateFailed"),
      );
    }
  };

  return createPortal(
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={
        running
          ? undefined
          : (e) => {
              if (e.target === e.currentTarget) onClose();
            }
      }
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("map.correlationDialog.title")}
        className="bg-popover border border-border rounded-lg shadow-xl"
        style={{ minWidth: 380, maxWidth: 480, padding: 24 }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--foreground)",
            marginBottom: 4,
          }}
        >
          {t("map.correlationDialog.title")}
        </div>
        <p
          style={{
            fontSize: 12,
            color: "var(--muted-foreground)",
            marginBottom: 16,
            lineHeight: 1.5,
          }}
        >
          {t("map.correlationDialog.description")}
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
              {t("map.correlationDialog.targetCharacters", {
                selected: selected.size,
                total: characters.length,
              })}
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
                {allSelected
                  ? t("map.correlationDialog.deselectAll")
                  : t("map.correlationDialog.selectAll")}
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
                {t("map.correlationDialog.loading")}
              </div>
            ) : characters.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--muted-foreground)",
                  padding: 6,
                }}
              >
                {t("map.correlationDialog.noCharacters")}
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
          {t("map.correlationDialog.thresholdLabel")}
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
          {t("map.correlationDialog.groupByParent")}
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
                {progress ? progressLabels()[progress.phase] : ""}
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
            {t("common.cancel")}
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
            {t("map.correlationDialog.generate")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
