import { useState, useMemo, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { X } from "lucide-react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useTreeStore } from "@/features/tree/treeStore";
import { useChatStore } from "@/features/chat/chatStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { DURATIONS, EASINGS } from "@/lib/animation";
import { isReducedMotion } from "@/lib/gsap";
import type { AiPolicyToggles } from "@/features/ai-policy/types";
import type { PanelId } from "@/features/layout/layoutStore";
import { SpotlightOverlay } from "./spotlight";
import {
  useEditorWriteGate,
  useChatSentGate,
  useCodexExtractGate,
  usePostEffectRunGate,
} from "./tourGates";

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

type TourStepKey =
  | "editor"
  | "codex"
  | "chat"
  | "codexExtract"
  | "aiWrite"
  | "consistency"
  | "end";

interface TourStepDef {
  key: TourStepKey;
  panelId: PanelId | null;
  requires: keyof AiPolicyToggles | null;
}

const ALL_STEPS: TourStepDef[] = [
  { key: "editor", panelId: "editor", requires: null },
  { key: "codex", panelId: "codex", requires: null },
  { key: "chat", panelId: "chat", requires: "chat" },
  { key: "codexExtract", panelId: "codex", requires: "chat" },
  { key: "aiWrite", panelId: "editor", requires: "bodyWrite" },
  { key: "consistency", panelId: "editor", requires: "analysis" },
  { key: "end", panelId: null, requires: null },
];

// ---------------------------------------------------------------------------
// Step key → i18n number helper
// ---------------------------------------------------------------------------
function stepNum(key: TourStepKey): string {
  const map: Record<TourStepKey, string> = {
    editor: "step1",
    codex: "step2",
    chat: "step3",
    codexExtract: "step4",
    aiWrite: "step5",
    consistency: "step6",
    end: "step7",
  };
  return map[key];
}

// ---------------------------------------------------------------------------
// Tour card
// ---------------------------------------------------------------------------

interface TourCardProps {
  stepKey: TourStepKey;
  stepIndex: number;
  totalSteps: number;
  isDone: boolean;
  onNext: () => void;
  onSkip: () => void;
}

function TourCard({
  stepKey,
  stepIndex,
  totalSteps,
  isDone,
  onNext,
  onSkip,
}: TourCardProps) {
  const { t } = useTranslation();
  const nextBtnRef = useRef<HTMLButtonElement>(null);
  const prevDone = useRef(isDone);

  useGSAP(() => {
    if (isDone && !prevDone.current && nextBtnRef.current) {
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
    prevDone.current = isDone;
  }, [isDone]);

  const isEnd = stepKey === "end";
  const sn = stepNum(stepKey);

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
          <button
            type="button"
            onClick={onSkip}
            className="rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("tour.skip")}
          >
            <X size={14} />
          </button>
        </div>

        <p className="mb-1 text-sm font-semibold text-foreground">
          {t(`tour.${sn}.title`)}
        </p>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          {t(`tour.${sn}.desc`)}
        </p>

        {!isDone && !isEnd && (
          <p className="mb-3 text-center text-[10px] italic text-muted-foreground/60">
            {t("tour.actionRequired")}
          </p>
        )}

        <button
          ref={nextBtnRef}
          type="button"
          onClick={onNext}
          disabled={!isDone}
          className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-30"
        >
          {isEnd ? t("tour.done") : t("tour.next")}
        </button>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main SampleTour
// ---------------------------------------------------------------------------

export function SampleTour() {
  const showSampleTour = useWorkspaceStore((s) => s.showSampleTour);
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
  const currentStep = steps[stepIndex] ?? steps[steps.length - 1];

  // Capture baselines at mount (delayed for tree load)
  const [editorBaseline, setEditorBaseline] = useState<number | null>(null);
  const [chatBaseline] = useState(
    () =>
      useChatStore.getState().messages.filter((m) => m.role === "user").length,
  );
  const [codexBaseline] = useState(
    () => useCodexStore.getState().entries.length,
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      const state = useTreeStore.getState();
      const count = state.charCounts[state.activeSceneId] ?? 0;
      setEditorBaseline(count);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  // Gates — all called unconditionally (Rules of Hooks)
  const editorDone = useEditorWriteGate(editorBaseline);
  const chatDone = useChatSentGate(chatBaseline);
  const codexExtractDone = useCodexExtractGate(codexBaseline);
  const aiWriteDone = useEditorWriteGate(
    editorBaseline !== null ? editorBaseline + 50 : null,
  );
  const postEffectDone = usePostEffectRunGate();

  function isDone(key: TourStepKey): boolean {
    switch (key) {
      case "editor":
        return editorDone;
      case "codex":
        return true; // codex is always viewable; let user proceed at will
      case "chat":
        return chatDone;
      case "codexExtract":
        return codexExtractDone;
      case "aiWrite":
        return aiWriteDone;
      case "consistency":
        return postEffectDone;
      case "end":
        return true;
    }
  }

  async function handleNext() {
    if (stepIndex < steps.length - 1) {
      setStepIndex((i) => i + 1);
    } else {
      await completeTour();
    }
  }

  async function completeTour() {
    setShowSampleTour(false);
    await updateGlobalSettings({ hasSeenWelcome: true });
  }

  if (!showSampleTour) return null;

  return (
    <>
      <SpotlightOverlay panelId={currentStep.panelId} />
      <AnimatePresence mode="wait">
        <TourCard
          key={currentStep.key}
          stepKey={currentStep.key}
          stepIndex={stepIndex}
          totalSteps={steps.length}
          isDone={isDone(currentStep.key)}
          onNext={() => void handleNext()}
          onSkip={() => void completeTour()}
        />
      </AnimatePresence>
    </>
  );
}
