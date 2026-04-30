// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import type { CodexEntry } from "@/features/codex/api";
import { SceneBeatNode } from "./SceneBeatNode";
import { GeneratedProseBlockNode } from "./GeneratedProseBlockNode";
import { SceneBeatEditorContextProvider } from "./beat/SceneBeatEditorContext";

function makeCodex(partial: Partial<CodexEntry>): CodexEntry {
  return {
    id: partial.id ?? "x",
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
    contextMode: "mentioned",
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

function HostEditor({
  attrs,
  expose,
  sceneId,
}: {
  attrs: Record<string, unknown>;
  expose?: (editor: Editor) => void;
  sceneId?: string;
}) {
  const editor = useEditor({
    extensions: [StarterKit, SceneBeatNode, GeneratedProseBlockNode],
    content: "<p></p>",
  });

  useEffect(() => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertContent({
        type: "sceneBeat",
        attrs: {
          id: "b1",
          collapsed: false,
          beatType: "free",
          pov: null,
          ...attrs,
        },
        content: [{ type: "text", text: "ビート本文" }],
      })
      .run();
    expose?.(editor);
  }, [editor, attrs, expose]);

  const content = <EditorContent editor={editor} data-testid="editor" />;
  if (!sceneId) return content;
  return (
    <SceneBeatEditorContextProvider value={{ sceneId }}>
      {content}
    </SceneBeatEditorContextProvider>
  );
}

describe("SceneBeatNodeView", () => {
  beforeEach(() => {
    useCodexStore.setState({ entries: [] });
  });

  it("renders the header with label and beat type chip", async () => {
    render(<HostEditor attrs={{ beatType: "dialogue" }} />);
    await waitFor(() => {
      expect(screen.getByText("Beat")).toBeTruthy();
    });
    const chip = screen.getByTestId("beat-type-chip");
    expect(chip.textContent).toBe("dialogue");
  });

  it("shows POV chip only when pov attr is set", async () => {
    const { unmount } = render(<HostEditor attrs={{ pov: null }} />);
    await waitFor(() => screen.getByText("Beat"));
    expect(screen.queryByTestId("beat-pov-chip")).toBeNull();
    unmount();

    render(<HostEditor attrs={{ pov: "char-9" }} />);
    await waitFor(() => screen.getByText("Beat"));
    const povChip = screen.getByTestId("beat-pov-chip");
    // No matching codex entry → falls back to id.
    expect(povChip.textContent).toContain("char-9");
  });

  it("resolves POV id to the codex character name when present", async () => {
    useCodexStore.setState({
      entries: [makeCodex({ id: "char-9", name: "朱音" })],
    });
    render(<HostEditor attrs={{ pov: "char-9" }} />);
    await waitFor(() => screen.getByText("Beat"));
    const povChip = screen.getByTestId("beat-pov-chip");
    expect(povChip.textContent).toContain("朱音");
    expect(povChip.textContent).not.toContain("char-9");
  });

  it("Generate button is disabled when no SceneBeatEditorContext provider wraps the editor", async () => {
    render(<HostEditor attrs={{}} />);
    await waitFor(() => screen.getByText("Beat"));
    const btn = screen.getByTestId("beat-generate-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Generate button is enabled when sceneId context is provided", async () => {
    render(<HostEditor attrs={{}} sceneId="scene-1" />);
    await waitFor(() => screen.getByText("Beat"));
    const btn = screen.getByTestId("beat-generate-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("toggling the chevron updates collapsed attr", async () => {
    let editorRef: Editor | null = null;
    render(<HostEditor attrs={{}} expose={(e) => (editorRef = e)} />);
    await waitFor(() => screen.getByText("Beat"));

    const collapseBtn = screen.getByTestId("beat-collapse-toggle");
    expect(collapseBtn.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      await userEvent.click(collapseBtn);
    });

    await waitFor(() =>
      expect(
        screen
          .getByTestId("beat-collapse-toggle")
          .getAttribute("aria-expanded"),
      ).toBe("false"),
    );

    let collapsed: boolean | null = null;
    editorRef!.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") collapsed = !!node.attrs.collapsed;
    });
    expect(collapsed).toBe(true);
  });

  it("⋮ menu opens and Delete-beat-and-prose removes the beat", async () => {
    let editorRef: Editor | null = null;
    render(<HostEditor attrs={{}} expose={(e) => (editorRef = e)} />);
    await waitFor(() => screen.getByText("Beat"));

    await act(async () => {
      await userEvent.click(screen.getByTestId("beat-menu-btn"));
    });

    const deleteAllBtn = await screen.findByTestId(
      "beat-menu-delete-with-prose",
    );
    await act(async () => {
      await userEvent.click(deleteAllBtn);
    });

    let beatCount = 0;
    editorRef!.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") beatCount += 1;
    });
    expect(beatCount).toBe(0);
  });

  it("Convert-to-text replaces the beat with a paragraph", async () => {
    let editorRef: Editor | null = null;
    render(<HostEditor attrs={{}} expose={(e) => (editorRef = e)} />);
    await waitFor(() => screen.getByText("Beat"));

    await act(async () => {
      await userEvent.click(screen.getByTestId("beat-menu-btn"));
    });
    const convertBtn = await screen.findByTestId("beat-menu-convert-to-text");
    await act(async () => {
      await userEvent.click(convertBtn);
    });

    let beatCount = 0;
    editorRef!.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") beatCount += 1;
    });
    expect(beatCount).toBe(0);
    expect(editorRef!.getText()).toContain("ビート本文");
  });
});
