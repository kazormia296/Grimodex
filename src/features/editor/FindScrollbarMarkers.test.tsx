// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFindScrollbarMarkers,
  FindScrollbarMarkers,
} from "./FindScrollbarMarkers";

function rect(
  top: number,
  right: number,
  bottom: number,
  left: number,
): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("buildFindScrollbarMarkers", () => {
  it("maps horizontal-writing hit rects onto the vertical scroll track", () => {
    const markers = buildFindScrollbarMarkers({
      matchRects: [
        { rect: rect(300, 80, 320, 20), current: false },
        { rect: rect(690, 80, 710, 20), current: true },
      ],
      containerRect: rect(100, 100, 200, 0),
      scrollMetrics: {
        scrollTop: 200,
        scrollLeft: 0,
        scrollHeight: 1_000,
        scrollWidth: 100,
        clientHeight: 101,
        clientWidth: 100,
      },
      verticalMode: false,
    });

    expect(markers).toEqual([
      { positionPercent: 41, current: false },
      { positionPercent: 80, current: true },
    ]);
  });

  it("maps vertical-rl hits from the right edge onto a right-to-left track", () => {
    const markers = buildFindScrollbarMarkers({
      matchRects: [
        { rect: rect(20, 300, 80, 280), current: false },
        { rect: rect(20, 100, 80, 80), current: true },
      ],
      containerRect: rect(0, 500, 100, 400),
      scrollMetrics: {
        scrollTop: 0,
        scrollLeft: -200,
        scrollHeight: 100,
        scrollWidth: 1_000,
        clientHeight: 100,
        clientWidth: 101,
      },
      verticalMode: true,
    });

    expect(markers).toEqual([
      { positionPercent: 41, current: false },
      { positionPercent: 61, current: true },
    ]);
  });

  it("merges hits that share a track pixel and preserves the current hit", () => {
    const markers = buildFindScrollbarMarkers({
      matchRects: [
        { rect: rect(100, 80, 102, 20), current: false },
        { rect: rect(104, 80, 106, 20), current: true },
      ],
      containerRect: rect(0, 100, 100, 0),
      scrollMetrics: {
        scrollTop: 0,
        scrollLeft: 0,
        scrollHeight: 10_000,
        scrollWidth: 100,
        clientHeight: 100,
        clientWidth: 100,
      },
      verticalMode: false,
    });

    expect(markers).toEqual([
      { positionPercent: 1.0101010101010102, current: true },
    ]);
  });

  it("omits markers when there is no scrollable block axis", () => {
    expect(
      buildFindScrollbarMarkers({
        matchRects: [{ rect: rect(20, 80, 40, 20), current: true }],
        containerRect: rect(0, 100, 100, 0),
        scrollMetrics: {
          scrollTop: 0,
          scrollLeft: 0,
          scrollHeight: 100,
          scrollWidth: 100,
          clientHeight: 100,
          clientWidth: 100,
        },
        verticalMode: false,
      }),
    ).toEqual([]);
  });
});

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

describe("FindScrollbarMarkers", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders visual-only markers from live find decorations and refreshes on transactions", () => {
    const scrollContainer = document.createElement("div");
    Object.defineProperties(scrollContainer, {
      scrollTop: { value: 0, writable: true },
      scrollLeft: { value: 0, writable: true },
      scrollHeight: { value: 1_000 },
      scrollWidth: { value: 100 },
      clientHeight: { value: 101 },
      clientWidth: { value: 100 },
    });
    scrollContainer.getBoundingClientRect = () => rect(0, 100, 101, 0);

    const editorDom = document.createElement("div");
    const normal = document.createElement("span");
    normal.className = "find-match";
    normal.getBoundingClientRect = () => rect(90, 80, 110, 20);
    const current = document.createElement("span");
    current.className = "find-current";
    current.getBoundingClientRect = () => rect(490, 80, 510, 20);
    editorDom.append(normal, current);

    let transactionHandler: (() => void) | undefined;
    const editor = {
      view: { dom: editorDom },
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "transaction") transactionHandler = handler;
      }),
      off: vi.fn(),
    } as unknown as Editor;

    const { container } = render(
      <FindScrollbarMarkers
        editor={editor}
        scrollContainerRef={{ current: scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );

    const rail = container.querySelector("[data-find-scrollbar-markers]");
    expect(rail).toHaveAttribute("aria-hidden", "true");
    expect(rail).toHaveAttribute("data-orientation", "vertical");
    expect(rail).toHaveClass("pointer-events-none");
    expect(
      Array.from(rail!.querySelectorAll("[data-find-scrollbar-marker]")).map(
        (marker) => ({
          top: (marker as HTMLElement).style.top,
          current: marker.getAttribute("data-current"),
        }),
      ),
    ).toEqual([
      { top: "10%", current: "false" },
      { top: "50%", current: "true" },
    ]);

    current.getBoundingClientRect = () => rect(790, 80, 810, 20);
    act(() => transactionHandler?.());

    expect(
      (rail!.querySelector('[data-current="true"]') as HTMLElement).style.top,
    ).toBe("80%");
  });

  it("uses a horizontal right-to-left rail in vertical writing mode", () => {
    const scrollContainer = document.createElement("div");
    Object.defineProperties(scrollContainer, {
      scrollTop: { value: 0, writable: true },
      scrollLeft: { value: 0, writable: true },
      scrollHeight: { value: 100 },
      scrollWidth: { value: 1_000 },
      clientHeight: { value: 100 },
      clientWidth: { value: 101 },
    });
    scrollContainer.getBoundingClientRect = () => rect(0, 500, 100, 400);

    const editorDom = document.createElement("div");
    const current = document.createElement("span");
    current.className = "find-current";
    current.getBoundingClientRect = () => rect(20, 410, 80, 390);
    editorDom.append(current);
    const editor = {
      view: { dom: editorDom },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Editor;

    const { container } = render(
      <FindScrollbarMarkers
        editor={editor}
        scrollContainerRef={{ current: scrollContainer }}
        enabled
        verticalMode
      />,
    );

    const rail = container.querySelector("[data-find-scrollbar-markers]");
    expect(rail).toHaveAttribute("data-orientation", "horizontal");
    expect(
      (rail!.querySelector("[data-find-scrollbar-marker]") as HTMLElement).style
        .right,
    ).toBe("10%");
  });

  it("does not render stale markers while disabled", () => {
    const editor = {
      view: { dom: document.createElement("div") },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Editor;

    const { container } = render(
      <FindScrollbarMarkers
        editor={editor}
        scrollContainerRef={{ current: document.createElement("div") }}
        enabled={false}
        verticalMode={false}
      />,
    );

    expect(container.querySelector("[data-find-scrollbar-markers]")).toBeNull();
    expect(editor.on).not.toHaveBeenCalled();
  });
});
