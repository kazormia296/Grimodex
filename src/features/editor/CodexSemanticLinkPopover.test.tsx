// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexEntry } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { getEditorExtensions } from "./extensions";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { CodexSemanticLinkPopover } from "./CodexSemanticLinkPopover";

const ENTRIES: CodexEntry[] = [
  {
    id: "entry-elara",
    projectId: "project-1",
    parentId: null,
    type: "character",
    name: "エララ",
    summary: "主人公",
    content: "{}",
    icon: null,
    aliases: '["銀の魔女"]',
    excludedAliases: "[]",
    readings: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    version: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "entry-chain",
    projectId: "project-1",
    parentId: null,
    type: "lore",
    name: "束縛",
    summary: "象徴",
    content: "{}",
    icon: null,
    aliases: "[]",
    excludedAliases: "[]",
    readings: null,
    tagsCache: null,
    contextMode: "hidden",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    version: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function makeEditor() {
  const editor = new Editor({
    extensions: getEditorExtensions(),
    content: "<p>銀の魔女と鎖</p>",
  });
  editor.commands.setTextSelection({ from: 1, to: 5 });
  return editor;
}

describe("CodexSemanticLinkPopover", () => {
  beforeEach(() => {
    useCodexStore.setState({
      // The panel list may be filtered; authoring candidates must still cover
      // the whole project through completionTargets.
      entries: [ENTRIES[0]],
      completionTargets: ENTRIES.map(
        ({ id, name, type, aliases, excludedAliases }) => ({
          id,
          name,
          type,
          aliases,
          excludedAliases,
        }),
      ),
      ensureEntriesLoaded: vi.fn().mockResolvedValue(undefined),
    });
    useCursorSettingsStore.setState({ semanticLinkPickerOpen: true });
  });

  afterEach(() => {
    cleanup();
    useCursorSettingsStore.setState({ semanticLinkPickerOpen: false });
  });

  it("links the captured selection to the chosen Codex entry and closes", async () => {
    const editor = makeEditor();
    try {
      render(<CodexSemanticLinkPopover editor={editor} />);
      await userEvent.click(
        screen.getByTestId("semantic-link-entry-entry-elara"),
      );

      expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({
        text: "銀の魔女",
        marks: [
          {
            type: "codexSemanticLink",
            attrs: { entryId: "entry-elara", label: "エララ" },
          },
        ],
      });
      expect(useCursorSettingsStore.getState().semanticLinkPickerOpen).toBe(
        false,
      );
    } finally {
      editor.destroy();
    }
  });

  it("searches names and aliases, including entries hidden from AI context", async () => {
    const editor = makeEditor();
    try {
      render(<CodexSemanticLinkPopover editor={editor} />);
      const input = screen.getByRole("searchbox");
      fireEvent.change(input, { target: { value: "束縛" } });

      expect(
        screen.queryByTestId("semantic-link-entry-entry-elara"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("semantic-link-entry-entry-chain"),
      ).toBeInTheDocument();
    } finally {
      editor.destroy();
    }
  });

  it("removes an existing semantic link without deleting its text", async () => {
    const editor = makeEditor();
    try {
      editor.commands.setMark("codexSemanticLink", {
        entryId: "entry-elara",
        label: "エララ",
      });
      render(<CodexSemanticLinkPopover editor={editor} />);

      await userEvent.click(screen.getByTestId("semantic-link-remove"));

      expect(editor.getText()).toBe("銀の魔女と鎖");
      expect(JSON.stringify(editor.getJSON())).not.toContain(
        "codexSemanticLink",
      );
    } finally {
      editor.destroy();
    }
  });
});
