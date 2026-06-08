// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

import { LiveRegion } from "./LiveRegion";
import { announce, __resetAnnouncerForTest } from "@/lib/a11y/announcer";
import { expectNoA11yViolations } from "@/test-utils/axe";

describe("LiveRegion", () => {
  beforeEach(() => __resetAnnouncerForTest());

  it("renders polite and assertive live regions", () => {
    const { container } = render(<LiveRegion />);
    const polite = container.querySelector('[aria-live="polite"]');
    const assertive = container.querySelector('[aria-live="assertive"]');
    expect(polite).toBeTruthy();
    expect(assertive).toBeTruthy();
    expect(assertive).toHaveAttribute("role", "alert");
  });

  it("reflects announced polite messages into the live region", () => {
    const { container } = render(<LiveRegion />);
    act(() => {
      announce("生成が完了しました");
    });
    const polite = container.querySelector('[aria-live="polite"]');
    expect(polite?.textContent).toContain("生成が完了しました");
  });

  it("has no axe violations", async () => {
    const { container } = render(<LiveRegion />);
    await expectNoA11yViolations(container);
  });
});
