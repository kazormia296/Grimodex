// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EdgeContextMenu } from "./EdgeContextMenu";

const baseProps = {
  edgeId: "edge-1",
  screenPosition: { x: 100, y: 100 },
  style: "solid" as const,
  color: "#555555",
  onClose: vi.fn(),
  onStyleChange: vi.fn(),
  onColorChange: vi.fn(),
  onDelete: vi.fn(),
};

describe("EdgeContextMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("線種ボタンをクリックすると onStyleChange が呼ばれてメニューが閉じる", async () => {
    render(<EdgeContextMenu {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /破線/ }));
    expect(baseProps.onStyleChange).toHaveBeenCalledWith("dashed");
    expect(baseProps.onClose).toHaveBeenCalledOnce();
  });

  it("色プリセットをクリックすると onColorChange が呼ばれてメニューが閉じる", async () => {
    render(<EdgeContextMenu {...baseProps} />);
    await userEvent.click(screen.getByTitle("赤"));
    expect(baseProps.onColorChange).toHaveBeenCalledWith("#ef4444");
    expect(baseProps.onClose).toHaveBeenCalledOnce();
  });

  it("削除ボタンをクリックすると onDelete が呼ばれてメニューが閉じる", async () => {
    render(<EdgeContextMenu {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(baseProps.onDelete).toHaveBeenCalledOnce();
    expect(baseProps.onClose).toHaveBeenCalledOnce();
  });

  it("Escape キーで onClose が呼ばれる", async () => {
    render(<EdgeContextMenu {...baseProps} />);
    await userEvent.keyboard("{Escape}");
    expect(baseProps.onClose).toHaveBeenCalledOnce();
  });

  it("メニュー外クリックで onClose が呼ばれる", async () => {
    render(<EdgeContextMenu {...baseProps} />);
    await userEvent.pointer({ target: document.body, keys: "[MouseLeft]" });
    expect(baseProps.onClose).toHaveBeenCalledOnce();
  });

  it("メニュー内クリックは onClose を呼ばない (stopPropagation)", async () => {
    const { container } = render(<EdgeContextMenu {...baseProps} />);
    const menu = container.ownerDocument.body.querySelector(
      ".rounded-md",
    ) as HTMLElement;
    expect(menu).toBeTruthy();
    // Simulate pointerdown on the menu itself — should not close
    const pointerDown = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    menu.dispatchEvent(pointerDown);
    expect(baseProps.onClose).not.toHaveBeenCalled();
  });
});
