// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DisplayCategory } from "./DisplayCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("DisplayCategory editor background entry", () => {
  it("opens Background Studio from the Display settings page", () => {
    const onOpenBackgroundStudio = vi.fn();
    render(<DisplayCategory onOpenBackgroundStudio={onOpenBackgroundStudio} />);

    const button = screen.getByRole("button", {
      name: "editor.background.open",
    });
    fireEvent.click(button);

    expect(onOpenBackgroundStudio).toHaveBeenCalledOnce();
  });
});
