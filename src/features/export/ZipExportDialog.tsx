import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X, Download } from "lucide-react";
import { toast } from "sonner";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import {
  useCurrentProjectId,
  useCurrentProject,
} from "@/features/project/projectStore";
import { buildArchive, defaultZipFilename } from "./zipExport/buildArchive";
import {
  DEFAULT_ZIP_EXPORT_SETTINGS,
  type ZipExportSettings,
} from "./zipExport/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

async function saveZipBlob(
  blob: Uint8Array,
  filename: string,
): Promise<boolean> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!path) return false;
    await writeFile(path, blob);
    return true;
  }

  const url = URL.createObjectURL(
    new Blob([blob as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-border"
      />
      {label}
    </label>
  );
}

export function ZipExportDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const project = useCurrentProject();
  const [settings, setSettings] = useState<ZipExportSettings>(
    DEFAULT_ZIP_EXPORT_SETTINGS,
  );
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const patchSettings = useCallback((patch: Partial<ZipExportSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  async function handleExport() {
    if (isExporting || !projectId) return;
    setIsExporting(true);
    setProgress(t("zipExport.progress.preparing"));
    try {
      const zipBytes = await buildArchive({
        projectId,
        settings,
        onProgress: ({ phase, current, total }) => {
          setProgress(t("zipExport.progress.phase", { phase, current, total }));
        },
      });
      const filename = defaultZipFilename(project?.title ?? "project");
      const saved = await saveZipBlob(zipBytes, filename);
      if (saved) {
        toast.success(t("zipExport.success", { filename }));
        onClose();
      }
    } catch (err) {
      toast.error(t("zipExport.failed", { error: String(err) }));
    } finally {
      setIsExporting(false);
      setProgress(null);
    }
  }

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="flex w-[480px] max-w-[90vw] flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-xl"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("zipExport.title")}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("zipExport.description")}
      </p>

      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <ToggleRow
          label={t("zipExport.includeMarks")}
          checked={settings.includeMarks}
          onChange={(v) => patchSettings({ includeMarks: v })}
        />
        <ToggleRow
          label={t("zipExport.includeChats")}
          checked={settings.includeChats}
          onChange={(v) => patchSettings({ includeChats: v })}
        />
        <ToggleRow
          label={t("zipExport.includeSnippets")}
          checked={settings.includeSnippets}
          onChange={(v) => patchSettings({ includeSnippets: v })}
        />
        <ToggleRow
          label={t("zipExport.includeMaps")}
          checked={settings.includeMaps}
          onChange={(v) => patchSettings({ includeMaps: v })}
        />
      </div>

      {progress && <p className="text-xs text-muted-foreground">{progress}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={isExporting}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-testid="zip-export-submit"
          onClick={() => void handleExport()}
          disabled={isExporting}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {isExporting ? t("zipExport.exporting") : t("zipExport.export")}
        </button>
      </div>
    </AnimatedOverlay>
  );
}
