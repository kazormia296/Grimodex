import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import {
  Layers,
  MessageSquare,
  BookOpen,
  Scissors,
  PenLine,
  Layout,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { isReducedMotion } from "@/lib/gsap";
import { PanelHighlightOverlay } from "@/features/layout/PanelHighlightOverlay";
import type { PanelId } from "@/features/layout/layoutStore";
import { ChatDemoCard } from "./demos/ChatDemoCard";
import { LayoutDemoCard } from "./demos/LayoutDemoCard";
import {
  ScenesDemoCard,
  CodexDemoCard,
  SnippetsDemoCard,
  EditorDemoCard,
} from "./demos/StaticDemoCards";

type Step = {
  key: string;
  Icon: React.ElementType;
  panelId: PanelId | null;
};

const STEPS: Step[] = [
  { key: "scenes", Icon: Layers, panelId: "scenes" },
  { key: "chat", Icon: MessageSquare, panelId: "chat" },
  { key: "codex", Icon: BookOpen, panelId: "codex" },
  { key: "snippets", Icon: Scissors, panelId: "snippets" },
  { key: "editor", Icon: PenLine, panelId: "editor" },
  { key: "layout", Icon: Layout, panelId: null },
];

function getCardPositionClass(key: string): string {
  if (key === "chat") return "fixed bottom-16 left-6 z-[10000] w-full max-w-sm";
  if (key === "snippets")
    return "fixed top-20 left-1/2 z-[10000] w-full max-w-sm -translate-x-1/2";
  return "fixed bottom-16 left-1/2 z-[10000] w-full max-w-sm -translate-x-1/2";
}

function TourDemo({ stepKey }: { stepKey: string }) {
  switch (stepKey) {
    case "scenes":
      return <ScenesDemoCard />;
    case "chat":
      return <ChatDemoCard />;
    case "codex":
      return <CodexDemoCard />;
    case "snippets":
      return <SnippetsDemoCard />;
    case "editor":
      return <EditorDemoCard />;
    case "layout":
      return <LayoutDemoCard />;
    default:
      return null;
  }
}

interface WelcomeDialogProps {
  open: boolean;
  onClose: () => void;
}

export function WelcomeDialog({ open, onClose }: WelcomeDialogProps) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const [tourIndex, setTourIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!open) setTourIndex(null);
  }, [open]);

  useEffect(() => {
    if (tourIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" || e.key === "ArrowDown")
        setTourIndex((i) => (i !== null && i < STEPS.length - 1 ? i + 1 : i));
      if (e.key === "ArrowLeft" || e.key === "ArrowUp")
        setTourIndex((i) => (i !== null && i > 0 ? i - 1 : i));
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [tourIndex, onClose]);

  useGSAP(() => {
    if (!open || isReducedMotion() || tourIndex !== null) return;

    const stepEls = stepsRef.current
      ? (Array.from(stepsRef.current.children) as HTMLElement[])
      : [];

    gsap
      .timeline()
      .from(titleRef.current, {
        y: -16,
        opacity: 0,
        duration: 0.45,
        ease: "power2.out",
      })
      .from(
        subtitleRef.current,
        { y: -8, opacity: 0, duration: 0.35, ease: "power2.out" },
        "<0.2",
      )
      .from(
        stepEls,
        {
          y: 16,
          opacity: 0,
          duration: 0.35,
          stagger: 0.08,
          ease: "power2.out",
        },
        "<0.1",
      );
  }, [open, tourIndex]);

  const reduced = isReducedMotion();

  return (
    <>
      {/* Tour mode: floating card + panel highlight */}
      {open && tourIndex !== null && (
        <>
          <PanelHighlightOverlay panelId={STEPS[tourIndex].panelId} />
          {createPortal(
            <AnimatePresence mode="wait">
              <motion.div
                key={tourIndex}
                data-testid="tour-card"
                initial={reduced ? {} : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? {} : { opacity: 0, y: -8 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className={`${getCardPositionClass(STEPS[tourIndex].key)} rounded-xl border border-border bg-background p-5 shadow-2xl`}
              >
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t("common.close")}
                  className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>

                {(() => {
                  const { key, Icon } = STEPS[tourIndex];
                  return (
                    <>
                      <div className="mb-3 flex items-start gap-3 pr-6">
                        <div className="mt-0.5 shrink-0 rounded-lg bg-primary/10 p-2">
                          <Icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <p className="mb-1 text-sm font-semibold text-foreground">
                            {t(`onboarding.steps.${key}.title`)}
                          </p>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {t(`onboarding.steps.${key}.desc`)}
                          </p>
                        </div>
                      </div>
                      <TourDemo stepKey={key} />
                    </>
                  );
                })()}

                {/* Step dots */}
                <div className="mb-4 mt-4 flex justify-center gap-1.5">
                  {STEPS.map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setTourIndex(i)}
                      aria-label={`${i + 1} / ${STEPS.length}`}
                      className={`h-1.5 rounded-full transition-all ${
                        i === tourIndex
                          ? "w-4 bg-primary"
                          : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50"
                      }`}
                    />
                  ))}
                </div>

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    data-testid="tour-back"
                    onClick={() => setTourIndex(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("onboarding.backToOverview")}
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid="tour-prev"
                      onClick={() =>
                        setTourIndex((i) => Math.max(0, (i ?? 0) - 1))
                      }
                      disabled={tourIndex === 0}
                      className="rounded p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    {tourIndex < STEPS.length - 1 ? (
                      <button
                        type="button"
                        data-testid="tour-next"
                        onClick={() => setTourIndex((i) => (i ?? 0) + 1)}
                        className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        {t("onboarding.next")}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="welcome-get-started"
                        onClick={onClose}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        {t("onboarding.getStarted")}
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            </AnimatePresence>,
            document.body,
          )}
        </>
      )}

      {/* Overview mode */}
      <AnimatedOverlay
        open={open && tourIndex === null}
        onClose={onClose}
        className="w-full max-w-lg rounded-xl border border-border bg-background p-8 shadow-xl"
        testId="welcome-dialog"
      >
        <h2 ref={titleRef} className="mb-2 text-2xl font-bold text-foreground">
          {t("onboarding.title")}
        </h2>
        <p
          ref={subtitleRef}
          className="mb-6 text-sm leading-relaxed text-muted-foreground"
        >
          {t("onboarding.subtitle")}
        </p>

        <div ref={stepsRef} className="mb-8 grid grid-cols-2 gap-3">
          {STEPS.map(({ key, Icon }, i) => (
            <button
              key={key}
              type="button"
              data-testid={`tour-step-${key}`}
              onClick={() => setTourIndex(i)}
              className="rounded-lg border border-border bg-muted/40 p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/60"
            >
              <Icon className="mb-2 h-5 w-5 text-primary" />
              <p className="mb-1 text-sm font-semibold text-foreground">
                {t(`onboarding.steps.${key}.title`)}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(`onboarding.steps.${key}.desc`)}
              </p>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <button
            type="button"
            data-testid="tour-start"
            onClick={() => setTourIndex(0)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t("onboarding.startTour")}
          </button>
          <button
            type="button"
            data-testid="welcome-get-started"
            onClick={onClose}
            className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("onboarding.getStarted")}
          </button>
        </div>
      </AnimatedOverlay>
    </>
  );
}
