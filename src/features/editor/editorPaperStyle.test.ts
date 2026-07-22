import { describe, expect, it } from "vitest";
import { buildEditorPaperStyle } from "./editorPaperStyle";

describe("buildEditorPaperStyle", () => {
  it("exposes only a paper fill and edge fade while keeping glyphs untouched", () => {
    const style = buildEditorPaperStyle({
      enabled: true,
      opacity: 35,
      edgeFade: 12,
    });

    expect(style.backgroundColor).toBe("transparent");
    expect(style["--editor-paper-fill" as keyof typeof style]).toBe(
      "color-mix(in oklch, var(--content-background) 35%, transparent)",
    );
    expect(style["--editor-paper-edge-fade" as keyof typeof style]).toBe("12%");
    expect(style).not.toHaveProperty("backgroundImage");
    expect(style).not.toHaveProperty("backdropFilter");
    expect(style).not.toHaveProperty("opacity");
    expect(style).not.toHaveProperty("color");
    expect(style).not.toHaveProperty("filter");
  });

  it.each([
    [-10, 0],
    [0, 0],
    [100, 100],
    [140, 100],
  ])("clamps %s to %s percent", (input, expected) => {
    expect(
      buildEditorPaperStyle({
        enabled: true,
        opacity: input,
        edgeFade: 8,
      })[
        "--editor-paper-fill" as keyof ReturnType<typeof buildEditorPaperStyle>
      ],
    ).toContain(` ${expected}%, transparent`);
  });

  it.each([
    [-10, 0],
    [0, 0],
    [30, 30],
    [80, 30],
  ])("clamps edge fade %s to %s percent", (input, expected) => {
    const style = buildEditorPaperStyle({
      enabled: true,
      opacity: 100,
      edgeFade: input,
    });

    expect(style["--editor-paper-edge-fade" as keyof typeof style]).toBe(
      `${expected}%`,
    );
  });

  it("restores an opaque edge-to-edge paper when the ambient background is off", () => {
    const style = buildEditorPaperStyle({
      enabled: false,
      opacity: 20,
      edgeFade: 18,
    });

    expect(style["--editor-paper-fill" as keyof typeof style]).toContain(
      " 100%, transparent",
    );
    expect(style["--editor-paper-edge-fade" as keyof typeof style]).toBe("0%");
  });
});
