/**
 * 実 Chromium で、設定ダイアログのカテゴリ切替の動きを gate する。
 *
 * - 選択中の背景は前のカテゴリの位置から滑り、途中のボタンの文字を隠さない。
 * - ダイアログを開き直した（motionScope が変わった）切替では滑らせない。
 * - 本文はカテゴリの並びの向きに 6px 寄せて出し、終われば transform を残さない。
 */
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { useSettingsStore } from "./settingsStore";
import { CategoryNav } from "./CategoryNav";
import { useCategoryShift } from "./settingsMotion";
import type { SettingsCategory } from "./types";

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: vi.fn(async () => ({})),
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  isTauri: () => false,
}));

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });
}

function pill(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-settings-category-pill]")!;
}

function button(container: HTMLElement, label: string): HTMLElement {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  )!;
}

beforeEach(async () => {
  await page.viewport(1000, 700);
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "display.reduceMotion": "false" },
  }));
});

describe("settings category motion (real Chromium)", () => {
  it("slides the selected background without covering the labels it passes", async () => {
    const view = render(
      <CategoryNav active="project" onChange={() => {}} motionScope={1} />,
    );
    await frames(40);
    const from = pill(view.container).getBoundingClientRect();
    const passed = button(view.container, "Editor");
    const target = button(view.container, "Keys").getBoundingClientRect();

    view.rerender(
      <CategoryNav active="keys" onChange={() => {}} motionScope={1} />,
    );
    // 前の位置から滑る（途中で transform が掛かる）。
    await waitFor(() => {
      expect(getComputedStyle(pill(view.container)).transform).not.toBe("none");
    });
    await waitFor(() => {
      expect(getComputedStyle(pill(view.container)).transform).toBe("none");
    });
    const el = pill(view.container);
    const r = el.getBoundingClientRect();
    expect(Math.abs(r.top - target.top)).toBeLessThan(0.5);
    expect(r.top).toBeGreaterThan(from.top + 1);

    // 滑り終えてから、背景を途中のボタンの文字の上へ手で置き、描く順を調べる
    // （動いている途中を捕まえる形は、負荷でフレームが粗いと取り逃がす）。
    // 背景は pointer-events: none なので、調べる間だけ戻す。
    const label = passed.querySelector("span")!.getBoundingClientRect();
    const x = label.left + 2;
    const y = label.top + label.height / 2;
    el.style.transform = `translateY(${y - (r.top + r.height / 2)}px)`;
    el.style.pointerEvents = "auto";
    const hit = document.elementFromPoint(x, y);
    el.style.transform = "";
    el.style.pointerEvents = "";
    // 背景が上を通っても、文字は背景より上に描かれる。
    expect(passed.contains(hit)).toBe(true);
  });

  it("does not slide when the dialog is opened again on another category", async () => {
    const view = render(
      <CategoryNav active="project" onChange={() => {}} motionScope={1} />,
    );
    await frames(40);
    view.rerender(
      <CategoryNav active="keys" onChange={() => {}} motionScope={2} />,
    );
    await frames(2);
    const target = button(view.container, "Keys").getBoundingClientRect();
    const r = pill(view.container).getBoundingClientRect();
    expect(getComputedStyle(pill(view.container)).transform).toBe("none");
    expect(Math.abs(r.top - target.top)).toBeLessThan(0.5);
  });

  it("shifts the content toward the direction of travel and leaves no transform", async () => {
    function Harness({
      category,
      scope,
    }: {
      category: SettingsCategory;
      scope: number;
    }) {
      const ref = useRef<HTMLDivElement>(null);
      useCategoryShift(ref, category, scope, false);
      return <div ref={ref} data-shift-target style={{ height: 40 }} />;
    }
    const view = render(<Harness category="project" scope={1} />);
    const el = view.container.querySelector<HTMLElement>(
      "[data-shift-target]",
    )!;
    const rest = el.getBoundingClientRect().top;

    act(() => {
      view.rerender(<Harness category="keys" scope={1} />);
    });
    // 先へ進んだので下から（+6px）。
    expect(el.getBoundingClientRect().top - rest).toBeGreaterThan(3);
    await waitFor(() => {
      expect(el.getAnimations()).toHaveLength(0);
    });
    expect(getComputedStyle(el).transform).toBe("none");

    act(() => {
      view.rerender(<Harness category="ai" scope={1} />);
    });
    // 戻ったので上から（-6px）。
    expect(el.getBoundingClientRect().top - rest).toBeLessThan(-3);

    // 開き直し（scope が変わる）では寄せない。
    await waitFor(() => {
      expect(el.getAnimations()).toHaveLength(0);
    });
    act(() => {
      view.rerender(<Harness category="project" scope={2} />);
    });
    expect(el.getAnimations()).toHaveLength(0);
  });
});
