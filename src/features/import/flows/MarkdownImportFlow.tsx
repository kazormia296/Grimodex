import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openFolderDialog } from "@/lib/dialog";
import {
  parseMarkdownSingle,
  parseMarkdownZip,
  parseMarkdownMulti,
  countFoldersInTree,
  countScenesInTree,
} from "../markdownParser";
import type { MarkdownParseResult } from "../markdownParser";
import { importChapters, importTree, importProjectMetadata } from "../importApi";
import type { ImportProgress } from "../importApi";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getProject } from "@/features/project/api";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  ImportDropzone,
  ImportErrorList,
  ImportProgressBar,
  MetadataApplyPanel,
  type SimpleImportPhase,
  ImportInputSlot,
  ImportAnalyzingPlaceholder,
  ImportFlowFooter,
} from "../importShared";

import type { MarkdownImportMode } from "../importTypes";

interface Props {
  onClose: () => void;
}

async function readDirRecursive(
  dirPath: string,
  basePath: string,
): Promise<{ relPath: string; content: string }[]> {
  const { readDir, readTextFile } = await import("@tauri-apps/plugin-fs");
  const entries = await readDir(dirPath);
  const files: { relPath: string; content: string }[] = [];

  for (const entry of entries) {
    const fullPath = `${dirPath}/${entry.name}`.replace(/\/+/g, "/");
    if (entry.isDirectory) {
      files.push(...(await readDirRecursive(fullPath, basePath)));
    } else if (
      entry.name.endsWith(".md") ||
      entry.name.endsWith(".markdown")
    ) {
      const content = await readTextFile(fullPath);
      const relPath = fullPath.slice(basePath.length + 1);
      files.push({ relPath, content });
    }
  }
  return files;
}

