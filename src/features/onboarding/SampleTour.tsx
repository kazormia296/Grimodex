import { useState, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { X } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { AnimatedPopover } from "@/components/ui/animated-popover";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { isReducedMotion } from "@/lib/gsap";
import type { AiPolicyToggles } from "@/features/ai-policy/types";
import { parseAiPolicy } from "@/features/ai-policy/parse";
import type { PanelId } from "@/features/layout/layoutStore";
import { SpotlightOverlay, useFocusRects, type FocusRect } from "./spotlight";
import { computeCardStyle, CARD_WIDTH } from "./cardPlacement";
import {
  useSceneOpenGate,
  useEditorWriteGate,
  useChatSentGate,
  useCodexExtractGate,
  useCodexViewGate,
  useSnippetUsedGate,
  usePanelDwellGate,
  usePostEffectRunGate,
} from "./tourGates";

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

type TourStepKey =
  | "scenes"
  | "layout"
  | "editor"
  | "snippets"
  | "codex"
  | "chat"
  | "codexExtract"
  | "foreshadow"
  | "consistency"
  | "timeline"
  | "end";

interface TourSlide {
  /** Slide id — used as i18n suffix (tour.steps.<step>.slides.<slide>) and motion key. */
  id: string;
  /**
   * data-tour-target values to spotlight for this slide.
   * Overrides panelId highlight when at least one element is found in the DOM.
   * Falls back to panelId panel when nothing matches.
   */
  targets?: string[];
}

interface TourStepDef {
  key: TourStepKey;
  panelId: PanelId | null;
  requires: keyof AiPolicyToggles | null;
  slides: TourSlide[];
  /** Index of the slide that requires the action gate. Defaults to last slide. */
  gatedSlideIndex?: number;
  /** No gate required — all slides advance freely. */
  passive?: boolean;
}

const ALL_STEPS: TourStepDef[] = [
  {
    key: "scenes",
    panelId: "scenes",
    requires: null,
    slides: [
      { id: "overview" },
      { id: "addItems" },
      { id: "hierarchy" },
      { id: "action" },
    ],
  },
  {
    key: "layout",
    panelId: null,
    requires: null,
    passive: true,
    slides: [
      {
        id: "overview",
        targets: ["layout-preset-btn", "panel-toggle-btn"],
      },
    ],
  },
  {
    key: "editor",
    panelId: "editor",
    requires: null,
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "snippets",
    panelId: "snippets",
    requires: null,
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "codex",
    panelId: "codex",
    requires: null,
    gatedSlideIndex: 1,
    slides: [{ id: "overview" }, { id: "action" }, { id: "fourLayers" }],
  },
  {
    key: "chat",
    panelId: "chat",
    requires: "chat",
    passive: true,
    slides: [
      { id: "overview" },
      { id: "contextBar", targets: ["chat-context-bar"] },
      {
        id: "contextUsage",
        targets: ["chat-tokens-badge", "chat-context-progress"],
      },
    ],
  },
  {
    key: "codexExtract",
    panelId: "chat",
    requires: "chat",
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "foreshadow",
    panelId: "foreshadow",
    requires: null,
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "consistency",
    panelId: "kouetsu",
    requires: "analysis",
    passive: true,
    slides: [{ id: "overview" }],
  },
  {
    key: "timeline",
    panelId: "timeline",
    requires: null,
    slides: [{ id: "overview" }, { id: "zoom" }],
  },
  {
    key: "end",
    panelId: null,
    requires: null,
    slides: [{ id: "summary" }, { id: "restartHint" }],
  },
];

// ---------------------------------------------------------------------------
// Tour card
// ---------------------------------------------------------------------------

interface TourCardProps {
  stepKey: TourStepKey;
  slideId: string;
  stepIndex: number;
  totalSteps: number;
  slideIndex: number;
  slideCount: number;
  isLastStep: boolean;
  isLastSlide: boolean;
  showActionHint: boolean;
  canAdvance: boolean;
  highlightNext: boolean;
  focusRects: FocusRect[];
  viewport: { vw: number; vh: number };
  onNext: () => void;
  onSkip: () => void;
  onCreateWorkspace: () => void;
}

function TourCard({
  stepKey,
  slideId,
  stepIndex,
  totalSteps,
  slideIndex,
  slideCount,
  isLastStep,
  isLastSlide,
  showActionHint,
  canAdvance,
  highlightNext,
  focusRects,
  viewport,
  onNext,
  onSkip,
  onCreateWorkspace,
}: TourCardProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const nextBtnRef = useRef<HTMLButtonElement>(null);
  const prevHighlight = useRef(highlightNext);
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false);
  const skipContainerRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (highlightNext && !prevHighlight.current && nextBtnRef.current) {
      if (isReducedMotion()) {
        gsap.set(nextBtnRef.current, { scale: 1 });
      } else {
        gsap.fromTo(
          nextBtnRef.current,
          { scale: 1 },
          {
            scale: 1.06,
            duration: DURATIONS.fast,
            ease: "elastic.out(1.2,0.5)",
            yoyo: true,
            repeat: 1,
          },
        );
      }
    }
    prevHighlight.current = highlightNext;
  }, [highlightNext]);

  const isEnd = stepKey === "end";
  const titleKey = `tour.steps.${stepKey}.slides.${slideId}.title`;
  const bodyKey = `tour.steps.${stepKey}.slides.${slideId}.body`;
  const isDoneAtEnd = isLastStep && isLastSlide;

  const positionStyle = computeCardStyle(
    focusRects,
    viewport.vw,
    viewport.vh,
    isEnd,
  );

  return (
    <div
      style={{
        ...positionStyle,
        position: "fixed",
        zIndex: 50,
        width: CARD_WIDTH,
      }}
      className="px-2"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 12 }}
        transition={{
          duration: reduced ? 0 : DURATIONS.normal,
          ease: EASINGS.easeOut,
        }}
        className="rounded-2xl border border-border bg-card/95 p-5 shadow-2xl backdrop-blur-sm"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground tabular-nums">
            {stepIndex + 1}
            {slideCount > 1 ? `.${slideIndex + 1}` : ""} / {totalSteps}
          </span>
          <div ref={skipContainerRef} className="relative">
            <button
              type="button"
              onClick={() => setSkipConfirmOpen((v) => !v)}
              className="rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t("tour.skip")}
            >
              <X size={14} />
            </button>
            <AnimatedPopover
              open={skipConfirmOpen}
              onClose={() => setSkipConfirmOpen(false)}
              containerRef={skipContainerRef}
              className="absolute right-0 top-full z-50 mt-2 w-64 origin-top-right rounded-lg border border-border bg-popover p-3 shadow-lg"
            >
              <p className="mb-1 text-xs font-semibold text-foreground">
                {t("tour.skipConfirmTitle")}
              </p>
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                {t("tour.skipConfirmDesc")}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSkipConfirmOpen(false)}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t("tour.cancel")}
                </button>
                <button
                  type="button"
                  onClick={onSkip}
                  className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                >
                  {t("tour.skip")}
                </button>
              </div>
            </AnimatedPopover>
          </div>
        </div>

        <p className="mb-2 text-base font-semibold text-foreground">
          {t(titleKey)}
        </p>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          {t(bodyKey)}
        </p>

        {showActionHint && (
          <p className="mb-3 text-center text-xs italic text-muted-foreground/70">
            {t("tour.actionRequired")}
          </p>
        )}

        <button
          ref={nextBtnRef}
          type="button"
          onClick={onNext}
          disabled={!canAdvance}
          className="w-full rounded-lg bg-primary py-2.5 text-base font-medium text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-30"
        >
          {isDoneAtEnd ? t("tour.done") : t("tour.next")}
        </button>

        {isDoneAtEnd && (
          <button
            type="button"
            onClick={onCreateWorkspace}
            className="mt-2 w-full rounded-lg border border-border py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("tour.createWorkspace")}
          </button>
        )}
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main SampleTour
// ---------------------------------------------------------------------------

