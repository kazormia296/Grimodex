// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VerticalPreview } from "./VerticalPreview";
import { useEditorStore } from "./editorStore";

function mockEditorWithHtml(html: string) {
  return {
    getHTML: () => html,
    state: { doc: { textContent: "" } },
  } as unknown as ReturnType<typeof useEditorStore.getState>["editor"];
}

describe("VerticalPreview", () => {
  it("renders nothing when closed", () => {
    render(<VerticalPreview open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("vertical-preview-overlay")).toBeNull();
  });

  it("renders overlay when open", () => {
    useEditorStore.setState({ editor: mockEditorWithHtml("<p>テスト</p>") });
    render(<VerticalPreview open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId("vertical-preview-overlay")).toBeDefined();
    expect(screen.getByTestId("vertical-preview-content")).toBeDefined();
  });

  it("displays editor HTML content in vertical preview", () => {
    useEditorStore.setState({
      editor: mockEditorWithHtml("<p>縦書きテスト</p>"),
    });
    render(<VerticalPreview open={true} onClose={vi.fn()} />);
    const content = screen.getByTestId("vertical-preview-content");
    expect(content.innerHTML).toContain("縦書きテスト");
  });

  it("calls onClose when close button is clicked", () => {
    useEditorStore.setState({ editor: mockEditorWithHtml("<p>テスト</p>") });
    const onClose = vi.fn();
    render(<VerticalPreview open={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("has vertical-preview CSS class on content", () => {
    useEditorStore.setState({ editor: mockEditorWithHtml("<p>テスト</p>") });
    render(<VerticalPreview open={true} onClose={vi.fn()} />);
    const content = screen.getByTestId("vertical-preview-content");
    expect(content.classList.contains("vertical-preview")).toBe(true);
  });
});
