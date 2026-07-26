import { describe, expect, it } from "vitest";
import { buildEditorPaperStyle } from "./editorPaperStyle";

describe("buildEditorPaperStyle", () => {
  it("makes the paper fully transparent while the ambient background is on", () => {
    const style = buildEditorPaperStyle({
      enabled: true,
    });

    expect(style.backgroundColor).toBe("transparent");
    expect(style["--editor-paper-fill" as keyof typeof style]).toBe(
      "transparent",
    );
    expect(style).not.toHaveProperty("backgroundImage");
    expect(style).not.toHaveProperty("backdropFilter");
    expect(style).not.toHaveProperty("opacity");
    expect(style).not.toHaveProperty("color");
    expect(style).not.toHaveProperty("filter");
  });

  it("restores an opaque edge-to-edge paper when the ambient background is off", () => {
    const style = buildEditorPaperStyle({
      enabled: false,
    });

    expect(style["--editor-paper-fill" as keyof typeof style]).toBe(
      "var(--content-background)",
    );
  });
});
