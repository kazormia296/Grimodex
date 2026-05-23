// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VerticalPreview } from "./VerticalPreview";
import { useEditorStore } from "./editorStore";

function mockEditorWithHtml(html: string) {
  return {
    getHTML: () => html,
    getText: () => "",
    isDestroyed: false,
    isInitialized: true,
    on: vi.fn(),
    off: vi.fn(),
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

  it("displays editor HTML content in vertical preview", async () => {
    useEditorStore.setState({
      editor: mockEditorWithHtml("<p>縦書きテスト</p>"),
    });
    render(<VerticalPreview open={true} onClose={vi.fn()} />);
    const content = screen.getByTestId("vertical-preview-content");
    await waitFor(() => {
      expect(content.innerHTML).toContain("縦書きテスト");
    });
  });

  it("calls onClose when close button is clicked", () => {
    useEditorStore.setState({ editor: mockEditorWithHtml("<p>テスト</p>") });
    const onClose = vi.fn();
    render(<VerticalPreview open={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call getHTML while closed", () => {
    const getHTML = vi.fn(() => "<p>fail</p>");
    useEditorStore.setState({
      editor: { getHTML, isDestroyed: false, isInitialized: true } as never,
    });
    render(<VerticalPreview open={false} onClose={vi.fn()} />);
    expect(getHTML).not.toHaveBeenCalled();
  });

  it("falls back to plain text when getHTML throws", async () => {
    useEditorStore.setState({
      editor: {
        getHTML: () => {
          throw new Error("schema not ready");
        },
        getText: () => "fallback text",
        isDestroyed: false,
        isInitialized: true,
        on: vi.fn(),
        off: vi.fn(),
      } as never,
    });
    render(<VerticalPreview open={true} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("vertical-preview-content").innerHTML,
      ).toContain("fallback text");
    });
  });

  it("has vertical-preview CSS class on content", () => {
    useEditorStore.setState({ editor: mockEditorWithHtml("<p>テスト</p>") });
    render(<VerticalPreview open={true} onClose={vi.fn()} />);
    const content = screen.getByTestId("vertical-preview-content");
    expect(content.classList.contains("vertical-preview")).toBe(true);
  });
});
