// @vitest-environment happy-dom
/**
 * keepalive (within-slot panel switching keeps prior panels mounted) と
 * prune (cross-slot move で旧 slot から zombie を消す) の挙動を gate する。
 * これは AnimatedSlotPanel が「切替えのもたつき」を解消するための核なので、
 * 単体テストで永続化しておく。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("./panelComponents", async () => {
  const { lazy } = await import("react");
  // chronicle は本物と同じく React.lazy — Suspense boundary の存在を gate する。
  const LazyStubPanel = lazy(async () => ({
    default: function LazyStubPanel(props: { isActive?: boolean }) {
      return (
        <div
          data-stub-panel="chronicle"
          data-is-active={String(props.isActive)}
        />
      );
    },
  }));
  return {
    PANEL_COMPONENT_MAP: new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "chronicle"
            ? LazyStubPanel
            : function StubPanel(props: { isActive?: boolean }) {
                return (
                  <div
                    data-stub-panel={String(prop)}
                    data-is-active={String(props.isActive)}
                  />
                );
              },
      },
    ),
  };
});

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

  it("passes isActive=true to the active panel and false to keepalive-hidden panels", () => {
    // 案A の契約: keepalive で mount され続ける非アクティブパネルは isActive=false
    // を受け取り、重い scene-reactive 処理を bail できる。アクティブは true。
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
    const chat = container.querySelector('[data-stub-panel="chat"]');
    const codex = container.querySelector('[data-stub-panel="codex"]');
    expect(chat).not.toBeNull();
    expect(codex).not.toBeNull();
    // chat は keepalive で残るが hidden → false、codex はアクティブ → true。
    expect(chat!.getAttribute("data-is-active")).toBe("false");
    expect(codex!.getAttribute("data-is-active")).toBe("true");
  });

  it("renders lazy panels through the Suspense boundary (fallback → 本体)", async () => {
    // lazy パネル (chronicle) は初回 render で suspend する。boundary が無いと
    // ここで "suspended while rendering" throw になる。
    const { container } = render(
      <AnimatedSlotPanel
        panelId="chronicle"
        slotPanels={["chronicle"] as const}
      />,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-stub-panel="chronicle"]'),
      ).not.toBeNull(),
    );
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
