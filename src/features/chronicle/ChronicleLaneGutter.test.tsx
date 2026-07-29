// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackedLane } from "./chronicleLanePack";
import { ChronicleLaneGutter } from "./ChronicleLaneGutter";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));
vi.mock("@/features/editor/CodexPopover", () => ({
  CodexPopover: () => null,
}));
vi.mock("./CodexEntryPicker", () => ({
  CodexEntryPicker: () => null,
}));

const lanes: PackedLane[] = [
  {
    codexId: "a",
    name: "A",
    kind: "character",
    unassigned: false,
    count: 1,
    top: 0,
    height: 80,
    rows: 1,
    markers: [],
    keepEmpty: false,
  },
  {
    codexId: "b",
    name: "B",
    kind: "character",
    unassigned: false,
    count: 1,
    top: 80,
    height: 80,
    rows: 1,
    markers: [],
    keepEmpty: false,
  },
];

function renderGutter(
  overrides: Partial<React.ComponentProps<typeof ChronicleLaneGutter>> = {},
) {
  const onReorderLanes = vi.fn();
  const props: React.ComponentProps<typeof ChronicleLaneGutter> = {
    lanes,
    gutterX: 190,
    minHeight: 160,
    activeLaneKey: null,
    onReorderLanes,
    isInteractive: true,
    interactionEpoch: "workspace-a:1",
    ...overrides,
  };
  const rendered = render(<ChronicleLaneGutter {...props} />);
  const cells =
    rendered.container.querySelectorAll<HTMLElement>("[data-lane-id]");
  cells.forEach((cell, index) => {
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: index * 80,
      top: index * 80,
      bottom: index * 80 + 80,
      left: 0,
      right: 190,
      width: 190,
      height: 80,
      toJSON: () => ({}),
    });
  });
  return { ...rendered, props, onReorderLanes };
}

function beginMovedDrag() {
  const grip = document.querySelector<HTMLElement>('[data-reorder-grip="a"]');
  if (!grip) throw new Error("reorder grip was not rendered");
  fireEvent.mouseDown(grip, {
    button: 0,
    clientY: 40,
  });
  fireEvent.mouseMove(document, { clientY: 140 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChronicleLaneGutter reorder cancellation", () => {
  it("rolls back a live reorder on window blur and ignores the later mouseup", () => {
    const { onReorderLanes } = renderGutter();
    beginMovedDrag();
    expect(onReorderLanes).toHaveBeenLastCalledWith(["b", "a"], false);

    fireEvent.blur(window);
    expect(onReorderLanes).toHaveBeenLastCalledWith(["a", "b"], false);
    expect(onReorderLanes).not.toHaveBeenCalledWith(["b", "a"], true);

    fireEvent.mouseUp(document);
    expect(onReorderLanes).toHaveBeenCalledTimes(2);
  });

  it("rolls back when the panel becomes non-interactive", () => {
    const { onReorderLanes, rerender, props } = renderGutter();
    beginMovedDrag();

    rerender(<ChronicleLaneGutter {...props} isInteractive={false} />);
    expect(onReorderLanes).toHaveBeenNthCalledWith(1, ["b", "a"], false);
    expect(onReorderLanes).toHaveBeenNthCalledWith(2, ["a", "b"], false);
    expect(
      document.querySelector<HTMLElement>('[data-lane-id="a"]')?.style.opacity,
    ).toBe("");
  });

  it("rolls back when the interaction epoch changes", () => {
    const { onReorderLanes, rerender, props } = renderGutter();
    beginMovedDrag();

    rerender(
      <ChronicleLaneGutter {...props} interactionEpoch="workspace-b:2" />,
    );
    expect(onReorderLanes).toHaveBeenLastCalledWith(["a", "b"], false);
    expect(onReorderLanes).toHaveBeenCalledTimes(2);
  });

  it("commits a moved order exactly once on normal mouseup", () => {
    const { onReorderLanes } = renderGutter();
    beginMovedDrag();

    fireEvent.mouseUp(document);
    expect(onReorderLanes).toHaveBeenNthCalledWith(1, ["b", "a"], false);
    expect(onReorderLanes).toHaveBeenNthCalledWith(2, ["b", "a"], true);
    expect(onReorderLanes).toHaveBeenCalledTimes(2);
  });

  it("rolls back and removes document listeners on unmount", () => {
    const { onReorderLanes, unmount } = renderGutter();
    beginMovedDrag();

    unmount();
    expect(onReorderLanes).toHaveBeenLastCalledWith(["a", "b"], false);
    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { clientY: 10 });
    expect(onReorderLanes).toHaveBeenCalledTimes(2);
  });

  it("does not start a reorder while non-interactive", () => {
    const { onReorderLanes } = renderGutter({ isInteractive: false });

    fireEvent.mouseUp(document);
    expect(document.querySelector('[data-reorder-grip="a"]')).toBeNull();
    expect(onReorderLanes).not.toHaveBeenCalled();
  });
});
