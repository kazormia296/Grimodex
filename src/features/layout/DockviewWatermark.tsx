import type { IWatermarkPanelProps } from "dockview-react";
import { useTranslation } from "react-i18next";

export function DockviewWatermark(_props: IWatermarkPanelProps) {
  const { t } = useTranslation();

  const shortcuts = [
    { key: "Ctrl+Alt+S", label: t("layout.watermark.scene") },
    { key: "Ctrl+Alt+C", label: t("layout.watermark.chat") },
    { key: "Ctrl+Alt+X", label: "Codex" },
    { key: "Ctrl+Alt+N", label: "Snippets" },
  ];

  return (
    <div
      data-testid="dockview-watermark"
      className="flex h-full flex-col items-center justify-center gap-4 select-none text-muted-foreground"
    >
      <p className="text-sm">{t("layout.watermark.panelsClosed")}</p>
      <div className="flex flex-col gap-1 text-xs opacity-60">
        {shortcuts.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-3">
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              {key}
            </kbd>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
