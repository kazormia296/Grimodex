import { describe, it, expect, beforeEach } from "vitest";
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
  beforeEach(() => {
    useEditorStore.setState({ editor: null });
  });

  it("renders toggle button initially", () => {
    render(<VerticalPreview />);
    expect(screen.getByTestId("vertical-preview-toggle")).toBeDefined();
  });

  it("opens preview overlay on click", () => {
    useEditorStore.setState({ editor: mockEditorWithHtml("<p>テスト</p>") });
    render(<VerticalPreview />);

    fireEvent.click(screen.getByTestId("vertical-preview-toggle"));
    expect(screen.getByTestId("vertical-preview-overlay")).toBeDefined();
    expect(screen.getByTestId("vertical-preview-content")).toBeDefined();
  });

  it("displays editor HTML content in vertical preview", () => {
    useEditorStore.setState({
      editor: mockEditorWithHtml("<p>縦書きテスト</p>"),
    });
    render(<VerticalPreview />);

    fireEvent.click(screen.getByTestId("vertical-preview-toggle"));
    const content = screen.getByTestId("vertical-preview-content");
    expect(content.innerHTML).toContain("縦書きテスト");
  });

  it("closes preview when close button is clicked", () => {
    useEditorStore.setState({ editor: mockEditorWithHtml("<p>テスト</p>") });
    render(<VerticalPreview />);

    fireEvent.click(screen.getByTestId("vertical-preview-toggle"));
    expect(screen.getByTestId("vertical-preview-overlay")).toBeDefined();

    fireEvent.click(screen.getByLabelText("閉じる"));
    expect(screen.queryByTestId("vertical-preview-overlay")).toBeNull();
  });

  it("has vertical-preview CSS class on content", () => {
    useEditorStore.setState({ editor: mockEditorWithHtml("<p>テスト</p>") });
    render(<VerticalPreview />);

    fireEvent.click(screen.getByTestId("vertical-preview-toggle"));
    const content = screen.getByTestId("vertical-preview-content");
    expect(content.classList.contains("vertical-preview")).toBe(true);
  });
});
