// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { CenterStripe } from "./CenterStripe";
import { useLayoutStore } from "./layoutStore";
import {
  buildCenterSegmentsWithTools,
  buildDefaultLayoutState,
  DEFAULT_EDITOR_SEGMENT_ID,
} from "./layoutStateUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function layoutWithCenterToolsBeforeEditor() {
  const segments = buildCenterSegmentsWithTools(["kouetsu", "codex"], {
    kouetsu: true,
    codex: true,
  });
  return {
    ...buildDefaultLayoutState({ editorOpen: true }),
    center: {
      editorOpen: true,
      segments: [segments[1], segments[2], segments[0]],
    },
  };
}

describe("CenterStripe", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ editorOpen: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      hiddenStripePanels: new Set(),
    });
  });

  it("uses a nested grid aligned with the center content columns", () => {
    const { container } = render(<CenterStripe />);
    const stripe = container.querySelector<HTMLElement>("[data-center-stripe]");
    expect(stripe?.className).toContain("grid");
    expect(stripe?.style.gridTemplateColumns).toContain("minmax(0, 1fr)");
  });

  it("distributes flex-grow among open segments including editor", () => {
    useLayoutStore.setState({
      layout: {
        ...buildDefaultLayoutState({ editorOpen: true }),
        center: {
          editorOpen: true,
          segments: [
            { id: DEFAULT_EDITOR_SEGMENT_ID, kind: "editor", sizeRatio: 2 },
            {
              id: "ct0",
              kind: "tool",
              sizeRatio: 1,
              panels: ["kouetsu"],
              activePanel: "kouetsu",
            },
            {
              id: "ct1",
              kind: "tool",
              sizeRatio: 1,
              panels: ["codex"],
              activePanel: "codex",
            },
          ],
        },
      },
      hiddenStripePanels: new Set(),
    });

    const { container } = render(<CenterStripe />);
    const bands = [
      ...container.querySelectorAll<HTMLElement>("[data-center-stripe-band]"),
    ];
    expect(bands).toHaveLength(3);
    const grow = bands.map((el) => Number(el.style.flexGrow));
    expect(grow[0]).toBeCloseTo(0.5, 5);
    expect(grow[1]).toBeCloseTo(0.25, 5);
    expect(grow[2]).toBeCloseTo(0.25, 5);
  });

  it("renders editor icon after tool icons when editor segment is last", () => {
    useLayoutStore.setState({
      layout: layoutWithCenterToolsBeforeEditor(),
      hiddenStripePanels: new Set(),
    });

    const { container } = render(<CenterStripe />);
    const icons = [
      ...container.querySelectorAll<HTMLElement>("[data-stripe-icon]"),
    ].map((el) => el.dataset.stripeIcon);
    expect(icons).toEqual(["kouetsu", "codex", "editor"]);
  });

  it("excludes editor from open flex-grow when editor is closed", () => {
    useLayoutStore.setState({
      layout: {
        ...layoutWithCenterToolsBeforeEditor(),
        center: {
          ...layoutWithCenterToolsBeforeEditor().center,
          editorOpen: false,
        },
      },
      hiddenStripePanels: new Set(),
    });

    const { container } = render(<CenterStripe />);
    const openBands = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-center-stripe-band][data-band-open="true"]',
      ),
    ];
    expect(openBands).toHaveLength(2);
    const grow = openBands.map((el) => Number(el.style.flexGrow));
    expect(grow[0]).toBeCloseTo(0.5, 5);
    expect(grow[1]).toBeCloseTo(0.5, 5);
    expect(
      container.querySelector('[data-stripe-icon="editor"]'),
    ).not.toBeNull();
  });
});
