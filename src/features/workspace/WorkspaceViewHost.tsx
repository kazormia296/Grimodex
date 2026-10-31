import { lazy, Suspense } from "react";
import { useWorkspaceStore } from "@/features/workspace/store";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { EditorWorkspaceController } from "@/features/editor/EditorWorkspaceController";
import { TitleBar } from "@/components/TitleBar";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { useTranslation } from "react-i18next";

// The recovery shell is rare; keep it (and its candidate API) out of the
// initial graph. Its chunk is local, so it still loads when the workspace
// itself cannot open.
const RecoveryShell = lazy(() =>
  import("@/features/workspace/recovery/RecoveryShell").then((module) => ({
    default: module.RecoveryShell,
  })),
);

/** Loading / welcome / launcher / recovery / editor — keeps App.tsx thin. */
export function WorkspaceViewHost() {
  const view = useWorkspaceStore((s) => s.view);
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const revision = useWorkspaceStore((s) => s.workspaceOpenRevision);
  const recoveryShell = useWorkspaceStore((s) => s.recoveryShell);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const setRecoveryCandidates = useWorkspaceStore(
    (s) => s.setRecoveryCandidates,
  );
  const { t } = useTranslation();

  const loadingView = (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <TitleBar />
      <GrimodexLogo height={40} className="text-foreground" />
      <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
    </div>
  );

  if (view === "loading") return loadingView;
  if (view === "welcome") return <WelcomeScreen />;
  if (view === "launcher") return <LauncherScreen />;
  if (view === "recovery") {
    return (
      <Suspense fallback={loadingView}>
        <RecoveryShell
          recovery={recoveryShell}
          onCandidatesUpdated={setRecoveryCandidates}
          onRetryOpen={(workspacePath) =>
            openWorkspace(workspacePath, "direct")
          }
        />
      </Suspense>
    );
  }
  if (view === "editor") {
    return (
      <EditorWorkspaceController key={`${activeWorkspacePath}:${revision}`} />
    );
  }
  return null;
}
