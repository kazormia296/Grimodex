// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NodeDeleteDialog } from "./NodeDeleteDialog";

const baseProps = {
  count: 1,
  onDelete: vi.fn(),
  onCancel: vi.fn(),
};

describe("NodeDeleteDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("件数が表示される", () => {
    render(<NodeDeleteDialog {...baseProps} count={3} />);
    expect(screen.getByText(/3件/)).toBeTruthy();
  });

  it("キャンセルボタンで onCancel が呼ばれる", async () => {
    render(<NodeDeleteDialog {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(baseProps.onCancel).toHaveBeenCalledOnce();
  });

  it("「削除」ボタンで onDelete が呼ばれる", async () => {
    render(<NodeDeleteDialog {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(baseProps.onDelete).toHaveBeenCalledOnce();
  });

  it("オーバーレイを直接クリックすると onCancel が呼ばれる", async () => {
    const { container } = render(<NodeDeleteDialog {...baseProps} />);
    const overlay = container.ownerDocument.body.querySelector(
      "[style*='position: fixed']",
    ) as HTMLElement;
    expect(overlay).toBeTruthy();
    await userEvent.pointer({ target: overlay, keys: "[MouseLeft]" });
    expect(baseProps.onCancel).toHaveBeenCalledOnce();
  });

  it("ダイアログ内クリックは onCancel を呼ばない", async () => {
    render(<NodeDeleteDialog {...baseProps} />);
    const heading = screen.getByText(/のノードを削除しますか/);
    await userEvent.click(heading);
    expect(baseProps.onCancel).not.toHaveBeenCalled();
  });
});
