// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindScrollbarMarkers } from "./FindScrollbarMarkers";

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

function rectList(...rects: DOMRect[]): DOMRectList {
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

let nextFrameId = 1;
let pendingFrames = new Map<number, FrameRequestCallback>();

function flushFrames(): void {
  const frames = [...pendingFrames.values()];
  pendingFrames.clear();
  act(() => {
    frames.forEach((callback) => callback(0));
  });
}

class ResizeObserverSpy {
  static instances: ResizeObserverSpy[] = [];
  readonly observed: Element[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverSpy.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  disconnect() {}

  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

class MutationObserverSpy {
  static instances: MutationObserverSpy[] = [];
  readonly observed: Node[] = [];

  constructor(private readonly callback: MutationCallback) {
    MutationObserverSpy.instances.push(this);
  }

  observe(target: Node) {
    this.observed.push(target);
  }

  disconnect() {}

  emit() {
    this.callback([], this as unknown as MutationObserver);
  }
}

interface Harness {
  scrollContainer: HTMLDivElement;
  paper: HTMLDivElement;
  editorDom: HTMLDivElement;
  editor: Editor;
  transaction: () => void;
}

function createHarness(): Harness {
  const scrollContainer = document.createElement("div");
  Object.defineProperties(scrollContainer, {
    scrollTop: { value: 0, writable: true },
    scrollLeft: { value: 0, writable: true },
    scrollHeight: { value: 1_000, configurable: true },
    scrollWidth: { value: 100, configurable: true },
    clientHeight: { value: 101, configurable: true },
    clientWidth: { value: 100, configurable: true },
    offsetHeight: { value: 101, configurable: true },
    offsetWidth: { value: 100, configurable: true },
  });
  scrollContainer.getBoundingClientRect = () => rect(0, 100, 101, 0);

  const paper = document.createElement("div");
  paper.className = "zen-editor-paper";
  const editorDom = document.createElement("div");
  paper.append(editorDom);
  scrollContainer.append(paper);
  document.body.append(scrollContainer);

  let transactionHandler: (() => void) | undefined;
  const editor = {
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
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "transaction") transactionHandler = handler;
    }),
    off: vi.fn(),
  } as unknown as Editor;

  return {
    scrollContainer,
    paper,
    editorDom,
    editor,
    transaction: () => transactionHandler?.(),
  };
}

describe("FindScrollbarMarkers regressions", () => {
  beforeEach(() => {
    nextFrameId = 1;
    pendingFrames = new Map();
    ResizeObserverSpy.instances = [];
    MutationObserverSpy.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverSpy);
    vi.stubGlobal("MutationObserver", MutationObserverSpy);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = nextFrameId++;
      pendingFrames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
      pendingFrames.delete(frameId);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("anchors a wrapped match to its first rendered fragment", () => {
    const harness = createHarness();
    const current = document.createElement("span");
    current.className = "find-current";
    current.getClientRects = () =>
      rectList(rect(100, 80, 120, 20), rect(280, 80, 300, 20));
    current.getBoundingClientRect = () => rect(100, 80, 300, 20);
    harness.editorDom.append(current);

    const { container } = render(
      <FindScrollbarMarkers
        editor={harness.editor}
        scrollContainerRef={{ current: harness.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );
    flushFrames();

    expect(
      (container.querySelector("[data-find-scrollbar-marker]") as HTMLElement)
        .style.top,
    ).toBe("11%");
  });

  it("does not render markers for hidden zero-area decorations", () => {
    const harness = createHarness();
    const hidden = document.createElement("span");
    hidden.className = "find-current";
    hidden.getClientRects = () => rectList();
    hidden.getBoundingClientRect = () => rect(0, 0, 0, 0);
    harness.editorDom.append(hidden);

    const { container } = render(
      <FindScrollbarMarkers
        editor={harness.editor}
        scrollContainerRef={{ current: harness.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );
    flushFrames();

    expect(container.querySelector("[data-find-scrollbar-markers]")).toBeNull();
  });

  it("observes the content extent and virtual-layout mutations", () => {
    const harness = createHarness();
    render(
      <FindScrollbarMarkers
        editor={harness.editor}
        scrollContainerRef={{ current: harness.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );

    expect(ResizeObserverSpy.instances[0]?.observed).toContain(harness.paper);
    expect(MutationObserverSpy.instances[0]?.observed).toContain(
      harness.scrollContainer,
    );
  });

  it("skips selection-only transactions when find state did not change", () => {
    const harness = createHarness();
    const current = document.createElement("span");
    current.className = "find-current";
    const measure = vi.fn(() => rectList(rect(100, 80, 120, 20)));
    const measureFallback = vi.fn(() => rect(100, 80, 120, 20));
    current.getClientRects = measure;
    current.getBoundingClientRect = measureFallback;
    harness.editorDom.append(current);

    render(
      <FindScrollbarMarkers
        editor={harness.editor}
        scrollContainerRef={{ current: harness.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );
    flushFrames();
    const measuredAfterMount =
      measure.mock.calls.length + measureFallback.mock.calls.length;

    act(() => harness.transaction());
    flushFrames();

    expect(measure.mock.calls.length + measureFallback.mock.calls.length).toBe(
      measuredAfterMount,
    );
  });

  it("bounds geometry reads to the number of available track pixels", () => {
    const harness = createHarness();
    Object.defineProperty(harness.scrollContainer, "clientHeight", {
      value: 50,
    });
    Object.defineProperty(harness.scrollContainer, "offsetHeight", {
      value: 50,
    });
    harness.scrollContainer.getBoundingClientRect = () => rect(0, 100, 50, 0);
    let geometryReads = 0;

    for (let index = 0; index < 500; index++) {
      const match = document.createElement("span");
      match.className = index === 250 ? "find-current" : "find-match";
      match.getClientRects = () => {
        geometryReads++;
        return rectList(rect(index * 2, 80, index * 2 + 1, 20));
      };
      match.getBoundingClientRect = () => {
        geometryReads++;
        return rect(index * 2, 80, index * 2 + 1, 20);
      };
      harness.editorDom.append(match);
    }

    render(
      <FindScrollbarMarkers
        editor={harness.editor}
        scrollContainerRef={{ current: harness.scrollContainer }}
        enabled
        verticalMode={false}
      />,
    );
    flushFrames();

    expect(geometryReads).toBeLessThanOrEqual(51);
  });
});
