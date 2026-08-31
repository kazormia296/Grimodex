import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

const INITIAL_FOCUS_SELECTOR = [
  "[autofocus]",
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface AnimatedOverlayProps {
  open: boolean;
  onClose: () => void;
  /** Inner content wrapper className */
  className?: string;
  /** Replaces the default backdrop color class (default: "bg-black/50") */
  backdropClassName?: string;
  /** data-testid forwarded to the inner content motion.div */
  testId?: string;
  /** data-tour-target forwarded to the inner content motion.div */
  "data-tour-target"?: string;
  children: React.ReactNode;
}

export function AnimatedOverlay({
  open,
  onClose,
  className,
  backdropClassName = "bg-black/50",
  testId,
  "data-tour-target": tourTarget,
  children,
}: AnimatedOverlayProps) {
  const reduced = useReducedMotion();
  const mouseDownOnBackdrop = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const savedOpenerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const restoreEpochRef = useRef(0);
  const [childrenReady, setChildrenReady] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Mount the shell first, then synchronously mount children after capturing
  // the opener. Native autoFocus runs during child DOM commit and child layout
  // effects run before a parent layout effect, so capturing after children
  // mount can otherwise record an element inside the dialog as its opener.
  // The layout update is flushed before paint, so users never see an empty
  // dialog.
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      savedOpenerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setChildrenReady(true);
    } else if (!open && wasOpenRef.current) {
      setChildrenReady(false);
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open || !childrenReady) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const initialTarget =
        contentRef.current?.querySelector<HTMLElement>(
          INITIAL_FOCUS_SELECTOR,
        ) ?? contentRef.current;
      initialTarget?.focus({ preventScroll: true });
    });
    return () => {
      cancelled = true;
    };
  }, [open, childrenReady]);

  useEffect(() => {
    if (!open) return;
    // React StrictMode replays an effect setup/cleanup pair immediately after
    // mount. Invalidate a pending cleanup restore whenever the live effect is
    // re-established so that replay never consumes the saved opener.
    restoreEpochRef.current += 1;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      const opener = savedOpenerRef.current;
      const restoreEpoch = ++restoreEpochRef.current;
      queueMicrotask(() => {
        if (restoreEpochRef.current !== restoreEpoch) return;
        savedOpenerRef.current = null;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      });
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  // Portal to document.body so the overlay escapes any ancestor stacking
  // context. A backdrop-filter surface can become the containing block for
  // fixed-positioned descendants — without the
  // portal, `fixed inset-0` would only cover that surface, letting other
  // panels paint over the modal.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          data-testid="animated-overlay-backdrop"
          data-animated-overlay-root="true"
          className={cn(
            "fixed inset-0 z-50 flex items-center justify-center",
            backdropClassName,
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : DURATIONS.normal }}
          onMouseDown={(e) => {
            mouseDownOnBackdrop.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && mouseDownOnBackdrop.current)
              onClose();
          }}
        >
          <motion.div
            ref={contentRef}
            tabIndex={-1}
            className={cn(className)}
            data-testid={testId}
            data-tour-target={tourTarget}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={reduced ? { duration: 0 } : { ...EASINGS.spring }}
            onClick={(e) => e.stopPropagation()}
          >
            {childrenReady ? children : null}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
