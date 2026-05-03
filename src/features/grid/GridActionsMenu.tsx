import { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Tag, HelpCircle } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { LABEL_TEMPLATES } from "./labelTemplates";
import { applyLabelTemplate } from "./applyLabelTemplate";
import { toast } from "sonner";

interface Props {
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  onManageLabels?: () => void;
}

export function GridActionsMenu({ onClose, anchorRef, onManageLabels }: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const projectId = useTreeStore((s) => s.projectId);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, anchorRef]);

  async function handleApplyTemplate(templateKey: string) {
    onClose();
    try {
      const result = await applyLabelTemplate(projectId, templateKey);
      if (result.added === 0) {
        toast(t("grid.actions.templateAppliedNone"));
      } else {
        toast.success(
          t("grid.actions.templateApplied", {
            added: result.added,
            skipped: result.skipped,
          }),
        );
      }
    } catch {
      toast.error(t("common.error", "エラーが発生しました"));
    }
  }

  return (
    <div
      ref={menuRef}
      className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded-md border bg-popover p-1 shadow-md text-sm"
    >
      {/* Apply label template submenu */}
      <div
        className="relative"
        onMouseEnter={() => setTemplateMenuOpen(true)}
        onMouseLeave={() => setTemplateMenuOpen(false)}
      >
        <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
          <Tag className="h-3.5 w-3.5" />
          {t("grid.actions.applyTemplate", "Label テンプレートを適用")}
          <ChevronRight className="ml-auto h-3 w-3" />
        </button>
        {templateMenuOpen && (
          <div className="absolute right-full top-0 mr-1 min-w-[200px] rounded-md border bg-popover p-1 shadow-md">
            {LABEL_TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.key}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent text-left"
                onClick={() => void handleApplyTemplate(tmpl.key)}
              >
                {t(`grid.labelTemplates.${tmpl.nameI18nKey}`, tmpl.nameI18nKey)}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={() => {
          onManageLabels?.();
          onClose();
        }}
      >
        <Tag className="h-3.5 w-3.5" />
        {t("grid.actions.manageLabels", "Label を管理…")}
      </button>
      <hr className="my-1 border-border" />
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-muted-foreground/50 cursor-not-allowed"
        disabled
      >
        <HelpCircle className="h-3.5 w-3.5" />
        {t("grid.actions.help", "Grid の使い方")}
      </button>
    </div>
  );
}
