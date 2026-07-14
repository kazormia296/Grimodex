import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Editor } from "@tiptap/react";
import { BUILTIN_CODEX_TYPES } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { requestOpenInCodex } from "@/features/codex/multiwindow/codexSelectionRouting";
import {
  findMentionedEntries,
  type CodexMatchTarget,
} from "@/features/codex/codexMatcher";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSceneStore } from "@/features/tree/store";
import { useLayoutStore } from "@/features/layout/layoutStore";
import {
  LintDisablePicker,
  selectionFromEditor,
} from "@/features/lint/LintDisablePicker";
import { sanitiseRules } from "@/features/lint/lintDisableWalker";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";
import { useChatStore } from "@/features/chat/chatStore";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import type { ToolbarActions } from "@/features/editor/Toolbar";

interface Position {
  x: number;
  y: number;
}

interface EditorContextMenuProps {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLElement | null>;
  toolbarActionsRef?: React.RefObject<ToolbarActions | null>;
  /** DB-backed sceneだけが明示Codexリンクを作成できる。 */
  canEditCodexSemanticLink?: boolean;
}

/**
 * C-6: Right-click context menu for editor selection.
 * "コデックスに追加" / "スニペットとして保存"
 */
export function EditorContextMenu({
  editor,
  containerRef,
  toolbarActionsRef,
  canEditCodexSemanticLink = false,
}: EditorContextMenuProps) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<Position | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [lintDisableOpen, setLintDisableOpen] = useState(false);
  /**
   * Snapshot of disable presence at context-menu open time. Captured at
   * open rather than recomputed on render so the menu is stable while
   * the user moves the cursor between actions.
   */
  const [disableState, setDisableState] = useState<{
    hasMark: boolean;
    hasBlockAttr: boolean;
  }>({ hasMark: false, hasBlockAttr: false });
  const menuRef = useRef<HTMLDivElement>(null);

  const [hasAuthorship, setHasAuthorship] = useState(false);
  /**
   * 単一の Codex 項目にだけマッチする選択時、その対象を保持する。
   * 「除外エイリアスとして登録」項目を出すかどうかの判定に使う。
   */
  const [singleMatchedCodex, setSingleMatchedCodex] =
    useState<CodexMatchTarget | null>(null);

  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const codexCreate = useCodexStore((s) => s.create);
  const snippetCreate = useSnippetStore((s) => s.create);
  const snippetEntries = useSnippetStore((s) => s.entries);
  const loadSnippets = useSnippetStore((s) => s.loadEntries);
  const incrementSnippetUsage = useSnippetStore((s) => s.incrementUsageCount);
  const showAttribution = useAttributionStore((s) => s.showAttribution);
  const setPendingLookupText = useChatStore((s) => s.setPendingLookupText);
  const chatGate = useAiGate("chat");
  const openForeshadowPicker = useCursorSettingsStore(
    (s) => s.openForeshadowPicker,
  );
  const setSemanticLinkPickerOpen = useCursorSettingsStore(
    (s) => s.setSemanticLinkPickerOpen,
  );

  const [snippetPickerPos, setSnippetPickerPos] = useState<Position | null>(
    null,
  );
  const [snippetSearch, setSnippetSearch] = useState("");
  const snippetPickerRef = useRef<HTMLDivElement>(null);

  const filteredSnippets = useMemo(() => {
    const q = snippetSearch.trim().toLowerCase();
    if (!q) return snippetEntries.slice(0, 50);
    return snippetEntries
      .filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.content.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [snippetEntries, snippetSearch]);

  const close = useCallback(() => {
    setPos(null);
  }, []);

  // Context menu handler
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !editor) return;

    function onContextMenu(e: MouseEvent) {
      if (!editor) return;
      e.preventDefault();

      const sel = editor.state.selection;
      const text = sel.empty
        ? ""
        : editor.state.doc.textBetween(sel.from, sel.to, " ");

      const disableSnapshot = detectDisableAtSelection(editor);
      const authorshipSnapshot = detectAuthorshipAtSelection(editor);

      const trimmed = text.trim();
      let single: CodexMatchTarget | null = null;
      if (trimmed.length > 0 && trimmed.length <= 200) {
        const entries = useCodexStore.getState().entries as CodexMatchTarget[];
        const matches = findMentionedEntries(text, entries);
        if (matches.length === 1) single = matches[0];
      }

      setSelectedText(text);
      setDisableState(disableSnapshot);
      setHasAuthorship(authorshipSnapshot);
      setSingleMatchedCodex(single);
      setPos({ x: e.clientX, y: e.clientY });
    }

    container.addEventListener("contextmenu", onContextMenu);
    return () => container.removeEventListener("contextmenu", onContextMenu);
  }, [editor, containerRef]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!pos) return;

    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pos, close]);

  // Snippet picker: close on outside click / Escape
  useEffect(() => {
    if (!snippetPickerPos) return;

    function onMouseDown(e: MouseEvent) {
      if (
        snippetPickerRef.current &&
        !snippetPickerRef.current.contains(e.target as Node)
      ) {
        setSnippetPickerPos(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSnippetPickerPos(null);
    }

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [snippetPickerPos]);

  const handleAddToCodex = async () => {
    close();
    const entry = await codexCreate({
      type: BUILTIN_CODEX_TYPES[0],
      name: selectedText.trim().slice(0, 60),
      summary: "",
    });
    if (entry) {
      void requestOpenInCodex(entry.id);
    }
  };

  const handleRegisterExcludedAlias = async () => {
    close();
    const target = singleMatchedCodex;
    const trimmed = selectedText.trim();
    if (!target || !trimmed) return;

    const current = useCodexStore
      .getState()
      .entries.find((e) => e.id === target.id);
    if (!current) return;

    let existing: string[] = [];
    try {
      const parsed = JSON.parse(current.excludedAliases ?? "[]");
      if (Array.isArray(parsed)) existing = parsed as string[];
    } catch {
      existing = [];
    }

    if (existing.includes(trimmed)) {
      toast.info(t("editor.contextMenu.excludedAliasAlreadyExists"));
      return;
    }

    await useCodexStore.getState().update(target.id, {
      excludedAliases: JSON.stringify([...existing, trimmed]),
    });
    toast.success(
      t("editor.contextMenu.excludedAliasRegistered", { name: target.name }),
    );
  };

  const handleSaveAsSnippet = () => {
    close();
    snippetCreate({
      title: selectedText.trim().slice(0, 30),
      content: selectedText,
      sceneId: activeSceneId || undefined,
    });
  };

  const handleLintDisable = () => {
    close();
    setLintDisableOpen(true);
  };

  const handleLintUnset = () => {
    close();
    if (!editor) return;
    unsetDisableAtSelection(editor);
  };

  const handleCut = () => {
    close();
    document.execCommand("cut");
  };

  const handleCopy = () => {
    close();
    document.execCommand("copy");
  };

  const handlePaste = () => {
    close();
    document.execCommand("paste");
  };

  const handleSelectAll = () => {
    close();
    editor?.commands.selectAll();
  };

  const handleLookUpInChat = () => {
    close();
    useLayoutStore.getState().showPanel("chat");
    setPendingLookupText(selectedText);
  };

  const handleAddComment = () => {
    close();
    useCursorSettingsStore.getState().setCommentPickerOpen(true);
  };

  const handleOpenSemanticLinkPicker = () => {
    close();
    setSemanticLinkPickerOpen(true, editor);
  };

  const handleRequestForeshadow = () => {
    close();
    openForeshadowPicker("payoff");
  };

  const handleRegisterForeshadow = () => {
    close();
    openForeshadowPicker("setup");
  };

  const handleDesignatePayoff = () => {
    close();
    openForeshadowPicker("payoff-unanchored");
  };

  const handleInsertSceneBreak = () => {
    close();
    editor?.chain().focus().insertSceneBreak().run();
  };

  const handleSetRuby = () => {
    close();
    toolbarActionsRef?.current?.openRuby();
  };

  const handleOpenSnippetPicker = () => {
    if (!pos) return;
    setSnippetPickerPos(pos);
    setSnippetSearch("");
    setPos(null);
    void loadSnippets();
  };

  const handleInsertSnippet = (snippetId: string) => {
    const snippet = snippetEntries.find((s) => s.id === snippetId);
    if (!snippet) {
      setSnippetPickerPos(null);
      return;
    }
    const source = (snippet.contentSource as "ai" | "human") ?? "human";
    const success = useEditorStore
      .getState()
      .insertFromSnippet(
        snippet.id,
        snippet.content,
        source,
        null,
        undefined,
        snippet.sourceChatMessageId,
      );
    if (success) {
      void incrementSnippetUsage(snippet.id);
      toast.success(t("snippets.inserted"));
    }
    setSnippetPickerPos(null);
  };

  const handleAttributionOverride = (newSource: AuthorshipSource) => {
    close();
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const authorshipType = editor.schema.marks["authorship"];
    if (!authorshipType) return;
    const mark = authorshipType.create({
      source: newSource,
      manualOverride: true,
      timestamp: new Date().toISOString(),
    });
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.addMark(from, to, mark);
        return true;
      })
      .run();
  };

  // Hide the "選択範囲で Lint ルールを無効化" entry when there is no
  // real text selection (cursor-only right-click meant to unset).
  const canSetDisable = selectedText.trim().length > 0;
  const canUnsetDisable = disableState.hasMark || disableState.hasBlockAttr;
  const canOverrideAttribution =
    showAttribution && hasAuthorship && selectedText.trim().length > 0;

  const lintPickerSelection =
    lintDisableOpen && editor ? selectionFromEditor(editor) : null;

  const snippetPickerNode =
    snippetPickerPos &&
    createPortal(
      <div
        ref={snippetPickerRef}
        className="fixed z-50 flex w-72 flex-col rounded-md border border-border bg-popover shadow-md"
        style={{
          left: Math.min(snippetPickerPos.x, window.innerWidth - 288 - 8),
          top: snippetPickerPos.y,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="text"
          value={snippetSearch}
          onChange={(e) => setSnippetSearch(e.target.value)}
          placeholder={t("editor.contextMenu.searchSnippet")}
          aria-label={t("editor.contextMenu.searchSnippet")}
          className="m-2 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="max-h-64 overflow-y-auto pb-1">
          {filteredSnippets.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t("editor.contextMenu.noSnippet")}
            </div>
          ) : (
            filteredSnippets.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleInsertSnippet(s.id)}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="truncate font-medium">{s.title}</span>
                <span className="line-clamp-1 text-[10px] text-muted-foreground">
                  {s.content.slice(0, 80)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>,
      document.body,
    );

  if (!pos && !lintDisableOpen) return snippetPickerNode || null;

  if (!pos) {
    // Menu already closed, picker still open.
    return (
      <>
        {lintPickerSelection && editor ? (
          <LintDisablePicker
            editor={editor}
            selection={lintPickerSelection}
            onClose={() => setLintDisableOpen(false)}
          />
        ) : null}
        {snippetPickerNode}
      </>
    );
  }

  // Adjust position to stay within viewport
  const menuWidth = 220;
  const x = Math.min(pos.x, window.innerWidth - menuWidth - 8);
  const y = pos.y;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, minWidth: menuWidth }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col py-1">
        {/* Selection preview */}
        {selectedText.trim().length > 0 && (
          <div className="px-3 py-1 text-xs text-muted-foreground truncate border-b border-border mb-1">
            「{selectedText.slice(0, 30)}
            {selectedText.length > 30 ? "…" : ""}」
          </div>
        )}

        {/* Clipboard */}
        {canSetDisable && (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
            onClick={handleCut}
          >
            {t("editor.contextMenu.cut")}
          </button>
        )}
        {canSetDisable && (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
            onClick={handleCopy}
          >
            {t("editor.contextMenu.copy")}
          </button>
        )}
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
          onClick={handlePaste}
        >
          {t("editor.contextMenu.paste")}
        </button>
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
          onClick={handleSelectAll}
        >
          {t("editor.contextMenu.selectAll")}
        </button>

        {/* Insert */}
        <div className="my-1 border-t border-border" />
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
          onClick={handleInsertSceneBreak}
        >
          {t("editor.contextMenu.insertSceneBreak")}
        </button>
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
          onClick={handleOpenSnippetPicker}
        >
          {t("editor.contextMenu.insertFromSnippet")}
        </button>

        {/* Selection actions */}
        {canSetDisable && (
          <>
            <div className="my-1 border-t border-border" />
            {toolbarActionsRef && (
              <button
                type="button"
                className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
                onClick={handleSetRuby}
              >
                {t("editor.contextMenu.setRuby")}
              </button>
            )}
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
              onClick={handleAddToCodex}
            >
              {t("editor.contextMenu.addToCodex")}
            </button>
            {canEditCodexSemanticLink && (
              <button
                type="button"
                data-testid="context-semantic-link"
                className="px-3 py-1.5 text-left text-sm hover:bg-primary hover:text-primary-foreground"
                onClick={handleOpenSemanticLinkPicker}
              >
                {t(
                  "editor.contextMenu.semanticLink",
                  "既存の Codex エントリにリンク…",
                )}
              </button>
            )}
            {singleMatchedCodex && (
              <button
                type="button"
                className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
                onClick={handleRegisterExcludedAlias}
              >
                {t("editor.contextMenu.registerAsExcludedAlias", {
                  name: singleMatchedCodex.name,
                })}
              </button>
            )}
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
              onClick={handleSaveAsSnippet}
            >
              {t("editor.contextMenu.saveAsSnippet")}
            </button>
            {/* chat がポリシーで OFF のときは「チャットで調べる」を隠す
                (composer が hide され指す先が無くなるため)。 */}
            {chatGate.presentation !== "hidden" && (
              <button
                type="button"
                className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
                onClick={handleLookUpInChat}
              >
                {t("editor.contextMenu.lookUpInChat")}
              </button>
            )}
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
              onClick={handleAddComment}
            >
              {t("editor.contextMenu.addComment")}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
              onClick={handleRequestForeshadow}
            >
              {t("editor.contextMenu.requestForeshadow")}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
              onClick={handleRegisterForeshadow}
            >
              {t("editor.contextMenu.registerForeshadow")}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
              onClick={handleDesignatePayoff}
            >
              {t("editor.contextMenu.designatePayoff")}
            </button>
          </>
        )}

        {/* Lint */}
        {(canSetDisable || canUnsetDisable) && (
          <div className="my-1 border-t border-border" />
        )}
        {canSetDisable && (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
            onClick={handleLintDisable}
          >
            {t("editor.contextMenu.lintDisable")}
          </button>
        )}
        {canUnsetDisable && (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground text-amber-700 dark:text-amber-400"
            onClick={handleLintUnset}
          >
            {disableState.hasMark && disableState.hasBlockAttr
              ? t("editor.contextMenu.lintUnsetBoth")
              : disableState.hasMark
                ? t("editor.contextMenu.lintUnsetSpan")
                : t("editor.contextMenu.lintUnsetBlock")}
          </button>
        )}

        {/* Attribution override */}
        {canOverrideAttribution && (
          <div data-testid="attribution-override-menu">
            <div className="my-1 border-t border-border" />
            <div className="px-3 py-1 text-xs font-semibold text-muted-foreground">
              {t("attribution.changeAttribution")}
            </div>
            {(
              [
                {
                  value: "human" as AuthorshipSource,
                  label: t("attribution.human"),
                },
                { value: "ai" as AuthorshipSource, label: t("attribution.ai") },
                {
                  value: "unknown" as AuthorshipSource,
                  label: t("attribution.unknown"),
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                data-testid={`override-${opt.value}`}
                className="flex w-full items-center px-3 py-1.5 text-sm text-left hover:bg-primary hover:text-primary-foreground"
                onClick={() => handleAttributionOverride(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

const DISABLE_BLOCK_KINDS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "tableCell",
]);

/**
 * Inspect the current selection (or cursor position) for overlapping
 * `lintDisable` Marks and enclosing blocks carrying a `lintDisabled`
 * attribute. Used to decide whether the right-click menu should offer
 * "Lint 無効化を解除".
 */
function detectDisableAtSelection(editor: Editor): {
  hasMark: boolean;
  hasBlockAttr: boolean;
} {
  const { state } = editor;
  const { from, to } = state.selection;

  let hasMark = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (hasMark) return false;
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name === "lintDisable") {
        const rules = sanitiseRules(m.attrs.rules);
        if (rules) {
          hasMark = true;
          return false;
        }
      }
    }
    return true;
  });

  // Also catch the cursor-at-edge-of-Mark case: when `from === to`,
  // `nodesBetween` iterates zero-width and may skip the Mark. Use
  // `isActive` as a fallback.
  if (!hasMark && from === to && editor.isActive("lintDisable")) {
    hasMark = true;
  }

  let hasBlockAttr = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (hasBlockAttr) return false;
    if (!DISABLE_BLOCK_KINDS.has(node.type.name)) return true;
    const rules = sanitiseRules(node.attrs.lintDisabled);
    if (rules) {
      hasBlockAttr = true;
      return false;
    }
    return true;
  });

  return { hasMark, hasBlockAttr };
}

/**
 * Remove `lintDisable` Marks overlapping the selection AND clear the
 * `lintDisabled` attribute from every enclosing block. One transaction
 * so undo is a single step.
 */
function unsetDisableAtSelection(editor: Editor): void {
  const { state } = editor;
  const { from, to } = state.selection;
  const tr = state.tr;

  // Mark removal — `removeMark` accepts a range; use the full selection,
  // or grow a zero-width cursor into the enclosing Mark range so the
  // whole Span disappears (the design doc says "解除" should clear the
  // entire directive, not split it).
  const markType = state.schema.marks.lintDisable;
  if (markType) {
    let rangeFrom = from;
    let rangeTo = to;
    if (from === to) {
      const $pos = state.doc.resolve(from);
      // Walk outward from cursor to find the Mark boundaries.
      const marks = $pos.marks();
      if (marks.some((m) => m.type === markType)) {
        // Scan forward / backward for the end of the Mark coverage.
        let start = from;
        let end = from;
        while (start > 0) {
          const $p = state.doc.resolve(start - 1);
          if (!$p.marks().some((m) => m.type === markType)) break;
          start--;
        }
        while (end < state.doc.content.size) {
          const $p = state.doc.resolve(end + 1);
          if (!$p.marks().some((m) => m.type === markType)) break;
          end++;
        }
        rangeFrom = start;
        rangeTo = end;
      }
    }
    if (rangeTo > rangeFrom) {
      tr.removeMark(rangeFrom, rangeTo, markType);
    }
  }

  // Block attr removal — for each enclosing block inside the selection
  // (or containing the cursor), wipe `lintDisabled`.
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!DISABLE_BLOCK_KINDS.has(node.type.name)) return true;
    if (!sanitiseRules(node.attrs.lintDisabled)) return true;
    tr.setNodeMarkup(
      pos,
      undefined,
      { ...node.attrs, lintDisabled: null },
      node.marks,
    );
    return true;
  });

  editor.view.dispatch(tr);
}

function detectAuthorshipAtSelection(editor: Editor): boolean {
  const { state } = editor;
  const { from, to } = state.selection;
  if (from === to) return false;
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.isText && node.marks.some((m) => m.type.name === "authorship")) {
      found = true;
    }
    return true;
  });
  return found;
}
