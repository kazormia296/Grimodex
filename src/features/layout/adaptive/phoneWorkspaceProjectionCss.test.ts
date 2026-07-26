import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("./phoneWorkspace.css", import.meta.url),
  "utf8",
);

describe("phone editor layer projection CSS", () => {
  it("hard-hides gutter and reorder indicators inside the codex-only projection", () => {
    for (const selector of [
      ".gutter-marks",
      ".lint-disable-gutter",
      ".reorder-block-handle",
    ]) {
      expect(css).toContain(
        `[data-editor-layer-projection="codex-only"] ${selector}`,
      );
    }
    expect(css).toMatch(
      /data-editor-layer-projection="codex-only"[\s\S]*display:\s*none\s*!important/,
    );
  });

  it("neutralizes every non-Codex text decoration without targeting Codex marks", () => {
    for (const selector of [
      ".attribution-ai",
      ".attribution-unknown",
      ".comment-deco",
      ".pe-annotation",
      ".lint-deco",
      "[data-foreshadow-setup]",
      "[data-foreshadow-payoff]",
      ".reorder-unit",
    ]) {
      expect(css).toContain(
        `[data-editor-layer-projection="codex-only"] ${selector}`,
      );
    }
    expect(css).not.toContain(
      '[data-editor-layer-projection="codex-only"] .codex-highlight',
    );
    expect(css).not.toContain(
      '[data-editor-layer-projection="codex-only"] .codex-semantic-link',
    );
  });

  it("keeps the full phone editor canvas transparent", () => {
    expect(css).toMatch(
      /\[data-adaptive-workspace-shell\]\[data-profile="phone"\]\s+\[data-editor-surface\]\s*\{[^}]*background:\s*transparent;/s,
    );
    expect(css).toMatch(
      /\.editor-fluid-glass\.gx-panel--flat\s*\{[^}]*background:\s*transparent;[^}]*background-color:\s*transparent;/s,
    );
  });
});
