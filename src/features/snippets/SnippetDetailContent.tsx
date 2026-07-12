import { useState, useEffect, useRef, useCallback } from "react";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useTranslation } from "react-i18next";
import {
  Copy,
  Clock,
  Trash2,
  MessageSquare,
  ExternalLink,
  FileText,
  TextCursorInput,
  Sparkles,
  User as UserIcon,
} from "lucide-react";
import { useRevisionStore } from "@/features/revision/revisionStore";
import { createRevision, pruneRevisions } from "@/features/revision/api";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { toast } from "sonner";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { useTrashBinCapture } from "@/features/editor/useTrashBinCapture";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { tiptapContentFromDb } from "@/lib/prosemirror";
import {
  copyWithAttribution,
  handleCopyWithAttribution,
} from "@/lib/clipboardAttribution";
import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";
import type { Snippet } from "./api";
import { useTreeStore } from "@/features/tree/treeStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSnippetStore } from "./snippetStore";
import {
  useSceneContentStore,
  subscribeLiveContentRafCoalesced,
} from "@/features/editor/sceneContentStore";
import { TagSelector } from "@/features/codex/components/TagSelector";
import { TagsChip } from "@/features/codex/components/TagsChip";
import {
  listSnippetEntryTags,
  setSnippetEntryTags,
} from "@/features/codex/tagApi";
import type { CodexTag } from "@/features/codex/tagApi";
import { useFitsInline } from "@/hooks/useFitsInline";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";

interface SnippetDetailContentProps {
  snippet: Snippet;
  onSave: (id: string, data: { title: string; content: string }) => void;
  onDelete: (id: string) => void;
}

// Sentinel group index distinguishing this mini-editor from EditorPane (0/1)
// and the Codex mini-editor (99) when broadcasting through sceneContentStore.
const SNIPPET_MINI_GROUP = 98;

const SOURCE_ICON = {
  ai: Sparkles,
  human: UserIcon,
  unknown: FileText,
} as const;

