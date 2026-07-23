import { AnimatePresence, motion } from "motion/react";
import { Palette, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  CSS_DURATIONS,
  CSS_EASINGS,
  DURATIONS,
  EASINGS,
  VARIANTS,
  useReducedMotion,
} from "@/lib/animation";
import { BackgroundCommonControls } from "./BackgroundCommonControls";
import { BackgroundFilterControls } from "./BackgroundFilterControls";
import { BackgroundGlassControls } from "./BackgroundGlassControls";
import { BackgroundShaderControls } from "./BackgroundShaderControls";

interface BackgroundStudioProps {
  open: boolean;
  onClose: () => void;
  zenMode?: boolean;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <details open className="border-b border-border/60 py-2 last:border-b-0">
      <summary className="cursor-pointer select-none px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </summary>
      <div className="pt-1">{children}</div>
    </details>
  );
}

export function BackgroundStudio({
  open,
  onClose,
  zenMode = false,
}: BackgroundStudioProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          role="dialog"
          aria-modal="false"
          aria-label={t("editor.background.title")}
          data-background-studio
          className={`fixed right-3 z-[90] flex max-h-[calc(100vh-1.5rem)] w-[min(360px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-border/70 bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur-xl ${zenMode ? "top-3" : "top-12"}`}
          initial={reduced ? false : VARIANTS.popover.initial}
          animate={VARIANTS.popover.animate}
          exit={reduced ? VARIANTS.fadeIn.exit : VARIANTS.popover.exit}
          transition={{
            duration: reduced ? 0 : DURATIONS.normal,
            ease: EASINGS.easeOut,
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
        >
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3">
            <Palette className="h-4 w-4 text-primary" aria-hidden />
            <h2 className="flex-1 text-sm font-semibold">
              {t("editor.background.title")}
            </h2>
            <button
              type="button"
              aria-label={t("editor.background.close")}
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              style={{
                transition: reduced
                  ? "none"
                  : `color ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}, background-color ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}`,
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <Section title={t("editor.background.commonSection")}>
              <BackgroundCommonControls />
            </Section>
            <Section title={t("editor.background.glassSection")}>
              <BackgroundGlassControls />
            </Section>
            <Section title={t("editor.background.propsSection")}>
              <BackgroundShaderControls />
            </Section>
            <Section title={t("editor.background.filtersSection")}>
              <BackgroundFilterControls />
            </Section>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
