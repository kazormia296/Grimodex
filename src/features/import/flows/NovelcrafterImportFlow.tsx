import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { parseNovelcrafterZip, collectAllTagNames } from "../novelcrafterParser";
import {
  importCodexEntries,
  importSnippets,
  importChapters,
  importChatSessionsBatch,
} from "../importApi";
import type { TagMappingAction, TagImportOptions } from "../importApi";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useChatHistoryStore } from "@/features/chat/chatHistoryStore";
import type { ParseResult } from "../novelcrafterParser";
import type { ImportProgress } from "../importApi";
import { listCodexTypes } from "@/features/codex/typeApi";
import type { CodexType } from "@/features/codex/typeApi";
import { TagMappingSection } from "../TagMappingSection";
import {
  ConflictResolutionSection,
  type EntryConflict,
} from "../ConflictResolutionSection";
import type { ParsedCodexEntry } from "../novelcrafterParser";
import {
  ImportDropzone,
  ImportErrorList,
  ImportProgressBar,
  ImportInputSlot,
  ImportAnalyzingPlaceholder,
  ImportFlowFooter,
} from "../importShared";

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

interface Props {
  onClose: () => void;
}

export function NovelcrafterImportFlow({ onClose }: Props) {
  const { t } = useTranslation();
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

  useEffect(() => {
    if (!parsed) return;
    const names = collectAllTagNames(parsed.codexEntries);
    setAllTagNames(names);
    setTagTypeConfigs(new Map(names.map((n) => [n, { mode: "none" }])));
    void listCodexTypes(getCurrentProjectId()).then(setExistingTypes);
  }, [parsed]);

  const handleFileChange = useCallback(
    async (file: File) => {
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

  const runImport = useCallback(
    async (tagOptions?: TagImportOptions) => {
      if (!parsed) return;
      setPhase("importing");
      setErrors([]);
      const allErrors: string[] = [];
      const { imported: codexImported, errors: codexErrors } =
        await importCodexEntries(parsed.codexEntries, setProgress, tagOptions);
      allErrors.push(...codexErrors);
      const { imported: snippetsImported, errors: snippetErrors } =
        await importSnippets(parsed.snippets, setProgress);
      allErrors.push(...snippetErrors);
      const { imported: chaptersImported, errors: chapterErrors } =
        await importChapters(parsed.chapters, setProgress);
      allErrors.push(...chapterErrors);
      const { imported: chatsImported, errors: chatErrors } =
        await importChatSessionsBatch(parsed.chatSessions, setProgress);
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

  const handlePreviewImport = useCallback(() => {
    if (!parsed) return;
    if (allTagNames.length === 0) void runImport();
    else setPhase("tag-mapping");
  }, [parsed, allTagNames.length, runImport]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {(phase === "idle" || phase === "preview") && (
        <ImportInputSlot>
          <ImportDropzone
            accept=".zip"
            onFile={(f) => void handleFileChange(f)}
          />
          <p className="text-xs text-muted-foreground">
            {t("import.bodyMarkdownOnly")}
          </p>
        </ImportInputSlot>
      )}

      {phase === "analyzing" && <ImportAnalyzingPlaceholder />}

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

      {phase === "tag-mapping" && (
        <TagMappingSection
          allTagNames={allTagNames}
          tagTypeConfigs={tagTypeConfigs}
          existingTypes={existingTypes}
          onConfigChange={(name, action) =>
            setTagTypeConfigs((prev) => new Map(prev).set(name, action))
          }
          onSkip={() => void runImport()}
          onNext={() => {
            if (!parsed) return;
            const foundConflicts = computeConflicts(
              parsed.codexEntries,
              tagTypeConfigs,
            );
            if (foundConflicts.length > 0) {
              setConflicts(foundConflicts);
              setConflictResolutions(
                new Map(
                  foundConflicts.map((c) => [c.entryId, c.conflictingTags[0]]),
                ),
              );
              setPhase("conflict-resolution");
            } else {
              void runImport({
                tagTypeMap: tagTypeConfigs,
                conflictResolutions: new Map(),
              });
            }
          }}
        />
      )}

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
          onImport={() =>
            void runImport({ tagTypeMap: tagTypeConfigs, conflictResolutions })
          }
        />
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

      {phase !== "tag-mapping" &&
        phase !== "conflict-resolution" &&
        phase !== "importing" && (
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
                onClick={handlePreviewImport}
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
