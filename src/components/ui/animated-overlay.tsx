import { useEffect, useRef } from "react";
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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const initialTarget =
        contentRef.current?.querySelector<HTMLElement>(
          INITIAL_FOCUS_SELECTOR,
        ) ?? contentRef.current;
      initialTarget?.focus({ preventScroll: true });
    });
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", handler);
    };
  }, [open, onClose]);

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
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
