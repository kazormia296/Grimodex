import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

interface AnimatedDropdownProps {
  open: boolean;
  onClose: () => void;
  /** ref wrapping trigger + menu; used for click-outside detection */
  containerRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  children: React.ReactNode;
}

export function AnimatedDropdown({
  open,
  onClose,
  containerRef,
  className,
  children,
}: AnimatedDropdownProps) {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !containerRef) return;
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
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{
            duration: reduced ? 0 : DURATIONS.fast,
            ease: EASINGS.easeOut,
          }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
