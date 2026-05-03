import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, LayoutTemplate } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { STRUCTURE_TEMPLATES } from "./structureTemplates";
import { applyStructureTemplate } from "./applyStructureTemplate";

interface Props {
  projectId: string;
  containerId: string | null;
}

export function StructureTemplatePicker({ projectId, containerId }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleApply(templateKey: string) {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const result = await applyStructureTemplate(
        projectId,
        templateKey,
        containerId,
      );
      toast.success(
        t("grid.actions.structureTemplateApplied", {
          folders: result.folders,
          scenes: result.scenes,
        }),
      );
    } catch {
      toast.error(t("common.error", "エラーが発生しました"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative inline-flex flex-col items-stretch">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded border border-border bg-background px-2.5 py-1 text-xs font-medium",
          "hover:bg-accent hover:text-accent-foreground transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <LayoutTemplate className="h-3.5 w-3.5" />
        {t("grid.actions.applyStructureTemplate", "構造テンプレートを適用")}
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <ul className="mt-1 flex flex-col rounded border border-border bg-popover p-1 text-xs shadow-md">
          {STRUCTURE_TEMPLATES.map((tmpl) => (
            <li key={tmpl.key}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleApply(tmpl.key)}
                className="w-full rounded px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
              >
                {t(`grid.structureTemplates.${tmpl.key}.name`, tmpl.key)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
