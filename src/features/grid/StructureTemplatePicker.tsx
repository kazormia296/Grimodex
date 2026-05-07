import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, LayoutTemplate } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { STRUCTURE_TEMPLATES } from "./structureTemplates";
import { applyStructureTemplate } from "./applyStructureTemplate";

interface Props {
  projectId: string;
  containerId: string | null;
}

export function StructureTemplatePicker({ projectId, containerId }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  async function handleApply(templateKey: string) {
    if (busy) return;
    setBusy(true);
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" disabled={busy}>
          <LayoutTemplate />
          {t("grid.actions.applyStructureTemplate", "構造テンプレートを適用")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {STRUCTURE_TEMPLATES.map((tmpl) => (
          <DropdownMenuItem
            key={tmpl.key}
            disabled={busy}
            onSelect={() => void handleApply(tmpl.key)}
          >
            {t(`grid.structureTemplates.${tmpl.key}.name`, tmpl.key)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
