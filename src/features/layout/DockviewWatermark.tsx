import type { IWatermarkPanelProps } from "dockview-react";

const SHORTCUTS = [
  { key: "Ctrl+Alt+S", label: "シーン" },
  { key: "Ctrl+Alt+C", label: "チャット" },
  { key: "Ctrl+Alt+X", label: "Codex" },
  { key: "Ctrl+Alt+N", label: "Snippets" },
];

export function DockviewWatermark(_props: IWatermarkPanelProps) {
  return (
    <div
      data-testid="dockview-watermark"
      className="flex h-full flex-col items-center justify-center gap-4 select-none text-muted-foreground"
    >
      <p className="text-sm">パネルが閉じられています</p>
      <div className="flex flex-col gap-1 text-xs opacity-60">
        {SHORTCUTS.map(({ key, label }) => (
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
