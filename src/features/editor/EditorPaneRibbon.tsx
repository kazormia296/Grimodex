import { BookOpen, CalendarDays, Files } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FileBackedSceneBanner } from "@/features/external-mount/components/FileBackedSceneBanner";
import { NoteContextControls } from "@/features/editor/NoteContextControls";
import { ExternalEditConflictBanner } from "@/features/editor/ExternalEditConflictBanner";
import { LicenseRestrictionBanner } from "@/features/license/LicenseRestrictionBanner";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import type {
  DocumentKey,
  EditorInstanceId,
} from "@/features/editor/document/documentKey";

interface CodexRibbonEntry {
  name: string;
}

interface SnippetRibbonEntry {
  title: string;
}

interface EditorPaneRibbonProps {
  nodeId: string;
  isEntryMode: boolean;
  isFileBacked: boolean;
  isNote: boolean;
  isCodexMode: boolean;
  isSnippetMode: boolean;
  isChronicleEventMode: boolean;
  activeCodexEntry: CodexRibbonEntry | null | undefined;
  activeSnippetEntry: SnippetRibbonEntry | null | undefined;
  loadedPhaseLabel: string | null;
  chronicleEventTitle: string;
  documentKey: DocumentKey | null;
  editorInstanceId: EditorInstanceId;
  onKeepExternalEdit?: () => void | Promise<void>;
  onReloadExternalEdit?: () => void | Promise<void>;
}

/** Render-only context banners above the editor body. */
export function EditorPaneRibbon({
  nodeId,
  isEntryMode,
  isFileBacked,
  isNote,
  isCodexMode,
  isSnippetMode,
  isChronicleEventMode,
  activeCodexEntry,
  activeSnippetEntry,
  loadedPhaseLabel,
  chronicleEventTitle,
  documentKey,
  editorInstanceId,
  onKeepExternalEdit,
  onReloadExternalEdit,
}: EditorPaneRibbonProps) {
  const { t } = useTranslation();
  const zenMode = useCursorSettingsStore((state) => state.zenMode);

  if (zenMode) {
    return (
      <>
        <LicenseRestrictionBanner />
        <ExternalEditConflictBanner
          nodeId={nodeId}
          documentKey={documentKey}
          editorInstanceId={editorInstanceId}
          onKeepMine={onKeepExternalEdit}
          onReload={onReloadExternalEdit}
        />
      </>
    );
  }

  return (
    <>
      <LicenseRestrictionBanner />
      {isFileBacked && !isEntryMode && <FileBackedSceneBanner />}
      <ExternalEditConflictBanner
        nodeId={nodeId}
        documentKey={documentKey}
        editorInstanceId={editorInstanceId}
        onKeepMine={onKeepExternalEdit}
        onReload={onReloadExternalEdit}
      />
      {isNote && (
        <div className="flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-600 dark:text-amber-400">
          <span className="font-medium">{t("editor.ribbon.noteEditing")}</span>
          <span className="text-amber-500/60">
            — {t("editor.ribbon.noteDescription")}
          </span>
        </div>
      )}
      {isNote && <NoteContextControls nodeId={nodeId} />}
      {isCodexMode && (
        <div className="flex items-center gap-1.5 border-b border-purple-500/30 bg-purple-500/10 px-3 py-1 text-xs text-purple-600 dark:text-purple-400">
          <span className="flex items-center gap-1 font-medium">
            <BookOpen className="h-3 w-3" aria-hidden />
            {t("editor.ribbon.codexEditing")}
          </span>
          {activeCodexEntry && (
            <span className="text-purple-500/60">
              — {activeCodexEntry.name}
            </span>
          )}
          {loadedPhaseLabel && (
            <span className="ml-auto rounded bg-purple-500/20 px-1.5 py-0.5 font-medium">
              {loadedPhaseLabel}
            </span>
          )}
        </div>
      )}
      {isSnippetMode && (
        <div className="flex items-center gap-1.5 border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-600 dark:text-emerald-400">
          <span className="flex items-center gap-1 font-medium">
            <Files className="h-3 w-3" aria-hidden />
            {t("editor.ribbon.snippetEditing")}
          </span>
          {activeSnippetEntry && (
            <span className="text-emerald-500/60">
              — {activeSnippetEntry.title}
            </span>
          )}
        </div>
      )}
      {isChronicleEventMode && (
        <div className="flex items-center gap-1.5 border-b border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs text-sky-600 dark:text-sky-400">
          <span className="flex items-center gap-1 font-medium">
            <CalendarDays className="h-3 w-3" aria-hidden />
            {t("editor.ribbon.chronicleEditing")}
          </span>
          {chronicleEventTitle && (
            <span className="text-sky-500/60">— {chronicleEventTitle}</span>
          )}
        </div>
      )}
    </>
  );
}
