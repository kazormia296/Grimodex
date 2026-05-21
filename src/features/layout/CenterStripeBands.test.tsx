// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { CenterStripe } from "./CenterStripe";
import { useLayoutStore } from "./layoutStore";
import {
  buildCenterSegmentsWithTools,
  buildDefaultLayoutState,
} from "./layoutStateUtils";
import { TOOL_WINDOW_REASSIGN_TYPE } from "./layoutDnD";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("CenterStripe DnD", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ editorOpen: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      hiddenStripePanels: new Set(),
    });
    useLayoutStore.getState().showPanel("scenes");
  });

  it("fills the center stripe column while dragging with editor closed", async () => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({
        allInactive: true,
        editorOpen: false,
      }),
      draggingPanel: "codex",
    });
    const { container } = render(<CenterStripe />);

    await waitFor(() => {
      expect(
        container.querySelector("[data-center-stripe-drop-overlay]"),
      ).not.toBeNull();
    });

    const column = container.querySelector<HTMLElement>(
      "[data-center-stripe-column]",
    );
    const root = container.querySelector<HTMLElement>("[data-stripe-root]");
    expect(column?.className).toContain("w-full");
    expect(root?.className).toContain("w-full");
  });

  it("moves a panel when dropped on the center stripe overlay", async () => {
    useLayoutStore.setState({ draggingPanel: "scenes" });
    const { container } = render(<CenterStripe />);

    const overlay = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        "[data-center-stripe-drop-overlay]",
      );
      expect(el).not.toBeNull();
      return el!;
    });

    fireEvent.drop(overlay, {
      dataTransfer: {
        getData: (type: string) =>
          type === TOOL_WINDOW_REASSIGN_TYPE ? "scenes" : "",
        types: [TOOL_WINDOW_REASSIGN_TYPE],
      },
    });

    expect(
      useLayoutStore
        .getState()
        .layout.center.segments.some(
          (s) => s.kind === "tool" && s.panels.includes("scenes"),
        ),
    ).toBe(true);
  });

  it("moves a panel into center via stripe overlay drop", async () => {
    useLayoutStore.setState({ draggingPanel: "scenes" });
    const { container } = render(<CenterStripe />);

    const overlay = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        "[data-center-stripe-drop-overlay]",
      );
      expect(el).not.toBeNull();
      return el!;
    });

    fireEvent.drop(overlay, {
      dataTransfer: {
        getData: (type: string) =>
          type === TOOL_WINDOW_REASSIGN_TYPE ? "scenes" : "",
        types: [TOOL_WINDOW_REASSIGN_TYPE],
      },
    });

    const centerTools = useLayoutStore
      .getState()
      .layout.center.segments.filter((s) => s.kind === "tool");
    expect(centerTools.some((s) => s.panels.includes("scenes"))).toBe(true);
    expect(
      useLayoutStore
        .getState()
        .layout.regions.left.slots.some((s) => s.panels.includes("scenes")),
    ).toBe(false);
    expect(useLayoutStore.getState().draggingPanel).toBeNull();
  });

  it("moves a panel onto an existing center tool band", async () => {
    const layout = buildDefaultLayoutState({ editorOpen: true });
    layout.center = {
      editorOpen: true,
      segments: buildCenterSegmentsWithTools(["kouetsu"], {
        kouetsu: true,
      }),
    };
    for (const region of ["left", "right", "bottom"] as const) {
      layout.regions[region].slots = layout.regions[region].slots.map(
        (slot) => ({
          ...slot,
          panels: slot.panels.filter((id) => id !== "kouetsu"),
          activePanel: slot.activePanel === "kouetsu" ? null : slot.activePanel,
        }),
      );
    }

    useLayoutStore.setState({
      layout,
      draggingPanel: "codex",
    });
    useLayoutStore.getState().showPanel("codex");

    const { container } = render(<CenterStripe />);
    const kouetsuSegment = useLayoutStore
      .getState()
      .layout.center.segments.find(
        (s) => s.kind === "tool" && s.panels.includes("kouetsu"),
      );
    expect(kouetsuSegment).toBeDefined();

    const overlay = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        "[data-center-stripe-drop-overlay]",
      );
      expect(el).not.toBeNull();
      return el!;
    });

    const root = container.querySelector<HTMLElement>("[data-stripe-root]");
    const editorBand = container.querySelector<HTMLElement>(
      '[data-center-stripe-band-kind="editor"]',
    );
    const band = container.querySelector<HTMLElement>(
      `[data-drop-slot-id="${kouetsuSegment!.id}"]`,
    );
    expect(root).not.toBeNull();
    expect(editorBand).not.toBeNull();
    expect(band).not.toBeNull();

    vi.spyOn(root!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 32,
      width: 400,
      height: 32,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(editorBand!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 48,
      bottom: 32,
      width: 48,
      height: 32,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(band!, "getBoundingClientRect").mockReturnValue({
      x: 80,
      y: 0,
      left: 80,
      top: 0,
      right: 120,
      bottom: 32,
      width: 40,
      height: 32,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.drop(overlay, {
      clientX: 100,
      clientY: 16,
      dataTransfer: {
        getData: (type: string) =>
          type === TOOL_WINDOW_REASSIGN_TYPE ? "codex" : "",
        types: [TOOL_WINDOW_REASSIGN_TYPE],
      },
    });

    const centerWithCodex = useLayoutStore
      .getState()
      .layout.center.segments.find(
        (s) => s.kind === "tool" && s.panels.includes("codex"),
      );
    expect(centerWithCodex?.kind).toBe("tool");
    if (centerWithCodex?.kind === "tool") {
      expect(centerWithCodex.activePanel).toBe("codex");
    }
    expect(
      useLayoutStore
        .getState()
        .layout.regions.right.slots.some((s) => s.panels.includes("codex")),
    ).toBe(false);
  });

  it("does not mark the editor band as a slot drop target", () => {
    const { container } = render(<CenterStripe />);
    const editorBand = container.querySelector(
      '[data-center-stripe-band-kind="editor"]',
    );
    expect(editorBand?.hasAttribute("data-drop-segment")).toBe(false);
    expect(editorBand?.hasAttribute("data-drop-slot-id")).toBe(false);
  });
});
