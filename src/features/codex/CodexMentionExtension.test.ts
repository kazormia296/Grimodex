// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import type { CodexEntry } from "@/features/codex/api";
import { getEditorExtensions } from "@/features/editor/extensions";
import { createCodexMentionExtension } from "./CodexMentionExtension";

function makeEntry(partial: Partial<CodexEntry>): CodexEntry {
  return {
    id: partial.id ?? "e1",
    projectId: "p1",
    parentId: null,
    type: "character",
    name: partial.name ?? "Untitled",
    aliases: [],
    excludedAliases: [],
    summary: null,
    content: { type: "doc", content: [] },
    icon: null,
    tagsCache: null,
    contextMode: partial.contextMode ?? "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    phaseResolutionMode: "reading",
    aiInstructions: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...partial,
  } as CodexEntry;
}

describe("createCodexMentionExtension — suggestion provider", () => {
  beforeEach(() => {
    useCodexStore.setState({
      entries: [
        makeEntry({ id: "1", name: "ドロシー" }),
        makeEntry({ id: "2", name: "トト" }),
        makeEntry({ id: "3", name: "魔女", contextMode: "hidden" }),
      ],
    });
  });

  it("filters by query and excludes hidden entries", async () => {
    const ext = createCodexMentionExtension(() => undefined);
    const items = await ext.options.suggestion.items!({
      query: "",
      editor: null as never,
    });
    expect(items.map((e: CodexEntry) => e.name)).toEqual(["ドロシー", "トト"]);

    const filtered = await ext.options.suggestion.items!({
      query: "ドロ",
      editor: null as never,
    });
    expect(filtered.map((e: CodexEntry) => e.name)).toEqual(["ドロシー"]);
  });
});

describe("mention role attribute (B-6)", () => {
  it("新規 mention はデフォルトで role=mentioned を持つ", () => {
    const editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    });
    editor.commands.insertContent({
      type: "mention",
      attrs: { id: "1", label: "ドロシー" },
    });
    let role: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") role = node.attrs.role as string;
    });
    expect(role).toBe("mentioned");
    editor.destroy();
  });

  it("role=actor を attrs に指定すると保存される", () => {
    const editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    });
    editor.commands.insertContent({
      type: "mention",
      attrs: { id: "1", label: "ドロシー", role: "actor" },
    });
    let role: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") role = node.attrs.role as string;
    });
    expect(role).toBe("actor");
    editor.destroy();
  });

  it("data-role=target を持つ HTML を parse すると role=target になる", () => {
    const editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    });
    editor.commands.setContent(
      '<p><span data-type="mention" data-id="1" data-label="X" data-role="target">@X</span></p>',
    );
    let role: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") role = node.attrs.role as string;
    });
    expect(role).toBe("target");
    editor.destroy();
  });

  it("data-role なし既存 mention は role=mentioned として解釈される", () => {
    const editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    });
    editor.commands.setContent(
      '<p><span data-type="mention" data-id="1" data-label="Y">@Y</span></p>',
    );
    let role: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") role = node.attrs.role as string;
    });
    expect(role).toBe("mentioned");
    editor.destroy();
  });
});

describe("getEditorExtensions — mention wiring", () => {
  it("does NOT register the mention extension when no setter is provided", () => {
    const editor = new Editor({ extensions: getEditorExtensions() });
    expect(editor.schema.nodes["mention"]).toBeUndefined();
    editor.destroy();
  });

  it("registers the mention extension when setMentionPopup is provided", () => {
    const setPopup = vi.fn();
    const editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: setPopup }),
    });
    expect(editor.schema.nodes["mention"]).toBeDefined();
    expect(editor.schema.nodes["mention"].isInline).toBe(true);
    editor.destroy();
  });

  it("allows mention nodes to be inserted inside a sceneBeat (inline*)", () => {
    const editor = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
      // Stripped-down mention-friendly StarterKit conflict prevention not needed:
      // getEditorExtensions already drops StarterKit.paragraph and uses
      // ParagraphWithEmptyLineSupport, and the mention extension has group: 'inline'.
    });

    editor
      .chain()
      .focus()
      .insertContent({
        type: "sceneBeat",
        attrs: { id: "b1", beatType: "free", pov: null, collapsed: false },
        content: [
          { type: "text", text: "雨の夜、" },
          { type: "mention", attrs: { id: "1", label: "ドロシー" } },
          { type: "text", text: "が立ち止まる。" },
        ],
      })
      .run();

    let mentionAttrs: { id: string; label: string } | null = null;
    let parentName: string | null = null;
    editor.state.doc.descendants((node, _pos, parent) => {
      if (node.type.name === "mention") {
        mentionAttrs = { id: node.attrs.id, label: node.attrs.label };
        parentName = parent?.type.name ?? null;
      }
    });
    expect(mentionAttrs).toEqual({ id: "1", label: "ドロシー" });
    expect(parentName).toBe("sceneBeat");
    editor.destroy();
  });
});
