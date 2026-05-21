import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { parseNovelcrafterZip, collectAllTagNames } from "./novelcrafterParser";
import {
  importCodexEntries,
  importSnippets,
  importChapters,
  importChatSessionsBatch,
} from "./importApi";
import type { TagMappingAction, TagImportOptions } from "./importApi";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useChatHistoryStore } from "@/features/chat/chatHistoryStore";
import type { ParseResult } from "./novelcrafterParser";
import type { ImportProgress } from "./importApi";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { listCodexTypes } from "@/features/codex/typeApi";
import type { CodexType } from "@/features/codex/typeApi";
import { TagMappingSection } from "./TagMappingSection";
import {
  ConflictResolutionSection,
  type EntryConflict,
} from "./ConflictResolutionSection";
import type { ParsedCodexEntry } from "./novelcrafterParser";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Phase =
  | "idle"
  | "analyzing"
  | "preview"
  | "tag-mapping"
  | "conflict-resolution"
  | "importing"
  | "done";

function computeConflicts(
  entries: ParsedCodexEntry[],
  tagTypeMap: Map<string, TagMappingAction>,
): EntryConflict[] {
  const result: EntryConflict[] = [];
  for (const entry of entries) {
    const tags = JSON.parse(entry.tagsCache) as {
      name: string;
      color: string | null;
    }[];
    const mapped = tags
      .map((t) => t.name)
      .filter(Boolean)
      .filter((name) => {
        const a = tagTypeMap.get(name);
        return a && a.mode !== "none";
      });
    if (mapped.length > 1) {
      result.push({
        entryId: entry.id,
        entryName: entry.name,
        conflictingTags: mapped,
        selectedTag: mapped[0],
      });
    }
  }
  return result;
}

