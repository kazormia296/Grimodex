import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { parseNovelFile } from "@/lib/novelFormat";
import {
  buildNovelImportPlan,
  codexDraftsToParsedEntries,
  type NovelImportPlan,
} from "../novelImporter";
import {
  importCodexEntries,
  importMemoNote,
  importProjectMetadata,
  importTree,
} from "../importApi";
import type { ImportProgress } from "../importApi";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { BUILTIN_CODEX_TYPES } from "@/features/codex/api";
import { listCodexTypes, type CodexType } from "@/features/codex/typeApi";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import { blockIfUnlicensed } from "@/features/license/gate";
import {
  ImportDropzone,
  ImportErrorList,
  ImportProgressBar,
  type SimpleImportPhase,
  ImportInputSlot,
  ImportAnalyzingPlaceholder,
  ImportFlowFooter,
} from "../importShared";
import { prepareImportTarget, type ImportTarget } from "../importTarget";

interface Props {
  importTarget: ImportTarget;
  onClose: () => void;
}

/** renderer の OOM を防ぐ入力上限（.novel は通常数 MB 以下のテキスト）。 */
const MAX_NOVEL_FILE_BYTES = 32 * 1024 * 1024;

const DEFAULT_TYPE = "character";

export function NovelImportFlow({ importTarget, onClose }: Props) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<SimpleImportPhase>("idle");
  const [plan, setPlan] = useState<NovelImportPlan | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [entryTypes, setEntryTypes] = useState<string[]>([]);
  const [existingTypes, setExistingTypes] = useState<CodexType[]>([]);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const reloadCodex = useCodexStore((s) => s.loadEntries);
  const reloadTree = useTreeStore((s) => s.loadTree);

  useEffect(() => {
    if (importTarget === "newProject") {
      setExistingTypes([]);
      return;
    }
    void listCodexTypes(getCurrentProjectId()).then(setExistingTypes);
  }, [importTarget]);

  const typeOptions: Array<{ slug: string; label: string }> =
    importTarget === "currentProject" && existingTypes.length > 0
      ? existingTypes.map((ty) => ({
          slug: ty.slug,
          label: ty.isBuiltin ? getTypeLabel(ty.slug) : ty.label,
        }))
      : BUILTIN_CODEX_TYPES.map((slug) => ({
          slug,
          label: getTypeLabel(slug),
        }));

  const handleFileChange = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".novel")) {
        toast.error(t("import.novel.invalidFile"));
        return;
      }
      if (file.size > MAX_NOVEL_FILE_BYTES) {
        toast.error(t("import.novel.tooLarge"));
        return;
      }
      setPhase("analyzing");
      try {
        const text = await file.text();
        const { novel, warnings: parseWarnings } = parseNovelFile(text);
        const built = buildNovelImportPlan(
          novel,
          file.name.replace(/\.novel$/i, ""),
        );
        setPlan(built);
        setWarnings([...parseWarnings, ...built.warnings]);
        setEntryTypes(built.codexDrafts.map(() => DEFAULT_TYPE));
        setPhase("preview");
      } catch {
        toast.error(t("import.novel.invalidFile"));
        setPhase("idle");
      }
    },
    [t],
  );

  const runImport = useCallback(async () => {
    if (!plan) return;
    if (blockIfUnlicensed()) return;
    setPhase("importing");
    setErrors([]);
    const allErrors: string[] = [];

    try {
      await prepareImportTarget(importTarget, { title: plan.projectTitle });
    } catch {
      toast.error(t("project.create.failed"));
      setPhase("preview");
      return;
    }

    if (plan.memory || plan.footnote) {
      try {
        if (importTarget === "newProject") {
          await importProjectMetadata({
            outline: plan.memory || undefined,
            aiInstructions: plan.footnote || undefined,
          });
        } else {
          const memoBody = [plan.memory, plan.footnote]
            .filter(Boolean)
            .join("\n\n");
          await importMemoNote(
            t("import.novel.memoNoteTitle", { title: plan.projectTitle }),
            memoBody,
          );
        }
      } catch (err) {
        allErrors.push(String(err));
      }
    }

    let entryCount = 0;
    if (plan.codexDrafts.length > 0) {
      const entries = codexDraftsToParsedEntries(plan.codexDrafts, entryTypes);
      const { imported, errors: codexErrors } = await importCodexEntries(
        entries,
        setProgress,
      );
      entryCount = imported;
      allErrors.push(...codexErrors);
    }

    let sceneCount = 0;
    if (plan.bodyLineCount > 0) {
      const { imported, errors: treeErrors } = await importTree(
        [plan.scene],
        setProgress,
      );
      sceneCount = imported;
      allErrors.push(...treeErrors);
    }

    setErrors(allErrors);
    setPhase("done");
    await reloadCodex();
    await reloadTree(getCurrentProjectId());
    toast.success(
      t("import.novel.success", { scenes: sceneCount, entries: entryCount }),
    );
  }, [plan, importTarget, entryTypes, t, reloadCodex, reloadTree]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {(phase === "idle" || phase === "preview") && (
        <ImportInputSlot>
          <ImportDropzone
            accept=".novel"
            hint={t("import.novel.dropzoneHint")}
            onFile={(f) => void handleFileChange(f)}
          />
        </ImportInputSlot>
      )}

      {phase === "analyzing" && <ImportAnalyzingPlaceholder />}

      {phase === "preview" && plan && (
        <>
          <div className="rounded-md border border-border p-4 text-sm">
            <p className="mb-2 font-medium">{t("import.preview")}</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                {t("import.novel.title")}: {plan.projectTitle}
              </li>
              <li>
                {t("import.novel.body", {
                  lines: plan.bodyLineCount,
                  chars: plan.bodyCharCount,
                })}
              </li>
              {plan.memory && <li>{t("import.novel.memoryFound")}</li>}
              {plan.footnote && <li>{t("import.novel.footnoteFound")}</li>}
              <li>
                {t("import.novel.charBookEntries", {
                  count: plan.codexDrafts.length,
                })}
              </li>
              <li className="text-xs">{t("import.novel.ignoredSections")}</li>
            </ul>
            {warnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-amber-600 dark:text-amber-400">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>

          {plan.codexDrafts.length > 0 && (
            <div className="rounded-md border border-border p-4 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="font-medium">{t("import.novel.charBook")}</p>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  {t("import.novel.applyAllTypes")}
                  <select
                    data-testid="novel-import-type-all"
                    className="rounded border border-border bg-background px-1 py-0.5"
                    value=""
                    onChange={(e) => {
                      const slug = e.target.value;
                      if (!slug) return;
                      setEntryTypes(plan.codexDrafts.map(() => slug));
                    }}
                  >
                    <option value="" />
                    {typeOptions.map((ty) => (
                      <option key={ty.slug} value={ty.slug}>
                        {ty.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <ul className="space-y-1">
                {plan.codexDrafts.map((draft, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 truncate">
                      {draft.name}
                      {draft.aliases.length > 0 && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({draft.aliases.join(", ")})
                        </span>
                      )}
                    </span>
                    <select
                      data-testid={`novel-import-type-${i}`}
                      className="shrink-0 rounded border border-border bg-background px-1 py-0.5 text-xs"
                      value={entryTypes[i] ?? DEFAULT_TYPE}
                      onChange={(e) => {
                        const slug = e.target.value;
                        setEntryTypes((prev) => {
                          const next = prev.slice();
                          next[i] = slug;
                          return next;
                        });
                      }}
                    >
                      {typeOptions.map((ty) => (
                        <option key={ty.slug} value={ty.slug}>
                          {ty.label}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(plan.memory || plan.footnote) && (
            <p className="text-xs text-muted-foreground">
              {importTarget === "newProject"
                ? t("import.novel.metadataHintNewProject")
                : t("import.novel.metadataHintCurrentProject")}
            </p>
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

      {phase === "done" && <ImportErrorList errors={errors} />}

      {phase !== "importing" && (
        <ImportFlowFooter>
          {phase !== "done" && (
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
          {phase === "done" && (
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
