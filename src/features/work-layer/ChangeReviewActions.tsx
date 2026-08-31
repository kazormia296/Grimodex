import { useTranslation } from "react-i18next";

const ACTIONS = [
  { id: "apply", key: "apply", primary: true, quiet: false },
  { id: "edit-apply", key: "editApply", primary: false, quiet: false },
  { id: "reject", key: "reject", primary: false, quiet: false },
  { id: "hold", key: "hold", primary: false, quiet: false },
  { id: "ignore-basis", key: "ignoreBasis", primary: false, quiet: true },
  {
    id: "correction-rule",
    key: "correctionRule",
    primary: false,
    quiet: true,
  },
] as const;

interface ChangeReviewActionsProps {
  readonly findingId: string;
  readonly onPreviewDecision: (
    findingId: string,
    candidateId: string,
    decisionLabel: string,
  ) => void;
}

export function ChangeReviewActions({
  findingId,
  onPreviewDecision,
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
            type="button"
            onClick={() =>
              onPreviewDecision(
                findingId,
                `change-review:${action.id}`,
                t("workLayer.review.decision", {
                  action: label,
                  defaultValue: `${label}（UI Preview）`,
                }),
              )
            }
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
