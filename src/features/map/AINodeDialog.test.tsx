// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AINodeDialog } from "./AINodeDialog";

function setup() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <AINodeDialog
      boardId="b1"
      spawnPosition={{ x: 0, y: 0 }}
      seedNodeTitles={[]}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  const textarea = screen.getByPlaceholderText("アイデアを展開してください…");
  fireEvent.change(textarea, { target: { value: "無人駅" } });
  return { onConfirm, onCancel };
}

describe("AINodeDialog — 意外性 (Verbalized Sampling) ノブ", () => {
  it("既定は標準 = VS オフ → onConfirm の vsThreshold は null", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(onConfirm).toHaveBeenCalledWith("無人駅", 5, null);
  });

  it("「意外」を選ぶと vsThreshold=0.1", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "意外" }));
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(onConfirm).toHaveBeenCalledWith("無人駅", 5, 0.1);
  });

  it("「大胆」を選ぶと vsThreshold=0.05", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "大胆" }));
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(onConfirm).toHaveBeenCalledWith("無人駅", 5, 0.05);
  });
});
