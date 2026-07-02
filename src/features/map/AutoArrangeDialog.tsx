import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AutoArrangeType } from "./layouts/autoArrange";

const LABEL_KEYS: Record<AutoArrangeType, string> = {
  "reading-order": "map.autoArrange.layoutReadingOrder",
  "force-directed": "map.autoArrange.layoutForceDirected",
};

interface AutoArrangeDialogProps {
  type: AutoArrangeType;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AutoArrangeDialog({
  type,
  onConfirm,
  onCancel,
}: AutoArrangeDialogProps) {
  const { t } = useTranslation();

  // Escape でキーボードからも閉じられるようにする (WCAG 2.1.1)。
  // capture で先取りし、Map 側など後続の Escape 処理へ流さない。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [onCancel]);

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
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("map.autoArrange.title")}
        className="bg-popover border border-border rounded-lg shadow-xl p-6"
        style={{ minWidth: 360, maxWidth: 440 }}
      >
        <h3
          style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}
          className="text-foreground"
        >
          {t("map.autoArrange.title")}
        </h3>
        <p
          style={{ fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}
          className="text-muted-foreground"
        >
          {t("map.autoArrange.runLayout", { label: t(LABEL_KEYS[type]) })}
          <br />
          {t("map.autoArrange.description")}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="hover:bg-accent text-foreground"
            style={{
              padding: "4px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              cursor: "pointer",
              background: "transparent",
            }}
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            style={{
              padding: "4px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "none",
              cursor: "pointer",
              background: "#534AB7",
              color: "#fff",
            }}
            onClick={onConfirm}
          >
            {t("map.autoArrange.run")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