export function MarkdownImportFlow({ onClose }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<MarkdownImportMode>("single");
  const [phase, setPhase] = useState<SimpleImportPhase>("idle");
  const [parsed, setParsed] = useState<MarkdownParseResult | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [applyMetadata, setApplyMetadata] = useState(false);
  const [outlineMode, setOutlineMode] = useState<
    "overwrite" | "append" | "skip"
  >("skip");
  const [hasExistingOutline, setHasExistingOutline] = useState(false);

  const reloadTree = useTreeStore((s) => s.loadTree);

  useEffect(() => {
    void getProject(getCurrentProjectId()).then((p) => {
      setHasExistingOutline(Boolean(p?.outline?.trim()));
    });
  }, []);

  const showPreview = useCallback((result: MarkdownParseResult) => {
    setParsed(result);
    setPhase("preview");
  }, []);

  const handleSingleFile = useCallback(
    async (file: File) => {
      const name = file.name.toLowerCase();
      if (!name.endsWith(".md") && !name.endsWith(".markdown")) {
        toast.error(t("import.invalidMarkdown"));
        return;
      }
      setPhase("analyzing");
      try {
        const text = await file.text();
        showPreview(parseMarkdownSingle(text));
      } catch {
        toast.error(t("import.invalidMarkdown"));
        setPhase("idle");
      }
    },
    [showPreview, t],
  );

  const handleMultiZip = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".zip")) {
        toast.error(t("import.invalidZip"));
        return;
      }
      setPhase("analyzing");
      try {
        const buffer = await file.arrayBuffer();
        showPreview(parseMarkdownZip(new Uint8Array(buffer)));
      } catch {
        toast.error(t("import.invalidZip"));
        setPhase("idle");
      }
    },
    [showPreview, t],
  );

  const handleFolderPick = useCallback(async () => {
    const path = await openFolderDialog();
    if (!path) return;
    setPhase("analyzing");
    try {
      const files = await readDirRecursive(path, path);
      if (files.length === 0) {
        toast.error(t("import.markdown.noFiles"));
        setPhase("idle");
        return;
      }
      showPreview(parseMarkdownMulti(files));
    } catch {
      toast.error(t("import.markdown.folderError"));
      setPhase("idle");
    }
  }, [showPreview, t]);

  const handleWebkitFiles = useCallback(
    async (files: FileList) => {
      setPhase("analyzing");
      try {
        const entries: { relPath: string; content: string }[] = [];
        for (const file of files) {
          if (
            !file.name.endsWith(".md") &&
            !file.name.endsWith(".markdown")
          ) {
            continue;
          }
          const relPath = file.webkitRelativePath || file.name;
          entries.push({ relPath, content: await file.text() });
        }
        if (entries.length === 0) {
          toast.error(t("import.markdown.noFiles"));
          setPhase("idle");
          return;
        }
        showPreview(parseMarkdownMulti(entries));
      } catch {
        toast.error(t("import.invalidMarkdown"));
        setPhase("idle");
      }
    },
    [showPreview, t],
  );

  const runImport = useCallback(async () => {
    if (!parsed) return;
    setPhase("importing");
    setErrors([]);

    if (applyMetadata) {
      try {
        await importProjectMetadata({ title: parsed.projectTitle });
      } catch (err) {
        setErrors([String(err)]);
      }
    }

    const importResult =
      parsed.chapters.length > 0
        ? await importChapters(parsed.chapters, setProgress)
        : await importTree(parsed.tree, setProgress);

    setErrors(importResult.errors);
    setPhase("done");
    await reloadTree(getCurrentProjectId());

    const folders =
      parsed.chapters.length > 0
        ? parsed.chapters.length
        : countFoldersInTree(parsed.tree);
    const scenes =
      parsed.chapters.length > 0
        ? parsed.chapters.reduce((s, c) => s + c.scenes.length, 0)
        : countScenesInTree(parsed.tree);

    toast.success(
      t("import.markdown.success", {
        folders,
        scenes,
        imported: importResult.imported,
      }),
    );
  }, [parsed, applyMetadata, t, reloadTree]);

  const clearLocalState = useCallback(() => {
    setPhase("idle");
    setParsed(null);
    setProgress(null);
    setErrors([]);
  }, []);

  const folderCount =
    parsed && parsed.chapters.length > 0
      ? parsed.chapters.length
      : parsed
        ? countFoldersInTree(parsed.tree)
        : 0;
  const sceneCount =
    parsed && parsed.chapters.length > 0
      ? parsed.chapters.reduce((s, c) => s + c.scenes.length, 0)
      : parsed
        ? countScenesInTree(parsed.tree)
        : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {(phase === "idle" || phase === "preview") && (
        <ImportInputSlot>
          <div
            className="flex shrink-0 gap-1"
            role="tablist"
            aria-label={t("import.markdown.modeLabel")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "single"}
              data-testid="import-markdown-single"
              onClick={() => {
                if (mode === "single") return;
                setMode("single");
                clearLocalState();
              }}
              className={`rounded px-2 py-1 text-xs ${
                mode === "single"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {t("import.markdown.singleFile")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "multi"}
              data-testid="import-markdown-multi"
              onClick={() => {
                if (mode === "multi") return;
                setMode("multi");
                clearLocalState();
              }}
              className={`rounded px-2 py-1 text-xs ${
                mode === "multi"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {t("import.markdown.folderOrZip")}
            </button>
          </div>

          {mode === "single" ? (
            <>
              <ImportDropzone
                accept=".md,.markdown,text/markdown"
                onFile={(f) => void handleSingleFile(f)}
              />
              <p className="text-xs text-muted-foreground">
                {t("import.markdown.headingRule")}
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <ImportDropzone
                accept=".zip"
                hint={t("import.markdown.folderOrZipHint")}
                onFile={(f) => void handleMultiZip(f)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="cursor-pointer rounded border border-border px-3 py-1.5 text-sm hover:bg-accent">
                  {t("import.markdown.pickFolderBrowser")}
                  <input
                    type="file"
                    accept=".md,.markdown"
                    className="hidden"
                    {...({ webkitdirectory: "", multiple: true } as object)}
                    onChange={(e) => {
                      const files = e.target.files;
                      if (files?.length) void handleWebkitFiles(files);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void handleFolderPick()}
                  className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent"
                >
                  {t("import.markdown.pickFolder")}
                </button>
              </div>
            </div>
          )}
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
                {t("import.chapters")}: {folderCount}
              </li>
              <li>
                {t("import.scenes")}: {sceneCount}
              </li>
            </ul>
          </div>
          <MetadataApplyPanel
            applyMetadata={applyMetadata}
            onApplyMetadataChange={setApplyMetadata}
            outlineMode={outlineMode}
            onOutlineModeChange={setOutlineMode}
            hasExistingOutline={hasExistingOutline}
          />
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
