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
import { MIN_EDITOR_SIZE, MIN_SLOT_SIZE } from "./layoutConstants";

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

  it("keeps a collapsed tool icon visible in flow when placed left of the editor", () => {
    // base = [editor, tool(codex, collapsed)] → tool を editor の左へ並べ替える
    const base = buildCenterSegmentsWithTools(["codex"], { codex: false });
    useLayoutStore.setState({
      layout: {
        ...buildDefaultLayoutState({ editorOpen: true }),
        center: { editorOpen: true, segments: [base[1], base[0]] },
      },
      hiddenStripePanels: new Set(),
    });

    const { container } = render(<CenterStripe />);

    // collapsed tool のアイコンが描画されている
    expect(
      container.querySelector('[data-stripe-icon="codex"]'),
    ).not.toBeNull();

    // 先頭 collapsed クラスタは in-flow（0 幅 absolute オーバーレイにしない）
    const cluster = container.querySelector<HTMLElement>(
      "[data-stripe-collapsed-cluster]",
    );
    expect(cluster).not.toBeNull();
    expect(cluster?.className).not.toContain("absolute");
    expect(cluster?.querySelector(".absolute")).toBeNull();
    expect(cluster?.style.flexBasis).not.toBe("0px");

    // DOM 順は collapsed tool → editor（後続バンドに隠れない）
    const icons = [
      ...container.querySelectorAll<HTMLElement>("[data-stripe-icon]"),
    ].map((el) => el.dataset.stripeIcon);
    expect(icons).toEqual(["codex", "editor"]);
  });

  it("keeps a non-leading collapsed tool icon clickable", () => {
    // [editor(open), tool(codex, collapsed)] → 非先頭 collapsed クラスタ
    useLayoutStore.setState({
      layout: {
        ...buildDefaultLayoutState({ editorOpen: true }),
        center: {
          editorOpen: true,
          segments: buildCenterSegmentsWithTools(["codex"], { codex: false }),
        },
      },
      hiddenStripePanels: new Set(),
    });

    const { container } = render(<CenterStripe />);

    const icon = container.querySelector<HTMLElement>(
      '[data-stripe-icon="codex"]',
    );
    expect(icon).not.toBeNull();

    const cluster = container.querySelector<HTMLElement>(
      "[data-stripe-collapsed-cluster]",
    );
    expect(cluster).not.toBeNull();
    expect(cluster?.contains(icon)).toBe(true);

    // collapsed アイコンの祖先に pointer-events-none が無い（クリック可能）
    const root = container.querySelector("[data-stripe-root]");
    for (
      let node: HTMLElement | null = icon;
      node && node !== root;
      node = node.parentElement
    ) {
      expect(node.className).not.toContain("pointer-events-none");
    }
  });

  it("clamps open stripe bands to the center content min-width", () => {
    useLayoutStore.setState({
      layout: {
        ...buildDefaultLayoutState({ editorOpen: true }),
        center: {
          editorOpen: true,
          segments: [
            { id: DEFAULT_EDITOR_SEGMENT_ID, kind: "editor", sizeRatio: 1 },
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
              activePanel: null,
            },
          ],
        },
      },
      hiddenStripePanels: new Set(),
    });

    const { container } = render(<CenterStripe />);

    const editorBand = container.querySelector<HTMLElement>(
      '[data-center-stripe-band-kind="editor"]',
    );
    const openToolBand = container.querySelector<HTMLElement>(
      '[data-center-stripe-band-kind="tool"][data-band-open="true"]',
    );
    const collapsedToolBand = container.querySelector<HTMLElement>(
      '[data-center-stripe-band-kind="tool"][data-band-open="false"]',
    );

    // open バンドは CenterContent の各列と同じ min-width でクランプ
    expect(editorBand?.style.minWidth).toBe(`${MIN_EDITOR_SIZE}px`);
    expect(openToolBand?.style.minWidth).toBe(`${MIN_SLOT_SIZE}px`);
    // 折りたたみバンドはアイコン実寸（min-width なし）
    expect(collapsedToolBand?.style.minWidth).toBe("");
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

  it("shows editor icon when center band is hidden but a side region stays open", () => {
    const layout = buildDefaultLayoutState({
      allInactive: true,
      editorOpen: false,
    });
    const chatSlot = layout.regions.right.slots.find((slot) =>
      slot.panels.includes("chat"),
    );
    if (chatSlot) chatSlot.activePanel = "chat";

    useLayoutStore.setState({
      layout,
      hiddenStripePanels: new Set(),
    });

    const { container } = render(<CenterStripe />);
    const stripe = container.querySelector<HTMLElement>("[data-center-stripe]");
    expect(stripe?.style.gridTemplateColumns).toContain("auto");
    expect(
      container.querySelector('[data-stripe-icon="editor"]'),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-stripe-collapsed-cluster]"),
    ).toBeNull();
  });

  it("shows editor icon in document flow when every panel is closed", () => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({
        allInactive: true,
        editorOpen: false,
      }),
      hiddenStripePanels: new Set(),
    });

    const { container } = render(<CenterStripe />);
    expect(
      container.querySelector('[data-stripe-icon="editor"]'),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-stripe-collapsed-cluster]"),
    ).toBeNull();
    expect(
      container.querySelector('[data-center-stripe-band-kind="editor"]'),
    ).not.toBeNull();
  });
});
