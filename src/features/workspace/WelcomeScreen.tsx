import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/lib/dialog";
import { useWorkspaceStore } from "./store";
import { TitleBar } from "@/components/TitleBar";
import { GrimodexLogo } from "@/components/GrimodexLogo";

export function WelcomeScreen() {
  const { t } = useTranslation();
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  async function handleSelectFolder() {
    clearError();
    const path = await openFolderDialog();
    if (path) {
      setSelectedPath(path);
    }
  }

  async function handleStart() {
    if (!selectedPath) return;
    setOpening(true);
    await openWorkspace(selectedPath);
    setOpening(false);
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
          className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {t("welcome.selectFolder")}
        </button>

        {selectedPath && (
          <p className="max-w-full truncate text-xs text-muted-foreground">
            {selectedPath}
          </p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <button
          type="button"
          onClick={handleStart}
          disabled={!selectedPath || opening}
          className="rounded-md bg-primary px-8 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {opening ? t("welcome.preparing") : t("welcome.start")}
        </button>
      </div>
    </div>
  );
}
