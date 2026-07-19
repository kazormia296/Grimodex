import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface HostedEditorTrialBarProps {
  onContinue?: () => void;
}

export function HostedEditorTrialBar({
  onContinue,
}: HostedEditorTrialBarProps) {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-foreground"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <span
          id={titleId}
          className="whitespace-nowrap rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary"
        >
          {t("hostedEditor.trial.title")}
        </span>
        <span>{t("hostedEditor.trial.description")}</span>
        <span className="text-muted-foreground">
          {t("hostedEditor.trial.storageNotice")}
        </span>
        <span className="text-muted-foreground">
          {t("hostedEditor.trial.aiNotice")}
        </span>
      </div>

      {onContinue && (
        <Button type="button" variant="outline" size="sm" onClick={onContinue}>
          {t("hostedEditor.trial.continueInGrimodex")}
        </Button>
      )}
    </section>
  );
}