export function SnippetDetailContent({
  snippet,
  onSave,
  onDelete,
}: SnippetDetailContentProps) {
  const { t } = useTranslation();
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const insertFromSnippet = useEditorStore((s) => s.insertFromSnippet);
  const incrementUsageCount = useSnippetStore((s) => s.incrementUsageCount);
  const { shouldAutoRevision, recordAutoRevision } = useRevisionStore();
  const spellCheck = useSettingsStore((s) =>
    s.getBoolean("editor.spellCheck", false),
  );

  const [title, setTitle] = useState(snippet.title);
  const [selectedTags, setSelectedTags] = useState<CodexTag[]>([]);

  const titleRef = useRef(title);
  titleRef.current = title;

  // Suppress the "update" handler (autosave + broadcast) when content is being
  // written into the editor programmatically — either from a `snippet` prop
  // refresh or from a sceneContentStore broadcast — so we don't re-broadcast
  // our own echo or schedule a no-op autosave loop.
  const isApplyingExternalUpdate = useRef(false);

  const editor = useEditor({
    extensions: [StarterKit.configure(), AuthorshipMark],
    content: tiptapContentFromDb(snippet.content),
  });

  useAttribution(editor);
  useLicenseEditableSync(editor);
  useCodexHighlight(editor, { skipMatchedIds: true });
  useTrashBinCapture(editor, { kind: "snippet", id: snippet.id });

  // Load relational tags when snippet changes
  useEffect(() => {
    listSnippetEntryTags(snippet.id).then(setSelectedTags);
  }, [snippet.id]);

  // Sync form when snippet changes (e.g. parent re-renders with refreshed
  // store data after our own autosave). Note: SnippetPanel keys this component
  // by snippet.id so id-changes trigger a remount instead — this effect only
  // fires for in-place title/content prop refreshes.
  useEffect(() => {
    setTitle(snippet.title);
    isApplyingExternalUpdate.current = true;
    try {
      editor?.commands.setContent(tiptapContentFromDb(snippet.content), {
        emitUpdate: false,
      });
    } finally {
      isApplyingExternalUpdate.current = false;
    }
  }, [snippet.id, snippet.title, snippet.content, editor]);

  // Auto-save on editor content change + live-broadcast to sceneContentStore
  // so an open EditorPane snippet tab reflects edits within a frame instead
  // of waiting for the 2-second autosave + store refresh round trip.
  useEffect(() => {
    if (!editor) return;
    const handleUpdate = () => {
      if (isApplyingExternalUpdate.current) return;
      scheduleAutoSave();
      try {
        useSceneContentStore
          .getState()
          .setLiveContent(snippet.id, editor.getJSON(), SNIPPET_MINI_GROUP);
      } catch {
        // ignore serialization errors
      }
    };
    editor.on("update", handleUpdate);
    return () => {
      editor.off("update", handleUpdate);
    };
  });

  // Receive live updates from the EditorPane snippet tab so typing there
  // shows up here in real time. Mirrors CodexContentEditor's pattern.
  // rAF-coalesced: source-side typing bursts collapse to one apply per frame.
  useEffect(() => {
    if (!editor) return;
    return subscribeLiveContentRafCoalesced(
      snippet.id,
      SNIPPET_MINI_GROUP,
      (next) => {
        isApplyingExternalUpdate.current = true;
        try {
          editor.commands.setContent(
            next as Parameters<typeof editor.commands.setContent>[0],
            { emitUpdate: false },
          );
        } finally {
          isApplyingExternalUpdate.current = false;
        }
      },
    );
  }, [snippet.id, editor]);

  // Autosave via useAutoSave so the unmount-flush guarantees that pending
  // edits are persisted when SnippetPanel swaps to a different entry within
  // the 2-second debounce window (the panel keys this component by
  // snippet.id, so id-change → unmount → flush).
  const { schedule: scheduleAutoSave } = useAutoSave(
    useCallback(async () => {
      const snippetId = snippet.id;
      // Falls back to snippet.content if the editor was already destroyed
      // (defensive — flush should run before TipTap's cleanup, but keep the
      // pre-existing fallback semantic).
      const content = editor?.getHTML() ?? snippet.content;
      onSave(snippetId, {
        title: titleRef.current.trim() || snippet.title,
        content,
      });
      try {
        const intervalMs =
          useSettingsStore.getState().getNumber("revision.autoInterval", 5) *
          60 *
          1000;
        if (shouldAutoRevision(snippetId, intervalMs)) {
          const rev = await createRevision({
            entityType: "snippet",
            entityId: snippetId,
            content,
            snapshotType: "auto",
          });
          if (rev) {
            recordAutoRevision(snippetId);
            const keepCount = useSettingsStore
              .getState()
              .getNumber("revision.keepCount", 50);
            pruneRevisions("snippet", snippetId, keepCount).catch(
              console.error,
            );
          }
        }
      } catch (e) {
        debugLog.warn(
          "AutoSave",
          "revision failed (content saved)",
          errorDetail(e),
        );
      }
    }, [
      snippet.id,
      snippet.title,
      snippet.content,
      editor,
      onSave,
      shouldAutoRevision,
      recordAutoRevision,
    ]),
    2000,
  );

  function handleInsertAtCursor() {
    const content = editor?.getHTML() ?? snippet.content;
    const source = (snippet.contentSource as "ai" | "human") ?? "human";
    const success = insertFromSnippet(
      snippet.id,
      content,
      source,
      null,
      undefined,
      snippet.sourceChatMessageId,
    );
    if (success) {
      void incrementUsageCount(snippet.id);
      toast.success(t("snippets.inserted"));
    }
  }

  const tagsFit = useFitsInline();

  const sourceKey: keyof typeof SOURCE_ICON =
    snippet.contentSource === "ai"
      ? "ai"
      : snippet.contentSource === "human"
        ? "human"
        : "unknown";
  const SourceIcon = SOURCE_ICON[sourceKey];
  const sourceLabel =
    sourceKey === "ai"
      ? t("snippets.detail.sourceAi")
      : sourceKey === "human"
        ? t("snippets.detail.sourceHuman")
        : t("snippets.detail.sourceManual");

  return (
    <div data-testid="snippet-detail-content" className="flex h-full flex-col">
      {/* ===== Header (Codex-aligned) ===== */}
      <div className="shrink-0 px-7 pt-3">
        {/* Kicker row: [source-icon + label] ... [insert][copy][scene?][history][delete] */}
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
            <SourceIcon
              className="h-3 w-3 shrink-0 text-muted-foreground/80"
              strokeWidth={2}
            />
            <span>{sourceLabel}</span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              data-testid="snippet-insert-at-cursor"
              onClick={handleInsertAtCursor}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title={t("snippets.detail.insertAtCursor")}
            >
              <TextCursorInput className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="snippet-copy-button"
              onClick={() =>
                copyWithAttribution(
                  editor?.getText() ?? snippet.content,
                  (snippet.contentSource as AuthorshipSource) ?? "human",
                )
              }
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title={t("snippets.contextMenu.copy")}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            {snippet.sceneId && (
              <button
                type="button"
                data-testid="snippet-navigate-to-scene"
                onClick={() => setActiveScene(snippet.sceneId!)}
                className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title={t("snippets.detail.goToScene")}
              >
                <FileText className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              data-testid="snippet-detail-history"
              onClick={() => {
                const content = editor?.getHTML() ?? snippet.content;
                useRevisionStore
                  .getState()
                  .openHistory("snippet", snippet.id, content);
              }}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title={t("editor.status.revisionHistory", "Revision History")}
            >
              <Clock className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="snippet-detail-delete"
              onClick={() => onDelete(snippet.id)}
              className="rounded p-1.5 text-destructive hover:bg-destructive/10"
              title={t("common.delete")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Hero row: title + tags (no avatar column for snippets) */}
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6">
          <div className="min-w-0">
            <input
              data-testid="snippet-detail-title"
              type="text"
              value={title}
              placeholder={t("snippets.detail.titlePlaceholder")}
              onChange={(e) => {
                setTitle(e.target.value);
                scheduleAutoSave();
              }}
              className="-ml-1.5 block w-full rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[26px] font-bold leading-[1.1] tracking-[-0.01em] text-foreground transition-colors hover:bg-accent/40 focus:border-transparent focus:bg-transparent focus:outline-none focus:ring-2 focus:ring-primary"
              style={{ fontFamily: "inherit" }}
            />

            {/* Tags row — individual pills if they fit, otherwise grouped chip */}
            <div
              ref={tagsFit.containerRef}
              data-testid="snippet-detail-tags"
              className="relative mt-2 min-w-0"
            >
              <TagsMeasure
                ref={tagsFit.measureRef}
                tags={selectedTags}
                addLabel={t("codex.tagSelector.addTag")}
              />
              {tagsFit.fits ? (
                <TagSelector
                  entryId={snippet.id}
                  entryType="snippet"
                  selectedTags={selectedTags}
                  onTagsChange={setSelectedTags}
                  persistTags={setSnippetEntryTags}
                />
              ) : (
                <TagsChip
                  entryId={snippet.id}
                  entryType="snippet"
                  selectedTags={selectedTags}
                  onTagsChange={setSelectedTags}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ===== Body ===== */}
      <div
        className="flex-1 space-y-3 overflow-y-auto px-7 py-3"
        onCopy={(e) =>
          handleCopyWithAttribution(
            e,
            (snippet.contentSource as AuthorshipSource) ?? "human",
          )
        }
      >
        <div>
          <div className="mb-1 flex items-center justify-end">
            <button
              type="button"
              data-testid="snippet-open-in-editor"
              onClick={() =>
                openEditorDocument(
                  {
                    target: { kind: "snippet", documentId: snippet.id },
                    mode: "pinned",
                    revealEditor: true,
                    focusEditor: false,
                    syncSceneContext: false,
                  },
                  defaultEditorNavigationPorts,
                )
              }
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
              title={t("snippets.detail.openInEditor")}
            >
              <ExternalLink className="h-3 w-3" />
              {t("snippets.detail.openInEditor")}
            </button>
          </div>
          <div
            className="rounded-md border border-input bg-background p-2"
            // contenteditable は spellcheck 属性を祖先から継承する
            spellCheck={spellCheck}
          >
            <EditorContent editor={editor} />
          </div>
          <CodexPopover editor={editor} />
        </div>

        {/* Metadata */}
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            {t("snippets.detail.createdAt", {
              date: new Date(snippet.createdAt).toLocaleString(),
            })}
          </div>
          <div>
            {t("snippets.detail.usageCount", {
              count: snippet.usageCount ?? 0,
            })}
          </div>
        </div>

        {snippet.sourceChatMessageId && (
          <div
            data-testid="snippet-source-chat-link"
            className="flex items-center gap-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>
              {t("snippets.detail.sourceChat", {
                id: snippet.sourceChatMessageId,
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- measure-only stand-in (mirrors CodexEntryHeader.TagsMeasure) ---------- */

interface TagsMeasureProps {
  ref: React.Ref<HTMLDivElement>;
  tags: CodexTag[];
  addLabel: string;
}

function TagsMeasure({ ref, tags, addLabel }: TagsMeasureProps) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ width: "max-content" }}
      className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap items-center gap-1"
    >
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
        >
          {tag.name}
          <span className="ml-0.5">×</span>
        </span>
      ))}
      <span className="rounded-full border border-dashed px-1.5 py-0.5 text-[10px]">
        {addLabel}
      </span>
    </div>
  );
}
