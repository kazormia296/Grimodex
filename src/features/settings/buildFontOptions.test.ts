import { describe, it, expect } from "vitest";
import { buildFontOptions } from "./buildFontOptions";

const labels = { basicDefault: "Default (serif)", basicMono: "Monospace" };

describe("buildFontOptions", () => {
  it("always exposes the built-in serif/monospace choices first", () => {
    const opts = buildFontOptions({
      systemFonts: [],
      storedValue: "serif",
      labels,
    });
    expect(opts.map((o) => o.value)).toEqual(["serif", "monospace"]);
    expect(opts.every((o) => o.group === "basic")).toBe(true);
  });

  it("maps system fonts into quoted CSS values under the system group", () => {
    const opts = buildFontOptions({
      systemFonts: ["Yu Mincho", "Arial"],
      storedValue: "serif",
      labels,
    });
    const system = opts.filter((o) => o.group === "system");
    expect(system).toEqual([
      { value: '"Yu Mincho"', label: "Yu Mincho", group: "system" },
      { value: '"Arial"', label: "Arial", group: "system" },
    ]);
  });

  it("injects the stored value as a 'current' option when not otherwise present (migration safety)", () => {
    const opts = buildFontOptions({
      systemFonts: ["Arial"],
      storedValue: '"Noto Serif JP", serif',
      labels,
    });
    const current = opts.filter((o) => o.group === "current");
    expect(current).toEqual([
      {
        value: '"Noto Serif JP", serif',
        label: "Noto Serif JP",
        group: "current",
      },
    ]);
    // Injected option must come first so the <select> shows the stored choice.
    expect(opts[0]).toEqual(current[0]);
    // The stored value must be selectable (present in the option set).
    expect(opts.some((o) => o.value === '"Noto Serif JP", serif')).toBe(true);
  });

  it("does NOT inject when the stored value already matches an enumerated system font", () => {
    const opts = buildFontOptions({
      systemFonts: ["Yu Mincho"],
      storedValue: '"Yu Mincho"',
      labels,
    });
    expect(opts.filter((o) => o.group === "current")).toEqual([]);
  });

  it("does NOT inject for the built-in generic values", () => {
    expect(
      buildFontOptions({
        systemFonts: [],
        storedValue: "monospace",
        labels,
      }).filter((o) => o.group === "current"),
    ).toEqual([]);
  });

  it("places bundled fonts above system fonts and dedups system entries that duplicate a bundled family", () => {
    const opts = buildFontOptions({
      systemFonts: ["Noto Serif JP", "Arial"],
      bundledFonts: [
        { family: "Noto Serif JP", label: "Noto Serif JP (同梱)" },
      ],
      storedValue: "serif",
      labels,
    });
    const bundledIdx = opts.findIndex((o) => o.group === "bundled");
    const systemIdx = opts.findIndex((o) => o.group === "system");
    expect(bundledIdx).toBeGreaterThanOrEqual(0);
    expect(bundledIdx).toBeLessThan(systemIdx);
    // "Noto Serif JP" appears once (as bundled), not duplicated in the system group.
    expect(opts.filter((o) => o.value === '"Noto Serif JP"')).toHaveLength(1);
    expect(opts.find((o) => o.value === '"Noto Serif JP"')?.group).toBe(
      "bundled",
    );
  });

  it("derives a clean label from a CSS stack stored value", () => {
    const opts = buildFontOptions({
      systemFonts: [],
      storedValue: "'Hiragino Mincho ProN', serif",
      labels,
    });
    expect(opts[0].label).toBe("Hiragino Mincho ProN");
  });

  it("ignores an empty stored value (no current injection, no crash)", () => {
    const opts = buildFontOptions({
      systemFonts: ["Arial"],
      storedValue: "",
      labels,
    });
    expect(opts.filter((o) => o.group === "current")).toEqual([]);
  });
});
