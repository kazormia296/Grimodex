// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ReorderModeHint } from "./ReorderModeHint";
import { useReorderModifierStore } from "./reorderModifierStore";

describe("ReorderModeHint", () => {
  afterEach(() => {
    useReorderModifierStore.setState({ mode: "none", granularity: "sentence" });
  });

  it("does not show the current-unit badge while mode is none", () => {
    useReorderModifierStore.setState({ mode: "none", granularity: "bunsetsu" });
    const { container } = render(<ReorderModeHint />);
    expect(container.textContent).not.toContain("入れ替え単位");
  });

  it("does not show the current-unit badge while mode is alt (paragraph reorder)", () => {
    useReorderModifierStore.setState({ mode: "alt", granularity: "bunsetsu" });
    const { container } = render(<ReorderModeHint />);
    expect(container.textContent).not.toContain("入れ替え単位");
  });

  it("shows character unit label when granularity is character", () => {
    useReorderModifierStore.setState({
      mode: "altShift",
      granularity: "character",
    });
    const { container } = render(<ReorderModeHint />);
    expect(container.textContent).toContain("文字");
  });

  it("shows the current-unit badge only while mode is altShift", () => {
    useReorderModifierStore.setState({
      mode: "altShift",
      granularity: "bunsetsu",
    });
    const { container } = render(<ReorderModeHint />);
    expect(
      container.querySelector('[data-reorder-granularity="bunsetsu"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain("入れ替え単位");
    expect(container.textContent).toContain("文節");
  });
});
