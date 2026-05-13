import { useState, useMemo, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { X } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { AnimatedPopover } from "@/components/ui/animated-popover";
import { DURATIONS, EASINGS } from "@/lib/animation";
import { isReducedMotion } from "@/lib/gsap";
import type { AiPolicyToggles } from "@/features/ai-policy/types";
import type { PanelId } from "@/features/layout/layoutStore";
import { SpotlightOverlay } from "./spotlight";
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
  | "editor"
  | "snippets"
  | "codex"
  | "chat"
  | "codexExtract"
  | "aiWrite"
  | "foreshadow"
  | "consistency"
  | "timeline"
  | "end";

interface TourSlide {
  /** Slide id — used as i18n suffix (tour.steps.<step>.slides.<slide>) and motion key. */
  id: string;
}

interface TourStepDef {
  key: TourStepKey;
  panelId: PanelId | null;
  requires: keyof AiPolicyToggles | null;
  slides: TourSlide[];
  /** Index of the slide that requires the action gate. Defaults to last slide. */
  gatedSlideIndex?: number;
}

const ALL_STEPS: TourStepDef[] = [
  {
    key: "scenes",
    panelId: "scenes",
    requires: null,
    slides: [{ id: "overview" }, { id: "hierarchy" }, { id: "action" }],
  },
  {
    key: "editor",
    panelId: "editor",
    requires: null,
    slides: [{ id: "overview" }, { id: "beatNode" }, { id: "action" }],
  },
  {
    key: "snippets",
    panelId: "snippets",
    requires: null,
    slides: [{ id: "overview" }, { id: "action" }],
  },
  {
    key: "codex",
    panelId: "codex",
    requires: null,
    slides: [{ id: "overview" }, { id: "fourLayers" }, { id: "action" }],
  },
  {
    key: "chat",
    panelId: "chat",
    requires: "chat",
    slides: [{ id: "overview" }, { id: "mention" }, { id: "action" }],
  },
  {
    key: "codexExtract",
    panelId: "codex",
    requires: "chat",
    slides: [{ id: "overview" }, { id: "action" }],
  },
  {
    key: "aiWrite",
    panelId: "editor",
    requires: "bodyWrite",
    slides: [{ id: "overview" }, { id: "beatQuality" }, { id: "action" }],
  },
  {
    key: "foreshadow",
    panelId: "foreshadow",
    requires: null,
    slides: [{ id: "overview" }, { id: "payoffAnchored" }, { id: "action" }],
  },
  {
    key: "consistency",
    panelId: "editor",
    requires: "analysis",
    slides: [{ id: "overview" }, { id: "resultPlacement" }, { id: "action" }],
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
  isLastStep: boolean;
  isLastSlide: boolean;
  showActionHint: boolean;
  canAdvance: boolean;
  highlightNext: boolean;
  onNext: () => void;
  onSkip: () => void;
}

function TourCard({
  stepKey,
  slideId,
  stepIndex,
  totalSteps,
  isLastStep,
  isLastSlide,
  showActionHint,
  canAdvance,
  highlightNext,
  onNext,
  onSkip,
}: TourCardProps) {
  const { t } = useTranslation();
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

  return (
    <div
      style={{ zIndex: 50 }}
      className={[
        "fixed left-1/2 -translate-x-1/2 w-full max-w-xs px-4",
        isEnd ? "top-1/2 -translate-y-1/2" : "bottom-6",
      ].join(" ")}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 12 }}
        transition={{ duration: DURATIONS.normal, ease: EASINGS.easeOut }}
        className="rounded-2xl border border-border bg-card/95 p-5 shadow-2xl backdrop-blur-sm"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {stepIndex + 1} / {totalSteps}
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

        <p className="mb-1 text-sm font-semibold text-foreground">
          {t(titleKey)}
        </p>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          {t(bodyKey)}
        </p>

        {showActionHint && (
          <p className="mb-3 text-center text-[10px] italic text-muted-foreground/60">
            {t("tour.actionRequired")}
          </p>
        )}

        <button
          ref={nextBtnRef}
          type="button"
          onClick={onNext}
          disabled={!canAdvance}
          className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-30"
        >
          {isDoneAtEnd ? t("tour.done") : t("tour.next")}
        </button>
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
  const defaultAiPolicy = useWorkspaceStore(
    (s) => s.globalSettings?.defaultAiPolicy,
  );

  // Parse AI policy toggles
  const toggles = useMemo<AiPolicyToggles>(() => {
    if (!defaultAiPolicy)
      return { chat: true, bodyWrite: true, analysis: true };
    try {
      const p = JSON.parse(defaultAiPolicy) as {
        toggles: AiPolicyToggles;
      };
      return p.toggles;
    } catch {
      return { chat: true, bodyWrite: true, analysis: true };
    }
  }, [defaultAiPolicy]);

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
  const isGatedSlide = slideIndex === gatedSlideIndex;
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
  const editorDone = useEditorWriteGate();
  const snippetDone = useSnippetUsedGate();
  const codexViewDone = useCodexViewGate();
  const chatDone = useChatSentGate();
  const codexExtractDone = useCodexExtractGate();
  const aiWriteDone = useEditorWriteGate(50);
  const foreshadowDwellDone = usePanelDwellGate("foreshadow", 3000);
  const postEffectDone = usePostEffectRunGate();
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
      case "editor":
        return editorDone;
      case "snippets":
        return snippetDone;
      case "codex":
        return codexViewDone;
      case "chat":
        return chatDone;
      case "codexExtract":
        return codexExtractDone;
      case "aiWrite":
        return aiWriteDone;
      case "foreshadow":
        return foreshadowDwellDone;
      case "consistency":
        return postEffectDone;
      case "timeline":
        return timelineDwellDone;
      case "end":
        return true;
    }
  }

  const gateDone = isStepDone(currentStep.key);
  const canAdvance = !isGatedSlide || gateDone;
  const showActionHint = isGatedSlide && !gateDone && currentStep.key !== "end";
  const highlightNext = isGatedSlide && gateDone && currentStep.key !== "end";

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
      <SpotlightOverlay panelId={currentStep.panelId} />
      <AnimatePresence mode="wait">
        <TourCard
          key={`${currentStep.key}:${currentSlide.id}`}
          stepKey={currentStep.key}
          slideId={currentSlide.id}
          stepIndex={stepIndex}
          totalSteps={steps.length}
          isLastStep={isLastStep}
          isLastSlide={isLastSlide}
          showActionHint={showActionHint}
          canAdvance={canAdvance}
          highlightNext={highlightNext}
          onNext={() => void handleNext()}
          onSkip={() => void completeTour()}
        />
      </AnimatePresence>
    </>
  );
}
