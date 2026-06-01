// @vitest-environment happy-dom
/**
 * keepalive (within-slot panel switching keeps prior panels mounted) と
 * prune (cross-slot move で旧 slot から zombie を消す) の挙動を gate する。
 * これは AnimatedSlotPanel が「切替えのもたつき」を解消するための核なので、
 * 単体テストで永続化しておく。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("./panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get: (_t, prop) =>
        function StubPanel() {
          return <div data-stub-panel={String(prop)} />;
        },
    },
  ),
}));

vi.mock("./layoutStore", () => ({
  useLayoutStore: (selector: (s: { draggingPanel: null }) => unknown) =>
    selector({ draggingPanel: null }),
}));

vi.mock("@/lib/animation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/animation")>();
  return {
    ...actual,
    // 単体テストでは duration を 0 にしてフレーム待ちを不要にする。
    useReducedMotion: () => true,
  };
});

import { AnimatedSlotPanel } from "./AnimatedSlotPanel";

afterEach(cleanup);

describe("AnimatedSlotPanel keepalive", () => {
  it("keeps previously-shown panels mounted when switching within a slot", () => {
    const { container, rerender } = render(
      <AnimatedSlotPanel
        panelId="chat"
        slotPanels={["chat", "codex"] as const}
      />,
    );
    expect(container.querySelectorAll("[data-stub-panel]")).toHaveLength(1);

    rerender(
      <AnimatedSlotPanel
        panelId="codex"
        slotPanels={["chat", "codex"] as const}
      />,
    );
    expect(container.querySelectorAll("[data-stub-panel]")).toHaveLength(2);
  });

  it("renders data-slot-panel only on the active panel (highlight/spotlight contract)", () => {
    const { container, rerender } = render(
      <AnimatedSlotPanel
        panelId="chat"
        slotPanels={["chat", "codex"] as const}
      />,
    );
    rerender(
      <AnimatedSlotPanel
        panelId="codex"
        slotPanels={["chat", "codex"] as const}
      />,
    );
    expect(container.querySelectorAll("[data-slot-panel]")).toHaveLength(1);
    expect(container.querySelector('[data-slot-panel="codex"]')).not.toBeNull();
    expect(container.querySelector('[data-slot-panel="chat"]')).toBeNull();
  });

  it("marks inactive panels as inert + aria-hidden", () => {
    const { container, rerender } = render(
      <AnimatedSlotPanel
        panelId="chat"
        slotPanels={["chat", "codex"] as const}
      />,
    );
    rerender(
      <AnimatedSlotPanel
        panelId="codex"
        slotPanels={["chat", "codex"] as const}
      />,
    );
    const inactive = container.querySelector(
      '[data-animated-slot-panel="chat"]',
    );
    expect(inactive).not.toBeNull();
    expect(inactive!.getAttribute("aria-hidden")).toBe("true");
    expect(inactive!.hasAttribute("inert")).toBe(true);
    const active = container.querySelector(
      '[data-animated-slot-panel="codex"]',
    );
    expect(active!.getAttribute("aria-hidden")).toBe("false");
    expect(active!.hasAttribute("inert")).toBe(false);
  });

  it("prunes panels removed from slotPanels (cross-slot move)", () => {
    const { container, rerender } = render(
      <AnimatedSlotPanel
        panelId="chat"
        slotPanels={["chat", "codex"] as const}
      />,
    );
    rerender(
      <AnimatedSlotPanel
        panelId="codex"
        slotPanels={["chat", "codex"] as const}
      />,
    );
    expect(container.querySelectorAll("[data-stub-panel]")).toHaveLength(2);

    // chat が別 slot に move された：旧 slot は codex だけ持つ。
    rerender(
      <AnimatedSlotPanel panelId="codex" slotPanels={["codex"] as const} />,
    );
    const stubs = container.querySelectorAll("[data-stub-panel]");
    expect(stubs).toHaveLength(1);
    expect(stubs[0].getAttribute("data-stub-panel")).toBe("codex");
  });

  it("renders nothing while the slot has no active panel and was never opened", () => {
    const { container } = render(
      <AnimatedSlotPanel
        panelId={null}
        slotPanels={["chat", "codex"] as const}
      />,
    );
    expect(container.querySelectorAll("[data-stub-panel]")).toHaveLength(0);
  });
});
