import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  CLOUDFLARE_ABUSE_POLICY_URL,
  cloudContentPolicy,
} from "@grimodex/scan-contract";

export type HostedEditorEntryMode = "scan" | "standalone";

interface HostedEditorTrialBarProps {
  entryMode: HostedEditorEntryMode;
  onContinue?: () => void;
}

export function HostedEditorTrialBar({
  entryMode,
  onContinue,
}: HostedEditorTrialBarProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const contentPolicy = cloudContentPolicy(
    (i18n.resolvedLanguage ?? i18n.language).startsWith("ja") ? "ja" : "en",
  );
  const entryDescription =
    entryMode === "scan"
      ? t("hostedEditor.trial.scanDescription")
      : t("hostedEditor.trial.standaloneDescription");

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
        <span>{entryDescription}</span>
        <span className="text-muted-foreground">
          {t("hostedEditor.trial.storageNotice")}
        </span>
        <span className="text-muted-foreground">
          {t("hostedEditor.trial.aiNotice")}
        </span>
        <span className="text-muted-foreground">
          {contentPolicy.bannerNotice}
        </span>
        <a
          href={CLOUDFLARE_ABUSE_POLICY_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-primary underline underline-offset-2"
        >
          {t("hostedEditor.trial.contentPolicyLink")}
        </a>
      </div>

      {onContinue && (
        <Button type="button" variant="outline" size="sm" onClick={onContinue}>
          {t("hostedEditor.trial.continueInGrimodex")}
        </Button>
      )}
    </section>
  );
}
