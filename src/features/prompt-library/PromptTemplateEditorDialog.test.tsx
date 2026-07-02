// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="overlay">{children}</div> : null),
}));

import { PromptTemplateEditorDialog } from "./PromptTemplateEditorDialog";

describe("PromptTemplateEditorDialog", () => {
  it("associates title and content labels with their controls", () => {
    render(
      <PromptTemplateEditorDialog
        heading="テンプレートを編集"
        initialTitle="既存タイトル"
        initialContent="既存本文"
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const title = screen.getByLabelText("タイトル");
    expect(title).toBeInstanceOf(HTMLInputElement);
    expect((title as HTMLInputElement).value).toBe("既存タイトル");

    const content = screen.getByLabelText("本文");
    expect(content).toBeInstanceOf(HTMLTextAreaElement);
    expect((content as HTMLTextAreaElement).value).toBe("既存本文");
  });

  it("submits trimmed title with content", () => {
    const onSubmit = vi.fn();
    render(
      <PromptTemplateEditorDialog
        heading="テンプレートを新規作成"
        initialTitle=""
        initialContent=""
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "  新タイトル  " },
    });
    fireEvent.change(screen.getByLabelText("本文"), {
      target: { value: "指示文" },
    });
    fireEvent.click(screen.getByText("保存"));

    expect(onSubmit).toHaveBeenCalledWith("新タイトル", "指示文");
  });

  it("disables save while title or content is empty", () => {
    render(
      <PromptTemplateEditorDialog
        heading="テンプレートを新規作成"
        initialTitle=""
        initialContent="本文あり"
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("保存").closest("button")).toBeDisabled();
  });
});
