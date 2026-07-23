// @vitest-environment happy-dom
/**
 * SlotView の Suspense boundary を gate する。PANEL_COMPONENT_MAP の一部
 * (chronicle / writing-stats) は React.lazy なので、boundary が無いと初回
 * 表示で "suspended while rendering" になる。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("./panelComponents", async () => {
  const { lazy } = await import("react");
  // chronicle は本物と同じく React.lazy — Suspense boundary の存在を gate する。
  const LazyStubPanel = lazy(async () => ({
    default: function LazyStubPanel() {
      return <div data-stub-panel="chronicle" />;
    },
  }));
  return {
    PANEL_COMPONENT_MAP: new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "chronicle"
            ? LazyStubPanel
            : function StubPanel() {
                return <div data-stub-panel={String(prop)} />;
              },
      },
    ),
  };
});

vi.mock("./layoutStore", () => ({
  useLayoutStore: (selector: (s: { draggingPanel: null }) => unknown) =>
    selector({ draggingPanel: null }),
}));

import { SlotView } from "./SlotView";

afterEach(cleanup);

describe("SlotView", () => {
  it("renders the mapped panel synchronously for eager components", () => {
    const { container } = render(<SlotView panelId="chat" />);
    expect(container.querySelector('[data-stub-panel="chat"]')).not.toBeNull();
    expect(
      container.querySelector(
        '[data-slot-panel="chat"][data-ambient-glass-surface="panel"]',
      ),
    ).not.toBeNull();
  });

  it("renders lazy panels through the Suspense boundary (fallback → 本体)", async () => {
    const { container } = render(<SlotView panelId="chronicle" />);
    // suspend 中もパネル外殻 (gx-panel) は残る = 背景に馴染む fallback。
    expect(container.querySelector('[data-slot-panel="chronicle"]')).not.toBe(
      null,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-stub-panel="chronicle"]'),
      ).not.toBeNull(),
    );
  });
});
