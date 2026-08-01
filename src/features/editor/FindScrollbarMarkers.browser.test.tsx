import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { FindScrollbarMarkers } from "./FindScrollbarMarkers";

function mockEditor(editorDom: HTMLElement): Editor {
  return {
    isDestroyed: false,
    view: { dom: editorDom },
    storage: {
      findReplace: {
        query: "needle",
        caseSensitive: false,
        useRegex: false,
        currentIndex: 0,
        matches: [{ from: 1, to: 7 }],
        regexError: false,
      },
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("FindScrollbarMarkers browser geometry", () => {
  it("uses the first wrapped line and remains accurate under CSS zoom", async () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.cssText =
      "position:relative;width:160px;height:120px;overflow:auto;zoom:1.5";
    const paper = document.createElement("div");
    paper.className = "zen-editor-paper";
    paper.style.cssText = "position:relative;width:120px;height:1000px";
    const editorDom = document.createElement("div");
    editorDom.style.cssText =
      "position:absolute;top:650px;left:0;width:44px;font:16px/20px sans-serif";
    const current = document.createElement("span");
    current.className = "find-current";
    current.textContent = "needle needle needle needle";
    editorDom.append(current);
    paper.append(editorDom);
    scrollContainer.append(paper);
    document.body.append(scrollContainer);

    const fragments = current.getClientRects();
    expect(fragments.length).toBeGreaterThan(1);
    const scale =
      scrollContainer.getBoundingClientRect().height /
      scrollContainer.offsetHeight;
    expect(scale).toBeGreaterThan(1.4);

    const { container } = render(
      <FindScrollbarMarkers
        editor={mockEditor(editorDom)}
        scrollContainerRef={{ current: scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector("[data-find-scrollbar-marker]"),
      ).toBeTruthy();
    });
    const marker = container.querySelector(
      "[data-find-scrollbar-marker]",
    ) as HTMLElement;
    const containerRect = scrollContainer.getBoundingClientRect();
    const first = fragments[0];
    const contentMidpoint =
      scrollContainer.scrollTop * scale +
      first.top -
      containerRect.top +
      first.height / 2;
    const ratio = contentMidpoint / (scrollContainer.scrollHeight * scale);
    const lastTrackPixel = Math.round(scrollContainer.clientHeight) - 1;
    const expected =
      (Math.round(ratio * lastTrackPixel) / lastTrackPixel) * 100;

    // CSSStyleDeclaration serializes percentages to four decimal places.
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(expected, 3);
  });

  it("uses the first wrapped column for the vertical right-to-left rail", async () => {
    const scrollContainer = document.createElement("div");
    const paper = document.createElement("div");
    paper.className = "zen-editor-paper";
    const editorDom = document.createElement("div");
    editorDom.style.cssText =
      "writing-mode:vertical-rl;height:44px;width:240px;font:16px/20px sans-serif";
    const current = document.createElement("span");
    current.className = "find-current";
    current.textContent = "検索位置検索位置検索位置検索位置";
    editorDom.append(current);
    paper.append(editorDom);
    scrollContainer.append(paper);
    document.body.append(scrollContainer);

    const fragments = current.getClientRects();
    expect(fragments.length).toBeGreaterThan(1);
    Object.defineProperties(scrollContainer, {
      scrollTop: { value: 0, configurable: true },
      scrollLeft: { value: 0, configurable: true },
      scrollHeight: { value: 100, configurable: true },
      scrollWidth: { value: 1_000, configurable: true },
      clientHeight: { value: 100, configurable: true },
      clientWidth: { value: 101, configurable: true },
      offsetHeight: { value: 100, configurable: true },
      offsetWidth: { value: 101, configurable: true },
    });
    scrollContainer.getBoundingClientRect = () => {
      const first = current.getClientRects()[0];
      const right = first.right + 200;
      return new DOMRect(right - 101, 0, 101, 100);
    };

    const { container } = render(
      <FindScrollbarMarkers
        editor={mockEditor(editorDom)}
        scrollContainerRef={{ current: scrollContainer }}
        enabled
        verticalMode
      />,
    );
    await waitFor(() => {
      expect(
        container.querySelector("[data-find-scrollbar-marker]"),
      ).toBeTruthy();
    });
    const marker = container.querySelector(
      "[data-find-scrollbar-marker]",
    ) as HTMLElement;
    const first = fragments[0];
    const containerRect = scrollContainer.getBoundingClientRect();
    const contentMidpoint = containerRect.right - first.right + first.width / 2;
    const ratio = contentMidpoint / scrollContainer.scrollWidth;
    const lastTrackPixel = Math.round(scrollContainer.clientWidth) - 1;
    const expected =
      (Math.round(ratio * lastTrackPixel) / lastTrackPixel) * 100;

    expect(Number.parseFloat(marker.style.right)).toBeCloseTo(expected, 5);
  });
});
