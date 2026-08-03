import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/lib/dialog";
import { useWorkspaceStore } from "./store";
import { TitleBar } from "@/components/TitleBar";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { PreflightCard } from "@/features/onboarding/PreflightCard";
import { requestWebEditorHandoffImport } from "@/features/import/webEditorHandoffRequest";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

export function WelcomeScreen() {
  const { t } = useTranslation();
  const runtimeCapabilities = useRuntimeCapabilities();
  const hasSeenWelcome = useWorkspaceStore(
    (s) => s.globalSettings?.hasSeenWelcome,
  );

  // First-run: show interactive preflight instead of the folder-picker
  if (!hasSeenWelcome) {
    return (
      <>
        <PreflightCard />
        {runtimeCapabilities.genericProjectTransfer && (
          <button
            type="button"
            onClick={requestWebEditorHandoffImport}
            className="fixed bottom-6 left-1/2 z-10 -translate-x-1/2 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("hostedEditor.desktopImport.action")}
          </button>
        )}
      </>
    );
  }

  return <ReturningUserScreen />;
}

function ReturningUserScreen() {
  const { t } = useTranslation();
  const runtimeCapabilities = useRuntimeCapabilities();
  const requestOpenWorkspace = useWorkspaceStore((s) => s.requestOpenWorkspace);
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const uiLanguage = useWorkspaceStore(
    (s) => s.globalSettings?.uiLanguage ?? "ja",
  );
  const updateGlobalSettings = useWorkspaceStore((s) => s.updateGlobalSettings);
  const workspaceOpenRequestInProgress = useWorkspaceStore(
    (s) => s.workspaceOpenRequestInProgress,
  );
  const workspaceSwitchInProgress = useWorkspaceStore(
    (s) => s.workspaceSwitchInProgress,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const workspaceBusy =
    opening || workspaceOpenRequestInProgress || workspaceSwitchInProgress;

  async function handleSelectFolder() {
    if (workspaceBusy) return;
    clearError();
    const path = await openFolderDialog();
    if (path) {
      setSelectedPath(path);
    }
  }

  async function handleStart() {
    if (!selectedPath || workspaceBusy) return;
    setOpening(true);
    try {
      await requestOpenWorkspace(selectedPath, "folder-picker");
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background text-foreground">
      <TitleBar />
      <div className="flex max-w-md flex-col items-center gap-6 px-8">
        <GrimodexLogo height={36} className="text-foreground" />
        <p className="text-center text-sm text-muted-foreground">
          {t("welcome.description")}
          <br />
          {t("welcome.descriptionSub")}
        </p>

        <button
          type="button"
          onClick={handleSelectFolder}
          disabled={workspaceBusy}
          className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {t("welcome.selectFolder")}
        </button>

        {runtimeCapabilities.genericProjectTransfer && (
          <button
            type="button"
            onClick={requestWebEditorHandoffImport}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("hostedEditor.desktopImport.action")}
          </button>
        )}

        {selectedPath && (
          <p className="max-w-full truncate text-xs text-muted-foreground">
            {selectedPath}
          </p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <button
          type="button"
          onClick={handleStart}
          disabled={!selectedPath || workspaceBusy}
          className="rounded-md bg-primary px-8 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {opening ? t("welcome.preparing") : t("welcome.start")}
        </button>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("settings.display.uiLanguage")}</span>
          <select
            value={uiLanguage}
            onChange={(e) =>
              void updateGlobalSettings({ uiLanguage: e.target.value })
            }
            className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none"
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
