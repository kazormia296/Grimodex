import { useRef, useState, useEffect, useLayoutEffect } from "react";
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
import {
  PanelHighlightOverlay,
  getPanelRect,
} from "@/features/layout/PanelHighlightOverlay";
import { PANEL_REGION_MAP } from "@/features/layout/panelRegions";
import { useLayoutStore } from "@/features/layout/layoutStore";
import type { PanelId } from "@/features/layout/layoutStore";
import { ChatDemoCard } from "./demos/ChatDemoCard";
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

// ---------------------------------------------------------------------------
// Focus blur overlay — blurs the whole screen except the highlighted region
// ---------------------------------------------------------------------------

function buildFocusClipPath(
  rect: { left: number; top: number; width: number; height: number },
  vw: number,
  vh: number,
): string {
  const { left, top, width, height } = rect;
  // evenodd: outer rect fills the screen; inner rect punches a transparent hole
  return (
    `path(evenodd, 'M 0 0 H ${vw} V ${vh} H 0 Z ` +
    `M ${left} ${top} H ${left + width} V ${top + height} H ${left} Z')`
  );
}

function TourFocusOverlay({
  panelId,
  stepKey,
}: {
  panelId: PanelId | null;
  stepKey: string;
}) {
  const [focusRect, setFocusRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [vw, setVw] = useState(0);
  const [vh, setVh] = useState(0);
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    // Defer opacity to trigger CSS transition after first paint
    requestAnimationFrame(() => setVisible(true));

    function measure() {
      setVw(window.innerWidth);
      setVh(window.innerHeight);

      if (stepKey === "layout") {
        const root = document.querySelector('[data-tour="panel-toggle-root"]');
        const menu = document.querySelector('[data-tour="panel-toggle-menu"]');
        if (root) {
          const rr = root.getBoundingClientRect();
          if (menu) {
            const mr = menu.getBoundingClientRect();
            setFocusRect({
              left: Math.min(rr.left, mr.left) - 4,
              top: rr.top - 4,
              width:
                Math.max(rr.right, mr.right) - Math.min(rr.left, mr.left) + 8,
              height: mr.bottom - rr.top + 8,
            });
          } else {
            setFocusRect({
              left: rr.left - 4,
              top: rr.top - 4,
              width: rr.width + 8,
              height: rr.height + 8,
            });
          }
        }
        return;
      }

      setFocusRect(panelId ? getPanelRect(panelId) : null);
    }

    measure();
    // Re-measure after the dropdown has opened (layout step only)
    const recheck =
      stepKey === "layout" ? window.setTimeout(measure, 160) : null;

    const observer = new ResizeObserver(measure);
    const container = document.querySelector(".dockview-theme-dark");
    if (container) observer.observe(container);
    window.addEventListener("resize", measure);

    return () => {
      if (recheck !== null) window.clearTimeout(recheck);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [panelId, stepKey]);

  const clipPath =
    focusRect && vw > 0 ? buildFocusClipPath(focusRect, vw, vh) : undefined;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        background: "oklch(0 0 0 / 0.15)",
        pointerEvents: "none",
        zIndex: 9998,
        clipPath,
        opacity: visible ? 1 : 0,
        transition: "opacity 0.35s ease, clip-path 0.2s ease",
      }}
    />,
    document.body,
  );
}

/** Compute where to anchor the floating tour card relative to the active panel. */
function computeCardStyle(
  panelId: PanelId | null,
  stepKey: string,
): React.CSSProperties {
  const W = window.innerWidth;
  const H = window.innerHeight;

  if (stepKey === "layout") {
    const el = document.querySelector('[data-tour="panel-toggle-root"]');
    const top = el ? el.getBoundingClientRect().bottom + 8 : 56;
    // Position just left of the dropdown menu (min-w-64 = 256px + 8px gap = right:264)
    return { position: "fixed", right: 264, top };
  }

  if (!panelId) {
    return {
      position: "fixed",
      bottom: 64,
      left: "50%",
      transform: "translateX(-50%)",
    };
  }

  const rect = getPanelRect(panelId);
  if (!rect) {
    return {
      position: "fixed",
      bottom: 64,
      left: "50%",
      transform: "translateX(-50%)",
    };
  }

  if (panelId === "editor") {
    // Center-bottom of the editor panel
    return {
      position: "fixed",
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - 192, W - 392)),
      bottom: H - (rect.top + rect.height) + 16,
    };
  }

  const region = PANEL_REGION_MAP[panelId as Exclude<PanelId, "editor">];

  if (region === "left") {
    if (panelId === "codex") {
      // Codex shares the left column with Scenes; the group rect may push the card
      // off screen. Use a safe center-bottom position instead.
      return {
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: 64,
      };
    }
    // Card to the right of the left panel
    return {
      position: "fixed",
      left: rect.left + rect.width + 12,
      top: Math.max(8, Math.min(rect.top + 8, H - 320)),
    };
  }

  if (region === "right") {
    // Card to the left of the right panel
    return {
      position: "fixed",
      right: W - rect.left + 12,
      top: Math.max(8, Math.min(rect.top + 8, H - 320)),
    };
  }

  // center-bottom (snippets)
  return {
    position: "fixed",
    left: Math.max(8, Math.min(rect.left + rect.width / 2 - 192, W - 392)),
    bottom: H - rect.top + 8,
  };
}

