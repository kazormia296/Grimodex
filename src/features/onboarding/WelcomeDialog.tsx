import { useRef } from "react";
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
} from "lucide-react";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { isReducedMotion } from "@/lib/gsap";

const STEPS = [
  { key: "scenes", Icon: Layers },
  { key: "chat", Icon: MessageSquare },
  { key: "codex", Icon: BookOpen },
  { key: "snippets", Icon: Scissors },
  { key: "editor", Icon: PenLine },
  { key: "layout", Icon: Layout },
] as const;

interface WelcomeDialogProps {
  open: boolean;
  onClose: () => void;
}

export function WelcomeDialog({ open, onClose }: WelcomeDialogProps) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (!open || isReducedMotion()) return;

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
  }, [open]);

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="w-full max-w-lg rounded-xl border border-border bg-background p-8 shadow-xl"
      testId="welcome-dialog"
    >
      <h2 ref={titleRef} className="mb-2 text-2xl font-bold text-foreground">
        {t("onboarding.title")}
      </h2>
      <p
        ref={subtitleRef}
        className="mb-6 text-sm text-muted-foreground leading-relaxed"
      >
        {t("onboarding.subtitle")}
      </p>

      <div ref={stepsRef} className="mb-8 grid grid-cols-2 gap-3">
        {STEPS.map(({ key, Icon }) => (
          <div
            key={key}
            data-testid={`tour-step-${key}`}
            className="rounded-lg border border-border bg-muted/40 p-4"
          >
            <Icon className="mb-2 h-5 w-5 text-primary" />
            <p className="mb-1 text-sm font-semibold text-foreground">
              {t(`onboarding.steps.${key}.title`)}
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(`onboarding.steps.${key}.desc`)}
            </p>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
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
  );
}
