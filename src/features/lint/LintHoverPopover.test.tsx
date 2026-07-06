// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/react";

import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useLintStore } from "./lintStore";
import type { Diagnostic } from "./types";
import { LintHoverPopover } from "./LintHoverPopover";
import { applyLintFix } from "./lintActions";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("./lintActions", () => ({
  applyLintFix: vi.fn(),
}));

const DIAG: Diagnostic = {
  rule_id: "ra-renyou",
  severity: "warning",
  message: "連用中止が続いています",
  range: { start: 0, end: 4 },
  fix: { label: "読点に置換", replacement: "、", range: { start: 0, end: 4 } },
};

function renderWithSpan() {
  const containerRef = createRef<HTMLDivElement>();
  const editor = {} as Editor;
  render(
    <div ref={containerRef}>
      <span
        data-testid="deco"
        className="lint-deco lint-deco--warning"
        data-lint-rule={DIAG.rule_id}
        data-lint-severity={DIAG.severity}
        data-lint-message={DIAG.message}
      >
        対象
      </span>
      <LintHoverPopover
        editor={editor}
        containerRef={containerRef}
        sceneId="s1"
      />
    </div>,
  );
  return screen.getByTestId("deco");
}

beforeEach(() => {
  vi.clearAllMocks();
  useCursorSettingsStore.setState({ showLint: true });
  useLintStore.setState({ diagnostics: [DIAG] } as never);
});

describe("LintHoverPopover", () => {
  it("Lint 波線をホバーするとルール+メッセージ+Fix ボタンが出る", () => {
    const deco = renderWithSpan();
    fireEvent.mouseOver(deco);
    const popover = screen.getByTestId("lint-hover-popover");
    expect(popover.textContent).toContain("連用中止が続いています");
    expect(popover.textContent).toContain("ra-renyou");
    fireEvent.click(screen.getByText("読点に置換"));
    expect(applyLintFix).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      expect.objectContaining({ rule_id: "ra-renyou" }),
    );
  });

  it("同文言の診断が複数あるときは Fix ボタンを出さない (範囲が曖昧)", () => {
    useLintStore.setState({
      diagnostics: [DIAG, { ...DIAG, range: { start: 10, end: 14 } }],
    } as never);
    const deco = renderWithSpan();
    fireEvent.mouseOver(deco);
    expect(screen.getByTestId("lint-hover-popover")).toBeTruthy();
    expect(screen.queryByText("読点に置換")).toBeNull();
  });

  it("showLint OFF ではホバーしても出ない", () => {
    useCursorSettingsStore.setState({ showLint: false });
    const deco = renderWithSpan();
    fireEvent.mouseOver(deco);
    expect(screen.queryByTestId("lint-hover-popover")).toBeNull();
  });
});
