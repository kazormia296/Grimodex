import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import {
  useSceneContentStore,
  subscribeLiveContentRafCoalesced,
} from "@/features/editor/sceneContentStore";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { useTrashBinCapture } from "@/features/editor/useTrashBinCapture";
import { useFocusedContentEditorStore } from "@/store/focusedContentEditorStore";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { DocumentKey } from "@/features/editor/document/documentKey";
import {
  createLoadedMiniEditorTimelapseAuthority,
  recordMiniEditorTransaction,
  type LoadedMiniEditorTimelapseAuthority,
} from "@/features/editor/miniEditorTimelapse";
import type { TimelapseDocumentRef } from "@/features/timelapse/documentCoverage";

// Sentinel group index — distinguishes mini-editor updates from pane 0 / pane 1
const CODEX_MINI_GROUP = 99;

interface CodexContentEditorProps {
  content: string;
  onContentChange: (
    content: string,
    timelapseDocument?: TimelapseDocumentRef,
  ) => void;
  entryId?: string;
  /** Project that owns the body actually loaded into this editor instance. */
  projectId?: string;
  /**
   * Canonical live-sync target. `undefined` keeps the legacy entryId-derived
   * target, while `null` explicitly disables live sync (Phase preview).
   */
  liveDocumentKey?: DocumentKey | null;
  /** どのエンティティの本文か。Codex 説明欄以外（Chronicle 出来事の詳細など）でも
   *  Codex ハイライト付きミニエディタとして再利用する。Trash Bin 捕捉と
   *  focusedContentEditorStore 登録は "codex" のときだけ行う（id↔kind 不整合回避）。 */
  entryKind?: "codex" | "chronicle_event";
  /** Called when the EditorPane pushes a change here so the parent can keep its contentRef in sync */
  onExternalSync?: (content: string) => void;
  /** フェーズプレビュー用: 非nullの場合このコンテンツをエディタに適用（読み取り専用） */
  externalContent?: string | null;
  /** カスタムデティール等の短文向け: 1行分の最小高さから内容に応じて成長 */
  compact?: boolean;
  /** 別窓が同一 entry を編集中 → read-only（advisory lock）。 */
  readOnly?: boolean;
}

function parseContent(raw: string): object | "" {
  if (!raw || raw === "{}") return "";
  try {
    return JSON.parse(raw) as object;
  } catch {
    return "";
  }
}

