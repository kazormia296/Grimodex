import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { vi } from "vitest";
import { ForeshadowPanel } from "./ForeshadowPanel";

const ITEMS = [
  {
    id: "1",
    title: "計画中アイテム",
    label: "planned",
    intent: null,
    setupCount: 0,
  },
  {
    id: "2",
    title: "設置済みアイテム",
    label: "seeded",
    intent: null,
    setupCount: 1,
  },
  {
    id: "3",
    title: "回収済みアイテム",
    label: "paid",
    intent: null,
    setupCount: 1,
  },
];

vi.mock("./foreshadowStore", () => ({
  publishAuthoritativeForeshadowRows: vi.fn(),
  useForeshadowStore: () => ({
    items: ITEMS,
    isLoading: false,
    load: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    remove: vi.fn(),
    setupsByForeshadowId: {},
    loadSetups: vi.fn().mockResolvedValue(undefined),
    removeSetup: vi.fn(),
  }),
}));

vi.mock("./CreateForeshadowDialog", () => ({
  CreateForeshadowDialog: () => null,
}));

const meta: Meta<typeof ForeshadowPanel> = {
  title: "features/foreshadow/ForeshadowPanel",
  component: ForeshadowPanel,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div style={{ width: 300, height: 500, border: "1px solid #ccc" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ForeshadowPanel>;

export const Default: Story = {};

export const FilterByPlanned: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // 初期状態: 全アイテム表示
    await expect(canvas.getByText("計画中アイテム")).toBeInTheDocument();
    await expect(canvas.getByText("設置済みアイテム")).toBeInTheDocument();
    await expect(canvas.getByText("回収済みアイテム")).toBeInTheDocument();

    // planned フィルタをクリック
    await userEvent.click(canvas.getByTestId("foreshadow-filter-planned"));

    // 計画中アイテムのみ表示、他は非表示
    await expect(canvas.getByText("計画中アイテム")).toBeInTheDocument();
    await expect(
      canvas.queryByText("設置済みアイテム"),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByText("回収済みアイテム"),
    ).not.toBeInTheDocument();
  },
};

export const FilterClear: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // フィルタを設定してからクリア
    await userEvent.click(canvas.getByTestId("foreshadow-filter-planned"));
    await expect(
      canvas.queryByText("設置済みアイテム"),
    ).not.toBeInTheDocument();

    await userEvent.click(canvas.getByTestId("foreshadow-filter-clear"));

    // 全アイテムが再表示される
    await expect(canvas.getByText("設置済みアイテム")).toBeInTheDocument();
    await expect(canvas.getByText("回収済みアイテム")).toBeInTheDocument();
  },
};

export const MultiFilter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // OR フィルタ: planned + seeded
    await userEvent.click(canvas.getByTestId("foreshadow-filter-planned"));
    await userEvent.click(canvas.getByTestId("foreshadow-filter-seeded"));

    await expect(canvas.getByText("計画中アイテム")).toBeInTheDocument();
    await expect(canvas.getByText("設置済みアイテム")).toBeInTheDocument();
    await expect(
      canvas.queryByText("回収済みアイテム"),
    ).not.toBeInTheDocument();
  },
};