function useCardPlacement(
  panelId: PanelId | null,
  stepKey: string,
): React.CSSProperties {
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    bottom: 64,
    left: "50%",
    transform: "translateX(-50%)",
  });

  useLayoutEffect(() => {
    function compute() {
      setStyle(computeCardStyle(panelId, stepKey));
    }

    compute();

    const observer = new ResizeObserver(compute);
    const container = document.querySelector(".dockview-theme-dark");
    if (container) observer.observe(container);
    window.addEventListener("resize", compute);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, [panelId, stepKey]);

  return style;
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
  const { showPanel } = useLayoutStore();

  useEffect(() => {
    if (!open) setTourIndex(null);
  }, [open]);

  // Keyboard navigation in tour mode
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

  // Auto-show snippets panel when that step is active
  useEffect(() => {
    if (tourIndex !== null && STEPS[tourIndex].key === "snippets") {
      showPanel("snippets");
    }
  }, [tourIndex, showPanel]);

  // Pop animation on the tour card whenever the step changes
  useEffect(() => {
    if (tourIndex === null || isReducedMotion()) return;
    const timer = setTimeout(() => {
      const card = document.querySelector<HTMLElement>(
        '[data-testid="tour-card"]',
      );
      if (!card) return;
      gsap
        .timeline()
        .to(card, { scale: 1.03, duration: 0.12, ease: "power2.out" })
        .to(card, { scale: 1.0, duration: 0.3, ease: "elastic.out(1, 0.5)" });
    }, 180); // after framer-motion entrance finishes
    return () => clearTimeout(timer);
  }, [tourIndex]);

  // Layout step: open the PanelToggleDropdown and pulse-highlight it
  useEffect(() => {
    if (tourIndex === null || STEPS[tourIndex].key !== "layout") return;

    window.dispatchEvent(new CustomEvent("tour-open-panel-dropdown"));

    const ctx = gsap.context(() => {
      if (isReducedMotion()) return;
      gsap.fromTo(
        '[data-tour="panel-toggle-root"]',
        {
          boxShadow:
            "0 0 0 0px oklch(0.55 0.22 264 / 0), 0 0 0px oklch(0.55 0.22 264 / 0)",
        },
        {
          boxShadow:
            "0 0 0 2px oklch(0.55 0.22 264 / 0.9), 0 0 14px oklch(0.55 0.22 264 / 0.45)",
          duration: 0.8,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
        },
      );
    });

    return () => {
      ctx.revert();
      window.dispatchEvent(new CustomEvent("tour-close-panel-dropdown"));
    };
  }, [tourIndex]);

  // GSAP entrance animation for overview mode
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
  const currentStep = tourIndex !== null ? STEPS[tourIndex] : null;
  const cardPlacement = useCardPlacement(
    currentStep?.panelId ?? null,
    currentStep?.key ?? "",
  );

  return (
    <>
      {/* Tour mode: floating card + panel highlight + focus blur */}
      {open && tourIndex !== null && (
        <>
          <TourFocusOverlay
            panelId={currentStep?.panelId ?? null}
            stepKey={currentStep?.key ?? ""}
          />
          {currentStep?.panelId && (
            <PanelHighlightOverlay panelId={currentStep.panelId} />
          )}
          {createPortal(
            <AnimatePresence mode="wait">
              <motion.div
                key={tourIndex}
                data-testid="tour-card"
                style={cardPlacement}
                initial={reduced ? {} : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? {} : { opacity: 0, y: -8 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="z-[10000] w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-2xl"
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
