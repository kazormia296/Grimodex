import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface AIBranchDialogProps {
  boardId: string;
  spawnPosition: { x: number; y: number };
  seedNodeTitles: string[];
  onConfirm: (prompt: string, count: 3 | 5 | 8) => void;
  onCancel: () => void;
}

const COUNT_OPTIONS = [3, 5, 8] as const;

export function AINodeDialog({
  seedNodeTitles,
  onConfirm,
  onCancel,
}: AIBranchDialogProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState<3 | 5 | 8>(5);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const canSubmit = prompt.trim().length > 0;

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
      onClick={onCancel}
    >
      <div
        className="bg-popover border border-border rounded-lg shadow-xl"
        style={{ minWidth: 360, maxWidth: 520, padding: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--foreground)",
            marginBottom: 16,
          }}
        >
          {t("map.aiBranch.label")}
        </div>

        {seedNodeTitles.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--muted-foreground)",
                marginBottom: 4,
              }}
            >
              {t("map.aiNodeDialog.context")}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {seedNodeTitles.map((title, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 12,
                    background: "var(--accent)",
                    color: "var(--accent-foreground)",
                  }}
                >
                  {title}
                </span>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 11,
              color: "var(--muted-foreground)",
              marginBottom: 4,
            }}
          >
            {t("map.aiNodeDialog.prompt")}
          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("map.aiNodeDialog.promptPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
                onConfirm(prompt.trim(), count);
              }
            }}
            style={{
              width: "100%",
              minHeight: 80,
              resize: "vertical",
              padding: "8px 10px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              boxSizing: "border-box",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 20,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
            {t("map.aiNodeDialog.generateCount")}
          </span>
          {COUNT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setCount(n)}
              style={{
                padding: "3px 12px",
                fontSize: 12,
                borderRadius: 4,
                border: "1px solid",
                borderColor: count === n ? "#534AB7" : "var(--border)",
                background: count === n ? "#534AB7" : "var(--secondary)",
                color: count === n ? "#fff" : "var(--secondary-foreground)",
                cursor: "pointer",
                fontWeight: count === n ? 600 : 400,
              }}
            >
              {n}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "5px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--foreground)",
              cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => canSubmit && onConfirm(prompt.trim(), count)}
            style={{
              padding: "5px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "none",
              background: canSubmit ? "#534AB7" : "var(--muted)",
              color: canSubmit ? "#fff" : "var(--muted-foreground)",
              cursor: canSubmit ? "pointer" : "not-allowed",
              fontWeight: 600,
            }}
          >
            {t("map.aiNodeDialog.generate")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
