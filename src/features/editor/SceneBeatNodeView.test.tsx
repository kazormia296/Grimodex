// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { SceneBeatNode } from "./SceneBeatNode";

function HostEditor({
  attrs,
  expose,
}: {
  attrs: Record<string, unknown>;
  expose?: (editor: Editor) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit, SceneBeatNode],
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

  return <EditorContent editor={editor} data-testid="editor" />;
}

describe("SceneBeatNodeView", () => {
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
    expect(povChip.textContent).toContain("char-9");
  });

  it("Generate button is disabled in 3b-i", async () => {
    render(<HostEditor attrs={{}} />);
    await waitFor(() => screen.getByText("Beat"));
    const btn = screen.getByTestId("beat-generate-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
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
});
