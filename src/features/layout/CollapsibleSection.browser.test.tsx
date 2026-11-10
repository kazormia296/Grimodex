/**
 * 実 Chromium で、パネル内の折りたたみの開閉の動きを gate する。
 *
 * - 開く: 中身の高さが 0 から伸び、開き終えたら中身を切らない。
 * - 閉じる: 高さが縮んでから外れる。閉じる途中の中身は操作できない。
 * - 動きを減らす設定では、すぐに最終の状態になる。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { CollapsibleSection } from "./CollapsibleSection";

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: vi.fn(async () => ({})),
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  isTauri: () => false,
}));

function setReduceMotion(on: boolean) {
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "display.reduceMotion": on ? "true" : "false" },
  }));
}

function section(open: boolean) {
  return (
    <div style={{ width: 300 }}>
      <CollapsibleSection title="Codex" open={open} onToggle={() => {}}>
        <div data-body style={{ height: 120 }}>
          <button type="button">行</button>
        </div>
      </CollapsibleSection>
    </div>
  );
}

function body(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-collapsible-body]");
}

beforeEach(async () => {
  await page.viewport(800, 600);
  setReduceMotion(false);
});

describe("collapsible section motion (real Chromium)", () => {
  it("grows the body from 0 when opening and leaves no clip at rest", async () => {
    const view = render(section(false));
    view.rerender(section(true));
    await waitFor(() => {
      const h = body(view.container)!.getBoundingClientRect().height;
      expect(h).toBeGreaterThan(1);
      expect(h).toBeLessThan(119);
    });
    await waitFor(() => {
      expect(body(view.container)!.getBoundingClientRect().height).toBe(120);
    });
    await waitFor(() => {
      // 開き終えたら中身を切らない（フォーカスの枠などを切らない）。
      expect(body(view.container)!.style.overflow).toBe("");
    });
  });

  it("shrinks the body before removing it and makes it inert meanwhile", async () => {
    const view = render(section(true));
    view.rerender(section(false));
    const leaving = body(view.container)!;
    expect(leaving).not.toBeNull();
    expect(leaving.inert).toBe(true);
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => {
      const h = leaving.getBoundingClientRect().height;
      expect(h).toBeLessThan(119);
    });
    await waitFor(() => {
      expect(body(view.container)).toBeNull();
    });
  });

  it("switches at once when motion is reduced", async () => {
    setReduceMotion(true);
    const view = render(section(false));
    view.rerender(section(true));
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
    );
    expect(body(view.container)!.getBoundingClientRect().height).toBe(120);
  });
});
