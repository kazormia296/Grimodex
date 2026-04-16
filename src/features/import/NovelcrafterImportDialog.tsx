import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { parseNovelcrafterZip } from "./novelcrafterParser";
import { importCodexEntries, importSnippets } from "./importApi";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import type { ParseResult } from "./novelcrafterParser";
import type { ImportProgress } from "./importApi";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Phase = "idle" | "analyzing" | "preview" | "importing" | "done";

export function NovelcrafterImportDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const reloadCodex = useCodexStore((s) => s.loadEntries);
  const reloadSnippets = useSnippetStore((s) => s.loadEntries);

  const handleFileChange = useCallback(
    async (file: File | null) => {
      if (!file) return;
      if (!file.name.endsWith(".zip")) {
        toast.error(t("import.invalidZip"));
        return;
      }

      setPhase("analyzing");
      try {
        const buffer = await file.arrayBuffer();
        const result = parseNovelcrafterZip(new Uint8Array(buffer));
        setParsed(result);
        setPhase("preview");
      } catch {
        toast.error(t("import.invalidZip"));
        setPhase("idle");
      }
    },
    [t],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0] ?? null;
      void handleFileChange(file);
    },
    [handleFileChange],
  );

  const handleImport = useCallback(async () => {
    if (!parsed) return;
    setPhase("importing");
    setErrors([]);

    const allErrors: string[] = [];

    const { imported: codexImported, errors: codexErrors } =
      await importCodexEntries(parsed.codexEntries, (p) => setProgress(p));
    allErrors.push(...codexErrors);

    const { imported: snippetsImported, errors: snippetErrors } =
      await importSnippets(parsed.snippets, (p) => setProgress(p));
    allErrors.push(...snippetErrors);

    setErrors(allErrors);
    setPhase("done");

    // Reload stores so the UI reflects the newly imported data
    await reloadCodex();
    await reloadSnippets();

    toast.success(
      t("import.success", {
        codex: codexImported,
        snippets: snippetsImported,
      }),
    );
  }, [parsed, t, reloadCodex, reloadSnippets]);

  const handleClose = useCallback(() => {
    setPhase("idle");
    setParsed(null);
    setProgress(null);
    setErrors([]);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && handleClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        tabIndex={-1}
        className="flex w-[480px] flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-xl outline-none"
      >
        <h2 id="import-dialog-title" className="text-base font-semibold">
          {t("import.dialogTitle")}
        </h2>

        {/* Dropzone — shown in idle/preview */}
        {(phase === "idle" || phase === "preview") && (
          <div
            role="button"
            tabIndex={0}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed border-border p-8 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) =>
              (e.key === "Enter" || e.key === " ") &&
              fileInputRef.current?.click()
            }
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            <Upload className="h-8 w-8 opacity-50" />
            <span>{t("import.dropzone")}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) =>
                void handleFileChange(e.target.files?.[0] ?? null)
              }
            />
          </div>
        )}

        {/* Analyzing */}
        {phase === "analyzing" && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            {t("import.analyzing")}
          </div>
        )}

        {/* Preview */}
        {phase === "preview" && parsed && (
          <div className="rounded-md border border-border p-4 text-sm">
            <p className="mb-2 font-medium">{t("import.preview")}</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                {t("import.codexEntries")}: {parsed.codexEntries.length}
              </li>
              <li>
                {t("import.snippets")}: {parsed.snippets.length}
              </li>
            </ul>
          </div>
        )}

        {/* Importing progress */}
        {phase === "importing" && progress && (
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
        )}

        {/* Done — success */}
        {phase === "done" && errors.length === 0 && (
          <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
            {t("import.doneSuccess")}
          </div>
        )}

        {/* Done — errors */}
        {phase === "done" && errors.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
            <p className="mb-1 font-medium">{t("import.errorTitle")}</p>
            {errors.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </div>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-2">
          {phase !== "importing" && phase !== "done" && (
            <button
              type="button"
              onClick={handleClose}
              className="rounded px-3 py-1.5 text-sm hover:bg-accent"
            >
              {t("import.cancel")}
            </button>
          )}
          {phase === "preview" && (
            <button
              type="button"
              onClick={() => void handleImport()}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            >
              {t("import.importButton")}
            </button>
          )}
          {phase === "importing" && (
            <span className="text-sm text-muted-foreground">
              {t("import.importing")}
            </span>
          )}
          {phase === "done" && (
            <button
              type="button"
              onClick={handleClose}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            >
              {t("import.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
