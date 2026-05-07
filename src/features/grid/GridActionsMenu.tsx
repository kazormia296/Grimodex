import { useTranslation } from "react-i18next";
import { LayoutTemplate, Tag, HelpCircle, MoreVertical } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";
import { STRUCTURE_TEMPLATES } from "./structureTemplates";
import { applyStructureTemplate } from "./applyStructureTemplate";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  onManageLabels?: () => void;
}

export function GridActionsMenu({ onManageLabels }: Props) {
  const { t } = useTranslation();
  const projectId = useTreeStore((s) => s.projectId);
  const containerId = useGridStore((s) => s.containerId);

  async function handleApplyTemplate(templateKey: string) {
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
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon-xs"
          className="border-border/60 text-muted-foreground hover:text-foreground"
          title={t("grid.header.actionsMenu", "アクション")}
        >
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <LayoutTemplate className="h-3.5 w-3.5" />
            {t("grid.actions.applyStructureTemplate", "構造テンプレートを適用")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[220px]">
            {STRUCTURE_TEMPLATES.map((tmpl) => (
              <DropdownMenuItem
                key={tmpl.key}
                onSelect={() => void handleApplyTemplate(tmpl.key)}
              >
                {t(`grid.structureTemplates.${tmpl.key}.name`, tmpl.key)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem onSelect={() => onManageLabels?.()}>
          <Tag className="h-3.5 w-3.5" />
          {t("grid.actions.manageLabels", "Label を管理…")}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem disabled>
          <HelpCircle className="h-3.5 w-3.5" />
          {t("grid.actions.help", "Grid の使い方")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
