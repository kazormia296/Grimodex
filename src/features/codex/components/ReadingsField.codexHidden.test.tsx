// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReadingsField } from "./ReadingsField";

// hidden（AI に秘匿）の項目では、読みの「AIで推定」を使えない。読みは作者が手で入れる。

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ReadingsField と hidden の Codex", () => {
  afterEach(() => cleanup());

  it("hidden のときは推定ボタンを無効にし、理由を示して、押しても呼ばない", () => {
    const onEstimate = vi.fn();
    render(
      <ReadingsField
        surfaces={["刹那"]}
        readings={{}}
        onChange={vi.fn()}
        onEstimate={onEstimate}
        estimateBlockedHidden
      />,
    );
    const button = screen.getByTestId("readings-estimate");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "codex.readings.estimateHidden");
    expect(
      screen.getByTestId("readings-estimate-hidden-note"),
    ).toHaveTextContent("codex.readings.estimateHidden");
    fireEvent.click(button);
    expect(onEstimate).not.toHaveBeenCalled();
  });

  it("hidden でないときは従来どおり推定できる", () => {
    const onEstimate = vi.fn();
    render(
      <ReadingsField
        surfaces={["刹那"]}
        readings={{}}
        onChange={vi.fn()}
        onEstimate={onEstimate}
      />,
    );
    const button = screen.getByTestId("readings-estimate");
    expect(button).toBeEnabled();
    expect(
      screen.queryByTestId("readings-estimate-hidden-note"),
    ).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(onEstimate).toHaveBeenCalledTimes(1);
  });
});
