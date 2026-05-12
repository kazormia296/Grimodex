// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";
import { SceneBeatNode } from "./SceneBeatNode";
import { GeneratedProseBlockNode } from "./GeneratedProseBlockNode";
import { SceneBeatEditorContextProvider } from "./beat/SceneBeatEditorContext";

vi.mock("@/features/ai-policy/useAiCapability", () => ({
  useAiCapability: vi.fn(() => ({ state: "enabled" })),
}));

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
    expect(chip.getAttribute("data-beat-type")).toBe("dialogue");
  });

  it("beat type chip opens dropdown and selecting a type calls updateAttributes", async () => {
    let editorRef: Editor | null = null;
    render(
      <HostEditor
        attrs={{ beatType: "free" }}
        expose={(e) => (editorRef = e)}
      />,
    );
    await waitFor(() => screen.getByText("Beat"));

    const chip = screen.getByTestId("beat-type-chip");
    await act(async () => {
      await userEvent.click(chip);
    });

    // dropdown items should appear
    const dialogueOption = await screen.findByTestId(
      "beat-type-option-dialogue",
    );
    await act(async () => {
      await userEvent.click(dialogueOption);
    });

    await waitFor(() => {
      let beatType: string | null = null;
      editorRef!.state.doc.descendants((node) => {
        if (node.type.name === "sceneBeat")
          beatType = node.attrs.beatType as string;
      });
      expect(beatType).toBe("dialogue");
    });
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

  describe("POV override UI (Slice 7)", () => {
    beforeEach(() => {
      useCodexStore.setState({
        entries: [
          makeCodex({ id: "char-1", name: "花子", type: "character" }),
          makeCodex({ id: "char-2", name: "太郎", type: "character" }),
          makeCodex({ id: "lore-1", name: "設定A", type: "lore" }),
        ],
      });
      // Reset treeStore nodes
      useTreeStore.setState((s) => ({
        ...s,
        nodes: [
          {
            id: "scene-1",
            projectId: "p1",
            parentId: null,
            nodeType: "scene",
            title: "Scene 1",
            sortOrder: "a",
            status: null,
            storyTimeOrder: null,
            storyTimeLabel: null,
            povCharacterId: null,
            locationId: null,
            synopsis: null,
            charCount: 0,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }));
    });

    it("POV ドロップダウンに character 型エントリのみ表示される", async () => {
      render(<HostEditor attrs={{ pov: null }} sceneId="scene-1" />);
      await waitFor(() => screen.getByText("Beat"));

      await act(async () => {
        await userEvent.click(screen.getByTestId("beat-pov-btn"));
      });

      await waitFor(() => {
        expect(screen.getByText("花子")).toBeTruthy();
        expect(screen.getByText("太郎")).toBeTruthy();
      });
      // lore type should not appear in POV list
      expect(screen.queryByText("設定A")).toBeNull();
    });

    it("キャラクターを選択すると attrs.pov が更新される", async () => {
      let editorRef: Editor | null = null;
      render(
        <HostEditor
          attrs={{ pov: null }}
          sceneId="scene-1"
          expose={(e) => (editorRef = e)}
        />,
      );
      await waitFor(() => screen.getByText("Beat"));

      await act(async () => {
        await userEvent.click(screen.getByTestId("beat-pov-btn"));
      });

      await waitFor(() => screen.getByText("花子"));
      await act(async () => {
        await userEvent.click(screen.getByText("花子"));
      });

      await waitFor(() => {
        let pov: string | null = null;
        editorRef!.state.doc.descendants((node) => {
          if (node.type.name === "sceneBeat") pov = node.attrs.pov as string;
        });
        expect(pov).toBe("char-1");
      });
    });

    it("「シーン継承」を選択すると attrs.pov が null に戻る", async () => {
      let editorRef: Editor | null = null;
      render(
        <HostEditor
          attrs={{ pov: "char-1" }}
          sceneId="scene-1"
          expose={(e) => (editorRef = e)}
        />,
      );
      await waitFor(() => screen.getByText("Beat"));

      await act(async () => {
        await userEvent.click(screen.getByTestId("beat-pov-btn"));
      });

      const clearBtn = await screen.findByTestId("beat-pov-clear");
      await act(async () => {
        await userEvent.click(clearBtn);
      });

      await waitFor(() => {
        let pov: string | null | undefined = undefined;
        editorRef!.state.doc.descendants((node) => {
          if (node.type.name === "sceneBeat") pov = node.attrs.pov as string;
        });
        expect(pov).toBeNull();
      });
    });

    it("POV チップはシーン POV と異なる場合のみ表示される", async () => {
      // scene has no POV → attrs.pov set → chip shows
      render(<HostEditor attrs={{ pov: "char-1" }} sceneId="scene-1" />);
      await waitFor(() => screen.getByText("Beat"));
      expect(screen.getByTestId("beat-pov-chip")).toBeTruthy();
    });

    it("beat POV がシーン POV と一致する場合はチップを非表示", async () => {
      // scene POV = char-1, beat POV = char-1 → same → chip hidden
      useTreeStore.setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.id === "scene-1" ? { ...n, povCharacterId: "char-1" } : n,
        ),
      }));
      render(<HostEditor attrs={{ pov: "char-1" }} sceneId="scene-1" />);
      await waitFor(() => screen.getByText("Beat"));
      expect(screen.queryByTestId("beat-pov-chip")).toBeNull();
    });
  });
});
