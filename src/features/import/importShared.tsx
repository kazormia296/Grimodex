import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ImportProgress } from "./importApi";

interface ImportDropzoneProps {
  accept: string;
  hint?: string;
  directory?: boolean;
  onFile: (file: File) => void;
  onFiles?: (files: FileList) => void;
}

export function ImportDropzone({
  accept,
  hint,
  directory,
  onFile,
  onFiles,
}: ImportDropzoneProps) {
  const { t } = useTranslation();

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed border-border p-8 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
        onClick={(e) => {
          const input = (e.currentTarget as HTMLElement).querySelector("input");
          input?.click();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            const input = (e.currentTarget as HTMLElement).querySelector("input");
            input?.click();
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (onFiles && e.dataTransfer.files.length > 1) {
            onFiles(e.dataTransfer.files);
          } else {
            onFile(e.dataTransfer.files[0]!);
          }
        }}
        onDragOver={(e) => e.preventDefault()}
      >
        <Upload className="h-8 w-8 opacity-50" />
        <span>{t("import.dropzone")}</span>
        {hint && <span className="text-xs">{hint}</span>}
        <input
          type="file"
          accept={accept}
          {...(directory ? { webkitdirectory: "", multiple: true } : {})}
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (!files?.length) return;
            if (onFiles && files.length > 1) onFiles(files);
            else onFile(files[0]!);
            e.target.value = "";
          }}
        />
      </div>
      <p className="text-xs font-medium text-destructive">
        {t("import.untrustedSourceWarning")}
      </p>
    </>
  );
}

export function ImportProgressBar({ progress }: { progress: ImportProgress }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{
            width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t("import.progressLabel", {
          done: progress.done,
          total: progress.total,
          name: progress.currentName,
        })}
      </p>
    </div>
  );
}

export function ImportErrorList({ errors }: { errors: string[] }) {
  const { t } = useTranslation();
  if (errors.length === 0) return null;
  return (
    <div className="max-h-40 overflow-y-auto rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
      <p className="mb-1 font-medium">{t("import.errorTitle")}</p>
      {errors.map((e, i) => (
        <p key={i}>{e}</p>
      ))}
    </div>
  );
}

/** Stable-height region for dropzone / file picker — avoids layout jump on tab switch. */
export function ImportInputSlot({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-60 flex-col gap-4">{children}</div>
  );
}

export function ImportAnalyzingPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-60 items-center justify-center text-sm text-muted-foreground">
      {t("import.analyzing")}
    </div>
  );
}

export function ImportFlowFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-auto flex shrink-0 justify-end gap-2 pt-1">
      {children}
    </div>
  );
}

export type SimpleImportPhase =
  | "idle"
  | "analyzing"
  | "preview"
  | "importing"
  | "done";

interface MetadataApplyOptions {
  applyMetadata: boolean;
  outlineMode: "overwrite" | "append" | "skip";
}

export function MetadataApplyPanel({
  applyMetadata,
  onApplyMetadataChange,
  outlineMode,
  onOutlineModeChange,
  hasExistingOutline,
}: {
  applyMetadata: boolean;
  onApplyMetadataChange: (v: boolean) => void;
  outlineMode: "overwrite" | "append" | "skip";
  onOutlineModeChange: (v: "overwrite" | "append" | "skip") => void;
  hasExistingOutline: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={applyMetadata}
          onChange={(e) => onApplyMetadataChange(e.target.checked)}
        />
        {t("import.kakuyomu.applyMetadata")}
      </label>
      {applyMetadata && hasExistingOutline && (
        <fieldset className="space-y-1 pl-4 text-xs text-muted-foreground">
          <legend>{t("import.metadata.outlineExists")}</legend>
          {(["overwrite", "append", "skip"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="outlineMode"
                checked={outlineMode === mode}
                onChange={() => onOutlineModeChange(mode)}
              />
              {t(`import.metadata.${mode}`)}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

export function resolveOutline(
  existing: string | null | undefined,
  incoming: string | undefined,
  mode: MetadataApplyOptions["outlineMode"],
): string | undefined {
  if (!incoming) return undefined;
  if (mode === "skip") return undefined;
  if (mode === "overwrite" || !existing?.trim()) return incoming;
  return `${existing.trim()}\n\n${incoming}`;
}

export { type MetadataApplyOptions };
