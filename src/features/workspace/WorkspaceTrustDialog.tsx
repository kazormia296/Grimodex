import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "./store";

export function WorkspaceTrustDialog() {
  const { t } = useTranslation();
  const pendingTrustPath = useWorkspaceStore((s) => s.pendingTrustPath);
  const trustAndOpen = useWorkspaceStore((s) => s.trustAndOpen);
  const cancelTrust = useWorkspaceStore((s) => s.cancelTrust);

  if (!pendingTrustPath) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-start gap-3">
          <span className="mt-0.5 text-xl text-yellow-500">⚠</span>
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
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            {t("workspace.trustCancel")}
          </button>
          <button
            type="button"
            onClick={() => void trustAndOpen()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("workspace.trustAndOpen")}
          </button>
        </div>
      </div>
    </div>
  );
}
