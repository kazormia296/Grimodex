// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SceneLinkModeDialog } from "./SceneLinkModeDialog";

function setup() {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <SceneLinkModeDialog
      sceneTitle="社が燃えた夜"
      onChoose={onChoose}
      onCancel={onCancel}
    />,
  );
  return { ...utils, onChoose, onCancel };
}

describe("SceneLinkModeDialog", () => {
  it("タイトルにシーン名を差し込む", () => {
    const { getByTestId } = setup();
    expect(getByTestId("link-mode-dialog").textContent).toContain(
      "社が燃えた夜",
    );
  });

  it("イベント優先/シーン優先で onChoose(mode) を呼ぶ", () => {
    const { getByTestId, onChoose } = setup();
    fireEvent.click(getByTestId("link-mode-dialog-event"));
    expect(onChoose).toHaveBeenCalledWith("event");
    fireEvent.click(getByTestId("link-mode-dialog-scene"));
    expect(onChoose).toHaveBeenCalledWith("scene");
  });

  it("キャンセルボタンで onCancel", () => {
    const { getByTestId, onCancel } = setup();
    fireEvent.click(getByTestId("link-mode-dialog-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Esc で onCancel", () => {
    const { onCancel } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("背景（overlay 自身）クリックで onCancel、パネル内クリックは無視", () => {
    const { getByTestId, onCancel } = setup();
    const overlay = getByTestId("link-mode-dialog");
    // パネル（role=dialog）クリックは伝播しても overlay 自身が target ではないので無視。
    fireEvent.mouseDown(
      overlay.querySelector('[role="dialog"]') as HTMLElement,
    );
    expect(onCancel).not.toHaveBeenCalled();
    // overlay 自身の mousedown は取り消し。
    fireEvent.mouseDown(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
