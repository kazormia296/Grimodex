import { useTranslation } from "react-i18next";
import { useLayoutStore } from "@/features/layout/layoutStore";
import type { PanelId } from "@/features/layout/layoutStore";

const DEMO_PANELS: PanelId[] = [
  "scenes",
  "chat",
  "codex",
  "snippets",
  "editor",
];

export function LayoutDemoCard() {
  const { t } = useTranslation();
  const { togglePanel, isPanelVisible } = useLayoutStore();

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2.5">
      <p className="mb-2 text-xs text-muted-foreground">
        {t("onboarding.demo.layout.hint")}
      </p>
      <div className="space-y-1.5">
        {DEMO_PANELS.map((id) => (
          <label
            key={id}
            className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/60"
          >
            <input
              type="checkbox"
              checked={isPanelVisible(id)}
              onChange={() => togglePanel(id)}
              className="accent-primary"
            />
            <span className="text-xs text-foreground">
              {t(`layout.panel.${id}`)}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
