import { describe, expect, it } from "vitest";
import { buildEditorPaperStyle } from "./editorPaperStyle";

describe("buildEditorPaperStyle", () => {
  it("changes only the paper background alpha and never text opacity", () => {
    const style = buildEditorPaperStyle(35);

    expect(style.background).toBe(
      "color-mix(in oklch, var(--content-background) 35%, transparent)",
    );
    expect(style).not.toHaveProperty("opacity");
    expect(style).not.toHaveProperty("color");
  });

  it.each([
    [-10, 0],
    [0, 0],
    [100, 100],
    [140, 100],
  ])("clamps %s to %s percent", (input, expected) => {
    expect(buildEditorPaperStyle(input).background).toContain(
      ` ${expected}%, transparent`,
    );
  });
});