export function CodexContentEditor({
  content,
  onContentChange,
  entryId,
  projectId,
  liveDocumentKey,
  entryKind = "codex",
  onExternalSync,
  externalContent,
  compact = false,
  readOnly = false,
}: CodexContentEditorProps) {
  const isCodexEntry = entryKind === "codex";
  const defaultDocumentKey = useMemo<DocumentKey | null>(() => {
    if (!entryId) return null;
    return entryKind === "codex"
      ? { kind: "codex", id: entryId, phaseId: null }
      : { kind: "chronicle-event", id: entryId };
  }, [entryId, entryKind]);
  const documentKey =
    liveDocumentKey === undefined ? defaultDocumentKey : liveDocumentKey;
  const isApplyingExternalUpdate = useRef(false);
  const loadedTimelapseAuthorityRef =
    useRef<LoadedMiniEditorTimelapseAuthority | null>(null);
  const [loadedTimelapseInstanceKey, setLoadedTimelapseInstanceKey] = useState<
    string | null
  >(null);
  const onExternalSyncRef = useRef(onExternalSync);
  onExternalSyncRef.current = onExternalSync;
  const contentRef = useRef(content);
  contentRef.current = content;

  const spellCheck = useSettingsStore((s) =>
    s.getBoolean("editor.spellCheck", false),
  );

  const parsedContent = parseContent(content);
  const timelapseAuthority = useMemo(() => {
    if (
      !projectId ||
      !isCodexEntry ||
      !entryId ||
      documentKey?.kind !== "codex" ||
      documentKey.id !== entryId ||
      documentKey.phaseId !== null ||
      externalContent != null
    ) {
      return null;
    }
    return createLoadedMiniEditorTimelapseAuthority(projectId, documentKey);
  }, [documentKey, entryId, externalContent, isCodexEntry, projectId]);
  const timelapseInstanceKey = timelapseAuthority
    ? `${timelapseAuthority.projectId}\u0000${timelapseAuthority.documentKey.id}`
    : "disabled";
  const timelapseInstanceKeyRef = useRef(timelapseInstanceKey);
  if (timelapseInstanceKeyRef.current !== timelapseInstanceKey) {
    // The render-time target may advance before TipTap has replaced its
    // document. Revoke old authority synchronously; onCreate publishes the
    // new immutable descriptor only after the new editor owns its content.
    timelapseInstanceKeyRef.current = timelapseInstanceKey;
    loadedTimelapseAuthorityRef.current = null;
  }

  const editor = useEditor(
    {
      extensions: [StarterKit.configure(), AuthorshipMark],
      content: parsedContent,
      onCreate: () => {
        loadedTimelapseAuthorityRef.current = timelapseAuthority;
        setLoadedTimelapseInstanceKey(timelapseInstanceKey);
      },
      onDestroy: () => {
        loadedTimelapseAuthorityRef.current = null;
        setLoadedTimelapseInstanceKey(null);
      },
      onUpdate: ({ editor: e }) => {
        if (isApplyingExternalUpdate.current) return;
        try {
          const json = e.getJSON();
          const serialized = JSON.stringify(json);
          onContentChange(
            serialized,
            loadedTimelapseAuthorityRef.current?.document,
          );
          // Publish to sceneContentStore so the EditorPane tab stays in sync
          if (documentKey) {
            useSceneContentStore
              .getState()
              .setLiveContent(documentKey, json, CODEX_MINI_GROUP);
          }
        } catch {
          // ignore serialization errors
        }
      },
      onTransaction: ({ transaction }) => {
        recordMiniEditorTransaction({
          transaction,
          authority: loadedTimelapseAuthorityRef.current,
          isApplyingExternalUpdate: isApplyingExternalUpdate.current,
        });
      },
    },
    [timelapseInstanceKey],
  );

  useAttribution(editor);
  const loadedFenceDocumentKey =
    loadedTimelapseInstanceKey === timelapseInstanceKey ? documentKey : null;
  const loadedFenceProjectId =
    loadedTimelapseInstanceKey === timelapseInstanceKey
      ? (timelapseAuthority?.projectId ?? null)
      : null;
  useLicenseEditableSync(
    editor,
    readOnly,
    loadedFenceDocumentKey,
    loadedFenceProjectId,
  );
  useCodexHighlight(editor, {
    excludeEntryIds: entryId ? [entryId] : [],
    skipMatchedIds: true,
  });

  // ゴミ箱キャプチャ (副次経路)。externalContent プレビュー中は paused で停止。
  // Codex 説明欄のみ（chronicle 詳細など他用途は id↔kind 不整合になるため除外）。
  useTrashBinCapture(
    editor,
    isCodexEntry && entryId ? { kind: "codex", id: entryId } : null,
    externalContent != null,
  );

  // Trash Bin の挿入ターゲットとして「フォーカス中のミニエディタ」を共有。
  // EditorPane の codex タブが開いているとき主経路はそちらが優先される。
  // Codex 説明欄のみ登録（chronicle 詳細は復元ターゲット対象外）。
  useEffect(() => {
    if (!editor || !entryId || !isCodexEntry) return;
    // テスト等で mock された Editor は on/off を持たないことがあるためガード。
    if (typeof editor.on !== "function") return;
    const handleFocus = () => {
      useFocusedContentEditorStore
        .getState()
        .setCurrent({ kind: "codex", id: entryId }, editor);
    };
    editor.on("focus", handleFocus);
    return () => {
      if (typeof editor.off === "function") editor.off("focus", handleFocus);
    };
  }, [editor, entryId, isCodexEntry]);

  // externalContent（フェーズプレビュー）変化時にエディタ内容を更新
  useEffect(() => {
    if (!editor) return;
    // externalContent が null → base content に戻す
    const target =
      externalContent != null ? externalContent : contentRef.current;
    const parsed = parseContent(target);
    isApplyingExternalUpdate.current = true;
    try {
      editor.commands.setContent(
        parsed as Parameters<typeof editor.commands.setContent>[0],
        { emitUpdate: false },
      );
    } finally {
      isApplyingExternalUpdate.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalContent]);

  // Subscribe to EditorPane updates and apply them to this mini-editor.
  // rAF-coalesced: a typing burst in the source EditorPane collapses to one
  // full-doc setContent per frame (and one JSON.stringify for onExternalSync).
  useEffect(() => {
    if (!documentKey || !editor) return;
    return subscribeLiveContentRafCoalesced(
      documentKey,
      CODEX_MINI_GROUP,
      (next) => {
        isApplyingExternalUpdate.current = true;
        try {
          editor.commands.setContent(
            next as Parameters<typeof editor.commands.setContent>[0],
            { emitUpdate: false },
          );
          const serialized = JSON.stringify(next);
          onExternalSyncRef.current?.(serialized);
        } finally {
          isApplyingExternalUpdate.current = false;
        }
      },
    );
  }, [documentKey, editor]);

  return (
    <>
      <div
        data-testid="codex-content-editor"
        data-compact={compact || undefined}
        // contenteditable は spellcheck 属性を祖先から継承する
        spellCheck={spellCheck}
        className={
          compact
            ? "min-h-[34px] rounded-md border border-input bg-background px-2 py-1.5 text-sm [&_.ProseMirror]:min-h-[1.25rem] [&_.ProseMirror]:outline-none"
            : "min-h-[80px] rounded-md border border-input bg-background px-2 py-1.5 text-sm [&_.ProseMirror]:min-h-[60px] [&_.ProseMirror]:outline-none"
        }
      >
        <EditorContent editor={editor} />
      </div>
      <CodexPopover editor={editor} />
    </>
  );
}
