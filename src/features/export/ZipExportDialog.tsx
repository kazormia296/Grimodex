import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import {
  useCurrentProjectId,
  useCurrentProject,
} from "@/features/project/projectStore";
import { saveBinaryFile } from "@/lib/exportFile";
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
  // 保存ダイアログは Rust 側 (security audit PIO-2)。キャンセルは null。
  const saved = await saveBinaryFile(
    filename,
    { name: "ZIP", extensions: ["zip"] },
    blob,
    "application/zip",
  );
  return saved !== null;
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

/**
 * プロジェクト ZIP エクスポート UI 本体（AnimatedOverlay を含まない）。
 * 単体ダイアログ（ZipExportDialog）と統合ダイアログ（TransferDialog）の両方で再利用。
 */
export function ZipExportBody({ onClose }: { onClose: () => void }) {
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
    <div className="flex w-full flex-col gap-4">
      <h2 className="text-base font-semibold">{t("zipExport.title")}</h2>

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
    </div>
  );
}

export function ZipExportDialog({ open, onClose }: Props) {
  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="flex w-[480px] max-w-[90vw] flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-xl"
    >
      <ZipExportBody onClose={onClose} />
    </AnimatedOverlay>
  );
}
