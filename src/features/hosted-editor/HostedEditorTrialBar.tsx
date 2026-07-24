import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const MOBILE_DISMISS_KEY = "grimodex.hosted-editor.trial-banner-dismissed";

function wasDismissedThisSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(MOBILE_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

interface HostedEditorTrialBarProps {
  onContinue?: () => void;
  compact?: boolean;
}

export function HostedEditorTrialBar({
  onContinue,
  compact = false,
}: HostedEditorTrialBarProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [mobileDismissed, setMobileDismissed] = useState(
    wasDismissedThisSession,
  );

  if (compact && mobileDismissed) return null;

  const dismissMobileBanner = () => {
    setMobileDismissed(true);
    try {
      window.sessionStorage.setItem(MOBILE_DISMISS_KEY, "1");
    } catch {
      // The in-memory state still keeps the banner dismissed when storage is
      // unavailable (for example, a privacy-restricted browser context).
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      data-compact={compact ? "true" : "false"}
      className={`flex flex-wrap items-center gap-y-2 border-b border-border bg-muted/40 text-xs text-foreground ${
        compact ? "gap-x-2 px-3 py-1.5" : "gap-x-4 px-4 py-2"
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <span
          id={titleId}
          className="whitespace-nowrap rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary"
        >
          {t("hostedEditor.trial.title")}
        </span>
        {compact && (
          <span data-trial-mobile-summary className="text-muted-foreground">
            {t("hostedEditor.trial.mobileSummary")}
          </span>
        )}
        <div
          data-trial-details
          aria-hidden={compact ? "true" : "false"}
          className={compact ? "hidden" : "contents"}
        >
          {!compact && (
            <>
              <span>{t("hostedEditor.trial.description")}</span>
              <span className="text-muted-foreground">
                {t("hostedEditor.trial.storageNotice")}
              </span>
              <span className="text-muted-foreground">
                {t("hostedEditor.trial.importNotice")}
              </span>
              <span className="text-muted-foreground">
                {t("hostedEditor.trial.aiNotice")}
              </span>
            </>
          )}
        </div>
      </div>

      {onContinue && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onContinue}
          className={compact ? "min-h-11" : undefined}
        >
          {t("hostedEditor.trial.continueInGrimodex")}
        </Button>
      )}
      {compact && (
        <button
          type="button"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={dismissMobileBanner}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </section>
  );
}
