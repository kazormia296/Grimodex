import type { RefObject } from "react";
import { Target } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SynopsisArea } from "@/features/tree/SynopsisArea";
import { useTreeStore } from "@/features/tree/treeStore";
import { AnchoredPopoverShell } from "./AnchoredPopoverShell";

interface SynopsisChipPopoverProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  sceneId: string;
}

/**
 * チップ行(1h)の「あらすじ」その場編集ポップオーバー。
 * 編集・AI生成は SynopsisArea（パネルと同一部品）に委譲し二重管理を避ける。
 */
export function SynopsisChipPopover({
  open,
  onClose,
  triggerRef,
  sceneId,
}: SynopsisChipPopoverProps) {
  const { t } = useTranslation();
  const intent = useTreeStore(
    (s) => s.nodes.find((n) => n.id === sceneId)?.intent ?? null,
  );
  return (
    <AnchoredPopoverShell
      open={open}
      onClose={onClose}
      triggerRef={triggerRef}
      ariaLabel={t("editor.synopsis.title")}
      className="w-[300px]"
      testId="synopsis-chip-popover"
    >
      <div className="border-b border-border px-3 py-1.5 text-[10px] font-bold text-muted-foreground">
        {t("editor.synopsis.title")}
      </div>
      <div className="px-3 py-2">
        <SynopsisArea nodeId={sceneId} bare />
        {intent && (
          <p className="mt-1.5 flex items-start gap-1 text-[10px] text-muted-foreground">
            <Target size={10} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{intent}</span>
          </p>
        )}
      </div>
    </AnchoredPopoverShell>
  );
}
