import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "./layoutStore";

/**
 * Center Stripe 内の editor 開閉トグル。
 *
 * `editor` は移動・除去不可の固定 segment のため、`ToolWindowIcon` と異なり
 * ドラッグもコンテキストメニューも持たない専用アイコンとする。
 */
export function EditorToggleIcon() {
  const { t } = useTranslation();
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const editorOpen = useLayoutStore((s) => s.layout.center.editorOpen);

  const label = t("layout.panel.editor");

  return (
    <button
      type="button"
      data-stripe-icon="editor"
      data-state={editorOpen ? "shown" : "hidden"}
      title={label}
      aria-label={label}
      aria-pressed={editorOpen}
      onClick={() => togglePanel("editor")}
      className={cn(
        "relative z-30 flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors",
        "transition-transform duration-75 active:scale-[0.94]",
        editorOpen
          ? "bg-accent text-foreground"
          : "text-muted-foreground/60 hover:bg-accent/30 hover:text-foreground",
      )}
    >
      <FileText className="h-4 w-4" />
      {editorOpen && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-1/2 h-3 w-[2px] -translate-y-1/2 rounded-full bg-primary"
        />
      )}
    </button>
  );
}
