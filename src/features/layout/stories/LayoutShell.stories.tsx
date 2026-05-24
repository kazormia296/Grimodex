import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { vi } from "vitest";
import { LayoutShell } from "../LayoutShell";
import { useLayoutStore } from "../layoutStore";
import { buildDefaultLayoutState } from "../layoutStateUtils";
import type { PanelId } from "../panelIds";
import { LayoutStoryPanelStub } from "./LayoutStoryPanelStub";

vi.mock("../panelComponents", () => {
  const stub = ({ panelId }: { panelId: PanelId }) => (
    <LayoutStoryPanelStub panelId={panelId} />
  );
  return {
    PANEL_COMPONENT_MAP: new Proxy(
      {},
      {
        get: (_target, prop) => () =>
          stub({ panelId: String(prop) as PanelId }),
      },
    ),
  };
});

vi.mock("../EditorArea", () => ({
  EditorArea: () => (
    <div
      data-editor-area
      className="flex h-full w-full items-center justify-center bg-muted/10 text-sm"
    >
      editor
    </div>
  ),
}));

function resetLayoutStore(preset: "write" | "default" = "write") {
  if (preset === "write") {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      panelDragSource: null,
      panelDragOffset: null,
      hiddenStripePanels: new Set(),
      initialized: true,
    });
    useLayoutStore.getState().applyPreset("builtin:plan");
    return;
  }

  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ allInactive: true }),
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    panelDragSource: null,
    panelDragOffset: null,
    hiddenStripePanels: new Set(),
    initialized: true,
  });
}

const meta: Meta<typeof LayoutShell> = {
  title: "features/layout/LayoutShell",
  component: LayoutShell,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => {
      resetLayoutStore("write");
      return (
        <div style={{ width: 1200, height: 800 }}>
          <Story />
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof LayoutShell>;

export const Default: Story = {};

export const LayoutLocked: Story = {
  decorators: [
    (Story) => {
      resetLayoutStore("write");
      useLayoutStore.setState({ layoutLocked: true });
      return (
        <div style={{ width: 1200, height: 800 }}>
          <Story />
        </div>
      );
    },
  ],
  play: async ({ canvasElement }) => {
    const scenesIcon = canvasElement.querySelector<HTMLElement>(
      '[data-stripe-icon="scenes"]',
    );
    expect(scenesIcon).toBeTruthy();
    await userEvent.click(scenesIcon!);
    expect(useLayoutStore.getState().layoutLocked).toBe(true);
  },
};

export const StripeReorder: Story = {
  play: async ({ canvasElement }) => {
    // builtin:plan places `codex` in the right region (slot r405a4231 with
    // codex/snippets/matrix/foreshadow), not the left.
    const layout = useLayoutStore.getState().layout;
    const slot = layout.regions.right.slots.find((s) =>
      s.panels.includes("codex"),
    );
    expect(slot).toBeDefined();
    if (!slot || slot.panels.length < 2) return;

    const orderBefore = [...slot.panels];
    const codexIcon = canvasElement.querySelector<HTMLElement>(
      '[data-stripe-icon="codex"]',
    );
    expect(codexIcon).toBeTruthy();

    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: codexIcon! },
      { coords: { clientX: 200, clientY: 120 } },
      { keys: "[/MouseLeft]" },
    ]);

    const after = useLayoutStore
      .getState()
      .layout.regions.right.slots.find((s) => s.id === slot.id);
    expect(after?.panels).toEqual(orderBefore);
  },
};

export const CrossRegionMove: Story = {
  play: async ({ canvasElement }) => {
    const chatIcon = canvasElement.querySelector<HTMLElement>(
      '[data-stripe-icon="chat"]',
    );
    expect(chatIcon).toBeTruthy();

    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: chatIcon! },
      { coords: { clientX: 80, clientY: 200 } },
      { keys: "[/MouseLeft]" },
    ]);

    const location = useLayoutStore
      .getState()
      .layout.regions.left.slots.flatMap((s) => s.panels);
    expect(location.includes("chat")).toBe(true);
  },
};
