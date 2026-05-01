import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

interface AnimatedPopoverProps {
  open: boolean;
  onClose?: () => void;
  /** ref wrapping trigger + popover; used for click-outside detection */
  containerRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function AnimatedPopover({
  open,
  onClose,
  containerRef,
  className,
  style,
  children,
}: AnimatedPopoverProps) {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!open || !onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !onClose || !containerRef) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose, containerRef]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn(className)}
          style={style}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={
            reduced
              ? { duration: 0 }
              : { ...EASINGS.spring, duration: DURATIONS.normal }
          }
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