export function NovelcrafterImportDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const [existingTypes, setExistingTypes] = useState<CodexType[]>([]);
  const [allTagNames, setAllTagNames] = useState<string[]>([]);
  const [tagTypeConfigs, setTagTypeConfigs] = useState<
    Map<string, TagMappingAction>
  >(new Map());
  const [conflicts, setConflicts] = useState<EntryConflict[]>([]);
  const [conflictResolutions, setConflictResolutions] = useState<
    Map<string, string>
  >(new Map());

  const reloadCodex = useCodexStore((s) => s.loadEntries);
  const reloadSnippets = useSnippetStore((s) => s.loadEntries);
  const reloadTree = useTreeStore((s) => s.loadTree);
  const reloadSessions = useChatHistoryStore((s) => s.loadSessions);

  // Load existing types and compute tag names when parse result arrives
  useEffect(() => {
    if (!parsed) return;
    const names = collectAllTagNames(parsed.codexEntries);
    setAllTagNames(names);
    setTagTypeConfigs(new Map(names.map((n) => [n, { mode: "none" }])));
    void listCodexTypes(getCurrentProjectId()).then(setExistingTypes);
  }, [parsed]);

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

  const runImport = useCallback(
    async (tagOptions?: TagImportOptions) => {
      if (!parsed) return;
      setPhase("importing");
      setErrors([]);

      const allErrors: string[] = [];

      const { imported: codexImported, errors: codexErrors } =
        await importCodexEntries(
          parsed.codexEntries,
          (p) => setProgress(p),
          tagOptions,
        );
      allErrors.push(...codexErrors);

      const { imported: snippetsImported, errors: snippetErrors } =
        await importSnippets(parsed.snippets, (p) => setProgress(p));
      allErrors.push(...snippetErrors);

      const { imported: chaptersImported, errors: chapterErrors } =
        await importChapters(parsed.chapters, (p) => setProgress(p));
      allErrors.push(...chapterErrors);

      const { imported: chatsImported, errors: chatErrors } =
        await importChatSessionsBatch(parsed.chatSessions, (p) =>
          setProgress(p),
        );
      allErrors.push(...chatErrors);

      setErrors(allErrors);
      setPhase("done");

      await reloadCodex();
      await reloadSnippets();
      await reloadTree(getCurrentProjectId());
      await reloadSessions(getCurrentProjectId());

      toast.success(
        t("import.success", {
          codex: codexImported,
          snippets: snippetsImported,
          chapters: chaptersImported,
          chats: chatsImported,
        }),
      );
    },
    [parsed, t, reloadCodex, reloadSnippets, reloadTree, reloadSessions],
  );

  /** Called from preview "Import" button */
  const handlePreviewImport = useCallback(() => {
    if (!parsed) return;
    if (allTagNames.length === 0) {
      void runImport();
    } else {
      setPhase("tag-mapping");
    }
  }, [parsed, allTagNames.length, runImport]);

  /** Called from tag-mapping "Skip" */
  const handleTagMappingSkip = useCallback(() => {
    void runImport();
  }, [runImport]);

  /** Called from tag-mapping "Next" */
  const handleTagMappingNext = useCallback(() => {
    if (!parsed) return;
    const foundConflicts = computeConflicts(
      parsed.codexEntries,
      tagTypeConfigs,
    );
    if (foundConflicts.length > 0) {
      setConflicts(foundConflicts);
      setConflictResolutions(
        new Map(foundConflicts.map((c) => [c.entryId, c.conflictingTags[0]])),
      );
      setPhase("conflict-resolution");
    } else {
      void runImport({
        tagTypeMap: tagTypeConfigs,
        conflictResolutions: new Map(),
      });
    }
  }, [parsed, tagTypeConfigs, runImport]);

  /** Called from conflict-resolution "Import" */
  const handleConflictImport = useCallback(() => {
    void runImport({ tagTypeMap: tagTypeConfigs, conflictResolutions });
  }, [tagTypeConfigs, conflictResolutions, runImport]);

  const handleClose = useCallback(() => {
    setPhase("idle");
    setParsed(null);
    setProgress(null);
    setErrors([]);
    setAllTagNames([]);
    setTagTypeConfigs(new Map());
    setConflicts([]);
    setConflictResolutions(new Map());
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    }
  }, [open]);

  return (
    <AnimatedOverlay
      open={open}
      onClose={handleClose}
      className="flex w-[520px] flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-xl outline-none"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        tabIndex={-1}
        className="contents"
      >
        <h2 id="import-dialog-title" className="text-base font-semibold">
          {t("import.dialogTitle")}
        </h2>

        {/* Dropzone — shown in idle/preview */}
        {(phase === "idle" || phase === "preview") && (
          <>
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
            <p className="text-xs text-muted-foreground">
              {t("import.bodyMarkdownOnly")}
            </p>
            <p className="text-xs font-medium text-destructive">
              {t("import.untrustedSourceWarning")}
            </p>
          </>
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
              <li>
                {t("import.chapters")}: {parsed.chapters.length}
                {parsed.chapters.length > 0 &&
                  ` (${t("import.scenes")}: ${parsed.chapters.reduce(
                    (sum, c) => sum + c.scenes.length,
                    0,
                  )})`}
              </li>
              <li>
                {t("import.chats")}: {parsed.chatSessions.length}
              </li>
            </ul>
          </div>
        )}

        {/* Tag mapping */}
        {phase === "tag-mapping" && (
          <TagMappingSection
            allTagNames={allTagNames}
            tagTypeConfigs={tagTypeConfigs}
            existingTypes={existingTypes}
            onConfigChange={(name, action) =>
              setTagTypeConfigs((prev) => new Map(prev).set(name, action))
            }
            onSkip={handleTagMappingSkip}
            onNext={handleTagMappingNext}
          />
        )}

        {/* Conflict resolution */}
        {phase === "conflict-resolution" && (
          <ConflictResolutionSection
            conflicts={conflicts}
            conflictResolutions={conflictResolutions}
            tagTypeConfigs={tagTypeConfigs}
            existingTypes={existingTypes}
            onResolutionChange={(entryId, tagName) =>
              setConflictResolutions((prev) =>
                new Map(prev).set(entryId, tagName),
              )
            }
            onBack={() => setPhase("tag-mapping")}
            onImport={handleConflictImport}
          />
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

        {/* Buttons — only for phases not handled by sub-components */}
        {phase !== "tag-mapping" &&
          phase !== "conflict-resolution" &&
          phase !== "importing" && (
            <div className="flex justify-end gap-2">
              {phase !== "done" && (
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
                  onClick={handlePreviewImport}
                  className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
                >
                  {t("import.importButton")}
                </button>
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
          )}

        {phase === "importing" && (
          <div className="flex justify-end">
            <span className="text-sm text-muted-foreground">
              {t("import.importing")}
            </span>
          </div>
        )}
      </div>
    </AnimatedOverlay>
  );
}
