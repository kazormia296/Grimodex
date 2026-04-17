import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

interface AnimatedOverlayProps {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}

export function AnimatedOverlay({
  open,
  onClose,
  className,
  children,
}: AnimatedOverlayProps) {
  const reduced = useReducedMotion();
  const mouseDownOnBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
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
            className={cn(className)}
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
    </AnimatePresence>
  );
}
