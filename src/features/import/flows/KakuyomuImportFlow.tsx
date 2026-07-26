import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { parseKakuyomuZip } from "../kakuyomuParser";
import type { KakuyomuParseResult } from "../kakuyomuParser";
import { importTree, importProjectMetadata } from "../importApi";
import type { ImportProgress } from "../importApi";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getProject } from "@/features/project/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { blockIfUnlicensed } from "@/features/license/gate";
import { countFoldersInTree, countScenesInTree } from "../markdownParser";
import {
  ImportDropzone,
  ImportErrorList,
  ImportProgressBar,
  MetadataApplyPanel,
  resolveOutline,
  type SimpleImportPhase,
  ImportInputSlot,
  ImportAnalyzingPlaceholder,
  ImportFlowFooter,
  useImportBusyChange,
  useImportFailureReset,
} from "../importShared";
import { prepareImportTarget, type ImportTarget } from "../importTarget";
import {
  hasAllowedImportExtension,
  importFileLimitViolation,
  importLimitMessageValues,
} from "../importFileLimits";

interface Props {
  importTarget: ImportTarget;
  onClose: () => void;
  enforceBrowserLimits?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onFailedChange?: (failed: boolean) => void;
}

export function KakuyomuImportFlow({
  importTarget,
  onClose,
  enforceBrowserLimits = false,
  onBusyChange,
  onFailedChange,
}: Props) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<SimpleImportPhase>("idle");
  const [parsed, setParsed] = useState<KakuyomuParseResult | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [applyMetadata, setApplyMetadata] = useState(true);
  const [outlineMode, setOutlineMode] = useState<
    "overwrite" | "append" | "skip"
  >("append");
  const [hasExistingOutline, setHasExistingOutline] = useState(false);

  const reloadTree = useTreeStore((s) => s.loadTree);

  useImportBusyChange(phase, onBusyChange);
  useImportFailureReset(onFailedChange);

  useEffect(() => {
    if (importTarget === "newProject") {
      setHasExistingOutline(false);
      return;
    }
    void getProject(getCurrentProjectId()).then((p) => {
      setHasExistingOutline(Boolean(p?.outline?.trim()));
    });
  }, [importTarget]);

  const handleFileChange = useCallback(
    async (file: File) => {
      const validExtension = enforceBrowserLimits
        ? hasAllowedImportExtension(file.name, ["zip"])
        : file.name.endsWith(".zip");
      if (!validExtension) {
        toast.error(t("import.invalidZip"));
        return;
      }
      const limitViolation = enforceBrowserLimits
        ? importFileLimitViolation(file, "archive")
        : null;
      if (limitViolation) {
        toast.error(
          t(
            `import.limits.${limitViolation}`,
            importLimitMessageValues(limitViolation, "archive"),
          ),
        );
        return;
      }
      setPhase("analyzing");
      try {
        const buffer = await file.arrayBuffer();
        const result = parseKakuyomuZip(new Uint8Array(buffer));
        setParsed(result);
        setPhase("preview");
      } catch {
        toast.error(t("import.invalidKakuyomu"));
        setPhase("idle");
      }
    },
    [enforceBrowserLimits, t],
  );

  const runImport = useCallback(async () => {
    if (!parsed) return;
    if (blockIfUnlicensed()) return;
    setPhase("importing");
    setErrors([]);
    const allErrors = [...parsed.warnings];

    try {
      await prepareImportTarget(importTarget, {
        title: parsed.metadata.title || parsed.projectTitle,
        genre: parsed.metadata.genre,
      });
    } catch {
      toast.error(t("project.create.failed"));
      setPhase("preview");
      return;
    }

    try {
      const shouldApplyMetadata =
        importTarget === "newProject" || applyMetadata;

      if (shouldApplyMetadata) {
        const project = await getProject(getCurrentProjectId());
        const outline = resolveOutline(
          project?.outline,
          parsed.metadata.outline,
          importTarget === "newProject" ? "overwrite" : outlineMode,
        );
        try {
          await importProjectMetadata({
            title:
              importTarget === "newProject" ? undefined : parsed.metadata.title,
            genre:
              importTarget === "newProject" ? undefined : parsed.metadata.genre,
            outline,
          });
        } catch (err) {
          allErrors.push(String(err));
        }
      }

      const { imported, errors: treeErrors } = await importTree(
        parsed.tree,
        setProgress,
      );
      allErrors.push(...treeErrors);
      setErrors(allErrors);
      await reloadTree(getCurrentProjectId());
      setPhase("done");
      toast.success(
        t("import.kakuyomu.success", {
          folders: countFoldersInTree(parsed.tree),
          scenes: countScenesInTree(parsed.tree),
          imported,
        }),
      );
    } catch (error) {
      setErrors([...allErrors, String(error)]);
      setProgress(null);
      toast.error(t("import.failed"));
      onFailedChange?.(true);
      setPhase("failed");
    }
  }, [
    parsed,
    importTarget,
    applyMetadata,
    outlineMode,
    t,
    reloadTree,
    onFailedChange,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {(phase === "idle" || phase === "preview") && (
        <ImportInputSlot>
          <ImportDropzone
            accept=".zip"
            onFile={(f) => void handleFileChange(f)}
          />
        </ImportInputSlot>
      )}

      {phase === "analyzing" && <ImportAnalyzingPlaceholder />}

      {phase === "preview" && parsed && (
        <>
          <div className="rounded-md border border-border p-4 text-sm">
            <p className="mb-2 font-medium">{t("import.preview")}</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                {t("import.kakuyomu.title")}: {parsed.projectTitle}
              </li>
              <li>
                {t("import.chapters")}: {countFoldersInTree(parsed.tree)}
              </li>
              <li>
                {t("import.scenes")}: {countScenesInTree(parsed.tree)}
              </li>
              {parsed.flatStructure && (
                <li className="text-amber-600 dark:text-amber-400">
                  {t("import.kakuyomu.flatStructureWarning")}
                </li>
              )}
            </ul>
            {parsed.warnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-amber-600 dark:text-amber-400">
                {parsed.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
          {importTarget === "newProject" ? (
            <p className="text-xs text-muted-foreground">
              {t("import.target.newProjectMetadataHint")}
            </p>
          ) : (
            <MetadataApplyPanel
              applyMetadata={applyMetadata}
              onApplyMetadataChange={setApplyMetadata}
              outlineMode={outlineMode}
              onOutlineModeChange={setOutlineMode}
              hasExistingOutline={hasExistingOutline}
            />
          )}
        </>
      )}

      {phase === "importing" && progress && (
        <ImportProgressBar progress={progress} />
      )}

      {phase === "done" && errors.length === 0 && (
        <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          {t("import.doneSuccess")}
        </div>
      )}

      {(phase === "done" || phase === "failed") && (
        <ImportErrorList errors={errors} />
      )}

      {phase !== "importing" && (
        <ImportFlowFooter>
          {phase !== "done" && phase !== "failed" && (
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm hover:bg-accent"
            >
              {t("import.cancel")}
            </button>
          )}
          {phase === "preview" && (
            <button
              type="button"
              onClick={() => void runImport()}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            >
              {t("import.importButton")}
            </button>
          )}
          {(phase === "done" || phase === "failed") && (
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            >
              {t("import.close")}
            </button>
          )}
        </ImportFlowFooter>
      )}

      {phase === "importing" && (
        <div className="flex justify-end">
          <span className="text-sm text-muted-foreground">
            {t("import.importing")}
          </span>
        </div>
      )}
    </div>
  );
}