/**
 * Renders the active sample tour. Caller (App.tsx) controls visibility via
 * `showSampleTour` from the workspace store — this component should be
 * mounted conditionally so all useState/useRef/gate state resets between runs.
 */
export function SampleTour() {
  const setShowSampleTour = useWorkspaceStore((s) => s.setShowSampleTour);
  const updateGlobalSettings = useWorkspaceStore((s) => s.updateGlobalSettings);
  const showLauncher = useWorkspaceStore((s) => s.showLauncher);
  const defaultAiPolicy = useWorkspaceStore(
    (s) => s.globalSettings?.defaultAiPolicy,
  );

  // Parse AI policy toggles. parseAiPolicy が欠損/破損を DEFAULT(full) に倒し、
  // 旧 JSON の structureWrite 欠損も stored preset から導出する。
  const toggles = useMemo<AiPolicyToggles>(
    () => parseAiPolicy(defaultAiPolicy ?? null).toggles,
    [defaultAiPolicy],
  );

  // Build filtered step list
  const steps = useMemo(
    () => ALL_STEPS.filter((s) => !s.requires || toggles[s.requires]),
    [toggles],
  );

  const [stepIndex, setStepIndex] = useState(0);
  const [slideIndex, setSlideIndex] = useState(0);
  const currentStep = steps[stepIndex] ?? steps[steps.length - 1];
  const currentSlide =
    currentStep.slides[slideIndex] ??
    currentStep.slides[currentStep.slides.length - 1];
  const gatedSlideIndex =
    currentStep.gatedSlideIndex ?? currentStep.slides.length - 1;
  const isGatedSlide = !currentStep.passive && slideIndex === gatedSlideIndex;
  const isLastSlide = slideIndex === currentStep.slides.length - 1;
  const isLastStep = stepIndex === steps.length - 1;

  // Reset slide index when entering a new step.
  useEffect(() => {
    setSlideIndex(0);
  }, [stepIndex]);

  // Open the target panel whenever the step changes.
  useEffect(() => {
    if (currentStep.panelId) {
      useLayoutStore.getState().showPanel(currentStep.panelId);
    }
  }, [currentStep.panelId]);

  // Gates — all called unconditionally (Rules of Hooks).
  // Each gate self-manages its baseline via "settle-then-track":
  // it captures the baseline on the first settled store observation,
  // then detects increases from that point.
  const sceneOpenDone = useSceneOpenGate();
  useEditorWriteGate(); // editor step is passive; kept for Rules of Hooks
  useSnippetUsedGate(); // snippets step is passive; kept for Rules of Hooks
  const codexViewDone = useCodexViewGate();
  useChatSentGate(); // chat step is passive; kept for Rules of Hooks
  useCodexExtractGate(); // codexExtract step is passive; kept for Rules of Hooks
  // Hooks below are kept for Rules of Hooks compliance; their steps are passive.
  useEditorWriteGate(50);
  usePanelDwellGate("foreshadow", 3000);
  usePostEffectRunGate();
  const timelineDwellDone = usePanelDwellGate("timeline", 3000);

  // Auto-advance from the scenes step once the user opens a scene —
  // the action is unambiguous and self-completing, so waiting for a
  // manual "Next" click would feel pedantic. Only fires when the user
  // has already reached the gated (action) slide.
  useEffect(() => {
    if (currentStep.key !== "scenes" || !sceneOpenDone) return;
    if (!isGatedSlide) return;
    const timer = setTimeout(() => {
      setStepIndex((i) => Math.min(i + 1, steps.length - 1));
    }, 500);
    return () => clearTimeout(timer);
  }, [currentStep.key, sceneOpenDone, isGatedSlide, steps.length]);

  function isStepDone(key: TourStepKey): boolean {
    switch (key) {
      case "scenes":
        return sceneOpenDone;
      case "codex":
        return codexViewDone;
      case "timeline":
        return timelineDwellDone;
      // passive steps — gate never blocks (isGatedSlide is always false)
      case "layout":
      case "editor":
      case "snippets":
      case "chat":
      case "codexExtract":
      case "foreshadow":
      case "consistency":
      case "end":
        return true;
    }
  }

  const gateDone = isStepDone(currentStep.key);
  const canAdvance = !isGatedSlide || gateDone;
  const showActionHint = isGatedSlide && !gateDone && currentStep.key !== "end";
  const highlightNext = isGatedSlide && gateDone && currentStep.key !== "end";

  const {
    rects: focusRects,
    vw,
    vh,
  } = useFocusRects(currentStep.panelId, currentSlide.targets);

  async function handleNext() {
    if (!canAdvance) return;
    if (!isLastSlide) {
      setSlideIndex((i) => i + 1);
      return;
    }
    if (!isLastStep) {
      setStepIndex((i) => i + 1);
      return;
    }
    await completeTour();
  }

  async function completeTour() {
    setShowSampleTour(false);
    await updateGlobalSettings({ hasSeenWelcome: true });
  }

  return (
    <>
      <SpotlightOverlay
        panelId={currentStep.panelId}
        targets={currentSlide.targets}
      />
      {/* `.app-shell` is an isolated stacking context. Portal the card beside
          the body-level spotlight so its z-index can stay above the blur. */}
      {createPortal(
        <AnimatePresence mode="wait">
          <TourCard
            key={`${currentStep.key}:${currentSlide.id}`}
            stepKey={currentStep.key}
            slideId={currentSlide.id}
            stepIndex={stepIndex}
            totalSteps={steps.length}
            slideIndex={slideIndex}
            slideCount={currentStep.slides.length}
            isLastStep={isLastStep}
            isLastSlide={isLastSlide}
            showActionHint={showActionHint}
            canAdvance={canAdvance}
            highlightNext={highlightNext}
            focusRects={focusRects}
            viewport={{ vw, vh }}
            onNext={() => void handleNext()}
            onSkip={() => void completeTour()}
            onCreateWorkspace={() => {
              void completeTour();
              showLauncher();
            }}
          />
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
