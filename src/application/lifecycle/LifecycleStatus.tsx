import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useQuiescenceLeaseActive } from "./useQuiescenceLeaseActive";

/**
 * Visible and screen-reader-readable progress outside `.app-shell`.
 *
 * The editor shell is inert while destructive lifecycle work drains pending
 * writes. A body portal keeps this status perceivable instead of placing the
 * only explanation inside the subtree that assistive technology must ignore.
 */
export function LifecycleStatus() {
  const { t } = useTranslation();
  const lifecycleLocked = useQuiescenceLeaseActive();

  if (!lifecycleLocked || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="lifecycle-status"
      className="pointer-events-none fixed left-1/2 top-3 z-[100] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1.5 text-center text-xs font-medium text-popover-foreground shadow-lg"
    >
      {t("app.lifecycleBusy")}
    </div>,
    document.body,
  );
}
