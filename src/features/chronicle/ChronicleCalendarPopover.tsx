import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { ChronicleCalendarEditor } from "./ChronicleCalendarEditor";
import type { ChronicleCalendar } from "./chronicleTime";

export interface ChronicleCalendarPopoverProps {
  triggerRef: RefObject<HTMLElement | null>;
  open: boolean;
  initial: ChronicleCalendar | null;
  onSave: (cal: ChronicleCalendar) => void | Promise<void>;
  onClose: () => void;
  onSavingChange?: (saving: boolean) => void;
}

/**
 * 暦設定エディタを、暦ボタン基準で body へ portal する固定配置ポップオーバーに包む。
 * 旧来の inline パネル（border-b 全幅）からポップオーバー化する要望対応。
 * 位置計算・外側クリック/Escape 閉じは useAnchoredPopover に委譲。
 */
export function ChronicleCalendarPopover({
  triggerRef,
  open,
  initial,
  onSave,
  onClose,
  onSavingChange,
}: ChronicleCalendarPopoverProps) {
  const { t } = useTranslation();
  const savingRef = useRef(false);
  useEffect(() => {
    if (!open) {
      savingRef.current = false;
      onSavingChange?.(false);
    }
  }, [onSavingChange, open]);
  const handleSavingChange = useCallback(
    (saving: boolean) => {
      savingRef.current = saving;
      onSavingChange?.(saving);
    },
    [onSavingChange],
  );
  const requestClose = useCallback(() => {
    if (!savingRef.current) onClose();
  }, [onClose]);
  const { popoverRef, style, maxHeight } = useAnchoredPopover(
    triggerRef,
    open,
    requestClose,
    "bottom-start",
  );
  if (!open || !style) return null;
  return createPortal(
    <div
      ref={popoverRef}
      style={{ ...style, maxHeight: maxHeight ?? undefined }}
      className="z-50 w-[380px] overflow-auto rounded-lg border border-border bg-card shadow-lg"
      role="dialog"
      aria-modal="true"
      aria-label={t("chronicle.calendarEditor", "暦の設定")}
    >
      <ChronicleCalendarEditor
        initial={initial}
        onSave={onSave}
        onClose={requestClose}
        onSavingChange={handleSavingChange}
      />
    </div>,
    document.body,
  );
}
