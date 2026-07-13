// @vitest-environment happy-dom

import { forwardRef, useImperativeHandle } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Galaxy2DCanvas } from "./Galaxy2DCanvas";

const h = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
  refresh: vi.fn(),
}));

vi.mock("react-force-graph-2d", () => ({
  default: forwardRef((props: Record<string, unknown>, ref) => {
    h.props = props;
    useImperativeHandle(ref, () => ({
      refresh: h.refresh,
      centerAt: vi.fn(),
      zoomToFit: vi.fn(),
    }));
    return <div data-testid="force-graph" />;
  }),
}));

vi.mock("@/lib/animation", () => ({
  useReducedMotion: () => true,
}));

vi.mock("@/features/editor/codexHighlightStore", () => ({
  useCodexHighlightStore: (
    selector: (state: { typeColorMap: object }) => unknown,
  ) => selector({ typeColorMap: {} }),
}));

class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe() {
    this.callback(
      [{ contentRect: { width: 320, height: 240 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const graph = {
  nodes: [
    {
      id: "scene:s1",
      kind: "scene" as const,
      refId: "s1",
      label: "Scene 1",
      typeSlug: null,
      color: null,
      val: 1,
    },
  ],
  links: [],
};

describe("Galaxy2DCanvas", () => {
  it("pauses redraw after settling and refreshes only for hover changes", async () => {
    render(
      <Galaxy2DCanvas
        graph={graph}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
      />,
    );

    await waitFor(() => expect(h.props).toBeDefined());
    expect(h.props?.autoPauseRedraw).toBeUndefined();

    const node = graph.nodes[0];
    (h.props?.onNodeHover as (value: typeof node) => void)(node);
    (h.props?.onBackgroundClick as () => void)();
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });
});
