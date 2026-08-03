// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindScrollbarMarkers } from "./FindScrollbarMarkers";

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    right: 80,
    bottom,
    left: 20,
    width: 60,
    height: bottom - top,
    x: 20,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function rectList(value: DOMRect): DOMRectList {
  return Object.assign([value], {
    item: (index: number) => (index === 0 ? value : null),
  }) as unknown as DOMRectList;
}

let nextFrameId = 1;
let pendingFrames = new Map<number, FrameRequestCallback>();
const cancelFrame = vi.fn((frameId: number) => {
  pendingFrames.delete(frameId);
});

function flushFrames(): void {
  const callbacks = [...pendingFrames.values()];
  pendingFrames.clear();
  act(() => callbacks.forEach((callback) => callback(0)));
}

class ResizeObserverSpy {
  static instances: ResizeObserverSpy[] = [];
  readonly disconnect = vi.fn();

  constructor() {
    ResizeObserverSpy.instances.push(this);
  }

  observe() {}
}

class MutationObserverSpy {
  static instances: MutationObserverSpy[] = [];
  readonly disconnect = vi.fn();

  constructor(private readonly callback: MutationCallback) {
    MutationObserverSpy.instances.push(this);
  }

  observe() {}

  emit(records: MutationRecord[]) {
    this.callback(records, this as unknown as MutationObserver);
  }
}

interface Harness {
  scrollContainer: HTMLDivElement;
  paper: HTMLDivElement;
  editorDom: HTMLDivElement;
}

function createHarness(clientHeight = 101): Harness {
  const scrollContainer = document.createElement("div");
  Object.defineProperties(scrollContainer, {
    scrollTop: { value: 0, writable: true },
    scrollLeft: { value: 0, writable: true },
    scrollHeight: { value: 1_000 },
    scrollWidth: { value: 100 },
    clientHeight: { value: clientHeight },
    clientWidth: { value: 100 },
    offsetHeight: { value: clientHeight },
    offsetWidth: { value: 100 },
  });
  scrollContainer.getBoundingClientRect = () => rect(0, clientHeight);
  const paper = document.createElement("div");
  paper.className = "zen-editor-paper";
  const editorDom = document.createElement("div");
  paper.append(editorDom);
  scrollContainer.append(paper);
  document.body.append(scrollContainer);
  return { scrollContainer, paper, editorDom };
}

function createEditor(editorDom: HTMLElement, matchCount = 1): Editor {
  return {
    isDestroyed: false,
    view: { dom: editorDom },
    storage: {
      findReplace: {
        query: "needle",
        caseSensitive: false,
        useRegex: false,
        currentIndex: 0,
        matches: Array.from({ length: matchCount }, (_, index) => ({
          from: index * 2 + 1,
          to: index * 2 + 2,
        })),
        regexError: false,
      },
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
}

function appendMatch(
  editorDom: HTMLElement,
  top: number,
  current = false,
  onRead?: () => void,
): HTMLElement {
  const match = document.createElement("span");
  match.className = current ? "find-current" : "find-match";
  match.getClientRects = () => {
    onRead?.();
    return rectList(rect(top, top + 1));
  };
  match.getBoundingClientRect = () => rect(top, top + 1);
  editorDom.append(match);
  return match;
}

describe("FindScrollbarMarkers final regressions", () => {
  beforeEach(() => {
    nextFrameId = 1;
    pendingFrames = new Map();
    cancelFrame.mockClear();
    ResizeObserverSpy.instances = [];
    MutationObserverSpy.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverSpy);
    vi.stubGlobal("MutationObserver", MutationObserverSpy);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = nextFrameId++;
      pendingFrames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("ignores cursor-overlay mutations but remeasures virtual-row movement", () => {
    const harness = createHarness();
    let geometryReads = 0;
    appendMatch(harness.editorDom, 200, true, () => geometryReads++);
    const cursor = document.createElement("span");
    cursor.className = "typewriter-cursor";
    harness.editorDom.append(cursor);
    const virtualRow = document.createElement("div");
    virtualRow.dataset.linearVirtualRow = "";
    harness.paper.append(virtualRow);

    render(
      <FindScrollbarMarkers
        editor={createEditor(harness.editorDom)}
        scrollContainerRef={{ current: harness.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );
    flushFrames();
    const readsAfterMount = geometryReads;
    const observer = MutationObserverSpy.instances[0];

    act(() => {
      observer?.emit([
        {
          type: "attributes",
          target: cursor,
          attributeName: "style",
        } as unknown as MutationRecord,
      ]);
    });
    flushFrames();
    expect(geometryReads).toBe(readsAfterMount);

    act(() => {
      observer?.emit([
        {
          type: "attributes",
          target: virtualRow,
          attributeName: "style",
        } as unknown as MutationRecord,
      ]);
    });
    flushFrames();
    expect(geometryReads).toBeGreaterThan(readsAfterMount);
  });

  it("retains sparse visual hits outside a dense result cluster", () => {
    const harness = createHarness(50);
    let geometryReads = 0;
    for (let index = 0; index < 490; index++) {
      appendMatch(harness.editorDom, 10, index === 0, () => geometryReads++);
    }
    for (const top of [100, 200, 300, 400, 500, 600, 700, 800, 900, 990]) {
      appendMatch(harness.editorDom, top, false, () => geometryReads++);
    }

    const { container } = render(
      <FindScrollbarMarkers
        editor={createEditor(harness.editorDom, 500)}
        scrollContainerRef={{ current: harness.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );
    flushFrames();
    const positions = Array.from(
      container.querySelectorAll<HTMLElement>("[data-find-scrollbar-marker]"),
      (marker) => Number.parseFloat(marker.style.top),
    );

    expect(geometryReads).toBeLessThanOrEqual(51);
    expect(positions.length).toBeGreaterThanOrEqual(10);
    expect(positions.some((position) => position >= 19 && position <= 22)).toBe(
      true,
    );
  });

  it("hides the previous editor's markers immediately and cleans up observers", () => {
    const first = createHarness();
    appendMatch(first.editorDom, 100, true);
    const secondEditorDom = document.createElement("div");
    appendMatch(secondEditorDom, 800, true);
    const firstEditor = createEditor(first.editorDom);
    const secondEditor = createEditor(secondEditorDom);
    const { container, rerender, unmount } = render(
      <FindScrollbarMarkers
        editor={firstEditor}
        scrollContainerRef={{ current: first.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );
    flushFrames();
    expect(
      container.querySelector("[data-find-scrollbar-marker]"),
    ).toBeTruthy();

    act(() => window.dispatchEvent(new Event("resize")));
    rerender(
      <FindScrollbarMarkers
        editor={secondEditor}
        scrollContainerRef={{ current: first.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );

    expect(container.querySelector("[data-find-scrollbar-marker]")).toBeNull();
    expect(firstEditor.off).toHaveBeenCalledWith(
      "transaction",
      expect.any(Function),
    );
    expect(ResizeObserverSpy.instances[0]?.disconnect).toHaveBeenCalled();
    expect(MutationObserverSpy.instances[0]?.disconnect).toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalled();

    unmount();
    expect(ResizeObserverSpy.instances[1]?.disconnect).toHaveBeenCalled();
    expect(MutationObserverSpy.instances[1]?.disconnect).toHaveBeenCalled();
  });
});
