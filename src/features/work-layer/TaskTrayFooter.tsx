import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useWorkLayer } from "./WorkLayerContext";

export function TaskTrayFooter() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  if (workLayer == null) return null;

  return (
    <footer className="flex items-center gap-3 border-t border-foreground/30 px-4 py-2 text-[11px] text-muted-foreground">
      <button
        type="button"
        disabled
        className="flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Plus className="h-3 w-3" />
        {t("workLayer.tray.capture", "作業を捕捉")}
      </button>
      <button
        id="work-layer-open-ledger"
        type="button"
        aria-label={t("workLayer.ledger.openAria", "すべての作業を開く")}
        onClick={workLayer.openLedger}
        className="hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("workLayer.ledger.open", "すべての作業 →")}
      </button>
      <span className="ml-auto font-mono text-[8px] tracking-[0.1em]">ESC</span>
    </footer>
  );
}
