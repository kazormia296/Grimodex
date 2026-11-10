/**
 * 実 Chromium で AnimatedSlotPanel（④ パネル切替）の動きを gate する。
 *
 * - 同じ slot の切替: 入る側の内側の wrapper が stripe のアイコンの並びの側から
 *   寄って戻り、終われば transform を残さない。層そのものは transform しない。
 * - 初めて表示するパネルの層は 0 からフェードインする。slot の mount と同時の層は
 *   動かさない。
 * - lazy パネルの読み込み中は skeleton を見せ、読み終えた中身をフェードインする。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const lazyGate = vi.hoisted(() => {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release: () => release() };
});

vi.mock("./panelComponents", async () => {
  const { lazy } = await import("react");
  const LazyStubPanel = lazy(async () => {
    await lazyGate.ready;
    return {
      default: function LazyStubPanel() {
        return <div data-stub-panel="chronicle" />;
      },
    };
  });
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

import { AnimatedSlotPanel } from "./AnimatedSlotPanel";
import { useSettingsStore } from "@/features/settings/settingsStore";

const SLOT = ["chat", "codex", "chronicle"] as const;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: "relative", width: 300, height: 200 }}>
      {children}
    </div>
  );
}

function layer(container: HTMLElement, id: string) {
  return container.querySelector<HTMLElement>(
    `[data-animated-slot-panel="${id}"]`,
  )!;
}

function shiftOf(container: HTMLElement, id: string) {
  const inner = layer(container, id).firstElementChild as HTMLElement;
  const t = getComputedStyle(inner).transform;
  if (!t || t === "none") return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(t);
  return { x: m.m41, y: m.m42 };
}

beforeEach(() => {
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "display.reduceMotion": "false" },
  }));
});

describe("AnimatedSlotPanel switching motion", () => {
  it("does not fade or shift the layer that mounts with the slot", () => {
    const { container } = render(
      <Frame>
        <AnimatedSlotPanel panelId="chat" slotPanels={SLOT} shiftAxis="y" />
      </Frame>,
    );
    expect(getComputedStyle(layer(container, "chat")).opacity).toBe("1");
    expect(shiftOf(container, "chat")).toEqual({ x: 0, y: 0 });
  });

  it("fades a first-time panel in and shifts it from the later icon's side", async () => {
    const view = (panelId: (typeof SLOT)[number]) => (
      <Frame>
        <AnimatedSlotPanel panelId={panelId} slotPanels={SLOT} shiftAxis="y" />
      </Frame>
    );
    const { container, rerender } = render(view("chat"));
    rerender(view("codex"));

    // codex は chat より後ろのアイコン → 下（+y）から寄る。
    await waitFor(() => {
      expect(shiftOf(container, "codex").y).toBeGreaterThan(0);
    });
    expect(
      parseFloat(getComputedStyle(layer(container, "codex")).opacity),
    ).toBeLessThan(1);
    // 層そのものは transform しない（Glass の層を作らない）。
    expect(getComputedStyle(layer(container, "codex")).transform).toBe("none");

    await waitFor(() => {
      expect(getComputedStyle(layer(container, "codex")).opacity).toBe("1");
      const inner = layer(container, "codex").firstElementChild as HTMLElement;
      expect(getComputedStyle(inner).transform).toBe("none");
    });

    // 前のアイコンへ戻ると上（-y）から寄る。
    rerender(view("chat"));
    await waitFor(() => {
      expect(shiftOf(container, "chat").y).toBeLessThan(0);
    });
  });

  it("shows a skeleton while a lazy panel loads, then fades the content in", async () => {
    const view = (panelId: (typeof SLOT)[number]) => (
      <Frame>
        <AnimatedSlotPanel panelId={panelId} slotPanels={SLOT} shiftAxis="x" />
      </Frame>
    );
    const { container, rerender } = render(view("chat"));
    rerender(view("chronicle"));
    const chronicle = layer(container, "chronicle");
    expect(
      chronicle.querySelector("[data-panel-loading-skeleton]"),
    ).not.toBeNull();

    lazyGate.release();
    await waitFor(() => {
      expect(
        chronicle.querySelector('[data-stub-panel="chronicle"]'),
      ).not.toBeNull();
    });
    const content = chronicle.querySelector('[data-stub-panel="chronicle"]')!
      .parentElement as HTMLElement;
    expect(parseFloat(getComputedStyle(content).opacity)).toBeLessThan(1);
    await waitFor(() => {
      expect(getComputedStyle(content).opacity).toBe("1");
    });
  });

  it("switches at once under Reduced Motion", () => {
    useSettingsStore.setState((state) => ({
      cache: { ...state.cache, "display.reduceMotion": "true" },
    }));
    const view = (panelId: (typeof SLOT)[number]) => (
      <Frame>
        <AnimatedSlotPanel panelId={panelId} slotPanels={SLOT} shiftAxis="y" />
      </Frame>
    );
    const { container, rerender } = render(view("chat"));
    rerender(view("codex"));
    expect(getComputedStyle(layer(container, "codex")).opacity).toBe("1");
    expect(shiftOf(container, "codex")).toEqual({ x: 0, y: 0 });
  });
});
