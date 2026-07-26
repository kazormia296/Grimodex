// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReorderOverlay } from "./ReorderOverlay";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("ReorderOverlay", () => {
  const units = [
    { from: 0, to: 2, surface: "A。" },
    { from: 2, to: 4, surface: "B。" },
  ];

  it("確定/キャンセルボタンを表示する", () => {
    render(
      <ReorderOverlay
        open
        units={units}
        order={[0, 1]}
        onOrderChange={vi.fn()}
        granularity="sentence"
        onGranularityChange={vi.fn()}
        loading={false}
        errorMessage={null}
        canConfirm
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        bunsetsuAvailable
        phraseAvailable={false}
        wordAvailable={false}
      />,
    );
    expect(screen.getByText("editor.reorder.confirm")).toBeTruthy();
    expect(screen.getByText("editor.reorder.cancel")).toBeTruthy();
  });

  it("キャンセルで onCancel が呼ばれる", () => {
    const onCancel = vi.fn();
    render(
      <ReorderOverlay
        open
        units={units}
        order={[0, 1]}
        onOrderChange={vi.fn()}
        granularity="sentence"
        onGranularityChange={vi.fn()}
        loading={false}
        errorMessage={null}
        canConfirm
        onConfirm={vi.fn()}
        onCancel={onCancel}
        bunsetsuAvailable
        phraseAvailable={false}
        wordAvailable={false}
      />,
    );
    fireEvent.click(screen.getByText("editor.reorder.cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
