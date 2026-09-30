import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

const ACTIONS = [
  {
    id: "apply",
    key: "apply",
    effect: "resolve",
    primary: true,
    quiet: false,
  },
  {
    id: "edit-apply",
    key: "editApply",
    effect: "resolve",
    primary: false,
    quiet: false,
  },
  {
    id: "reject",
    key: "reject",
    effect: "resolve",
    primary: false,
    quiet: false,
  },
  {
    id: "hold",
    key: "hold",
    effect: "dispose",
    disposition: "held",
    primary: false,
    quiet: false,
  },
  {
    id: "ignore-basis",
    key: "ignoreBasis",
    effect: "dispose",
    disposition: "basis-ignored",
    primary: false,
    quiet: true,
  },
  {
    id: "correction-rule",
    key: "correctionRule",
    effect: "edit-correction-rule",
    primary: false,
    quiet: true,
  },
] as const;

export type ChangeReviewAction =
  | {
      readonly effect: "resolve";
      readonly decision: "apply" | "edit-apply" | "reject";
      readonly label: string;
    }
  | {
      readonly effect: "dispose";
      readonly disposition: "held" | "basis-ignored";
      readonly label: string;
    }
  | {
      readonly effect: "edit-correction-rule";
      readonly label: string;
    };

interface ChangeReviewActionsProps {
  readonly onAction: (action: ChangeReviewAction) => void;
  readonly correctionRuleTriggerRef: RefObject<HTMLButtonElement | null>;
}

export function ChangeReviewActions({
  onAction,
  correctionRuleTriggerRef,
}: ChangeReviewActionsProps) {
  const { t } = useTranslation();

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-2 rounded-b-sm border border-foreground/30 p-3">
      <span className="mr-2 font-mono text-[8px] tracking-[0.12em] text-muted-foreground">
        {t("workLayer.review.previewOnly", "PREVIEW ONLY · NOT SAVED")}
      </span>
      {ACTIONS.map((action, index) => {
        const label = t(`workLayer.review.actions.${action.key}`);
        return (
          <button
            key={action.id}
            ref={
              action.id === "correction-rule"
                ? correctionRuleTriggerRef
                : undefined
            }
            type="button"
            onClick={() => {
              const decisionLabel = t("workLayer.review.decision", {
                action: label,
                defaultValue: `${label}（UI Preview）`,
              });
              if (action.effect === "resolve") {
                onAction({
                  effect: "resolve",
                  decision: action.id,
                  label: decisionLabel,
                });
              } else if (action.effect === "dispose") {
                onAction({
                  effect: "dispose",
                  disposition: action.disposition,
                  label: decisionLabel,
                });
              } else {
                onAction({ effect: "edit-correction-rule", label });
              }
            }}
            className={
              action.quiet
                ? `${index === 4 ? "ml-auto " : ""}px-1 py-2 text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`
                : `rounded-sm border border-foreground/30 px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${action.primary ? "bg-foreground font-medium text-background hover:bg-foreground/85" : ""}`
            }
          >
            {label}
          </button>
        );
      })}
    </footer>
  );
}
