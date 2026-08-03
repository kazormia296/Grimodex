import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "./store";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";

export function WorkspaceTrustDialog() {
  const { t } = useTranslation();
  const pendingTrustPath = useWorkspaceStore((s) => s.pendingTrustPath);
  const trustAndOpen = useWorkspaceStore((s) => s.trustAndOpen);
  const cancelTrust = useWorkspaceStore((s) => s.cancelTrust);
  const workspaceOpenRequestInProgress = useWorkspaceStore(
    (s) => s.workspaceOpenRequestInProgress,
  );
  const workspaceSwitchInProgress = useWorkspaceStore(
    (s) => s.workspaceSwitchInProgress,
  );
  const workspaceBusy =
    workspaceOpenRequestInProgress || workspaceSwitchInProgress;

  return (
    <AnimatedOverlay
      open={!!pendingTrustPath}
      onClose={cancelTrust}
      backdropClassName="bg-background/80 backdrop-blur-sm"
      className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
    >
      <div className="mb-4 flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-yellow-500"
          aria-hidden
        />
        <h2 className="text-base font-semibold text-foreground">
          {t("workspace.trustTitle")}
        </h2>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        {t("workspace.trustMessage")}
      </p>

      <p className="mb-1 break-all rounded bg-muted px-3 py-2 text-xs font-mono text-foreground">
        {t("workspace.trustPath", { path: pendingTrustPath })}
      </p>

      <p className="mb-6 text-xs text-destructive">
        {t("workspace.trustWarning")}
      </p>

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={cancelTrust}
          disabled={workspaceBusy}
          className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {t("workspace.trustCancel")}
        </button>
        <button
          type="button"
          onClick={() => void trustAndOpen()}
          disabled={workspaceBusy}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t("workspace.trustAndOpen")}
        </button>
      </div>
    </AnimatedOverlay>
  );
}
