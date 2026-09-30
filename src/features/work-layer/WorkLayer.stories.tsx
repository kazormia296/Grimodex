import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { WorkLayerPrototypePreview } from "./WorkLayerPrototypePreview";

const meta: Meta<typeof WorkLayerPrototypePreview> = {
  title: "features/work-layer/WorkLayer",
  component: WorkLayerPrototypePreview,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof WorkLayerPrototypePreview>;

export const Ambient: Story = {};

export const Arrival: Story = {
  args: { initialMode: "arrive" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "System recheck" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByTestId("work-layer-arrival-charge"),
    ).toBeInTheDocument();
    await expect(
      within(document.body).getByTestId("work-layer-arrival-gutter"),
    ).toBeInTheDocument();
  },
};
export const FocusTray: Story = { args: { initialMode: "tray-focus" } };
export const AttentionTray: Story = { args: { initialMode: "tray-attention" } };

export const AllWork: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "ALL WORK" }));
    await expect(
      await canvas.findByRole("dialog", { name: "すべての作業" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "ALL WORK" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(
      canvas.getByRole("button", {
        name: "進行中の地下牢の改稿をトレイで開く",
      }),
    );
    await expect(
      await canvas.findByRole("dialog", { name: "Focusの作業トレイ" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "TRAY·FOCUS" }),
    ).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(canvas.getByRole("button", { name: "ALL WORK" }));
    await expect(
      await canvas.findByRole("dialog", { name: "すべての作業" }),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect(
      await canvas.findByRole("dialog", { name: "Focusの作業トレイ" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "TRAY·FOCUS" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const ResolveLens: Story = { args: { initialMode: "lens" } };
export const Resolved: Story = {
  args: { initialMode: "resolved" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const receipt = await canvas.findByRole("status", {
      name: "プレビュー判断の受領証",
    });
    await expect(
      within(receipt).getByRole("button", {
        name: /次: Chronicle『脱獄』のEvidenceが見つからない/,
      }),
    ).toBeInTheDocument();
  },
};
export const ContextPortal: Story = {
  args: { initialMode: "portal" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("dialog", { name: "Context Portal" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByText("Codex")).not.toBeInTheDocument();
  },
};
export const DeepInspection: Story = { args: { initialMode: "inspect" } };
export const Projection: Story = { args: { initialMode: "projection" } };
export const ChangeReview: Story = {
  args: { initialMode: "change-review" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await body.findByRole("dialog", { name: "Change Review" }),
    ).toHaveTextContent("Chronicle『脱獄』のEvidenceが見つからない");
  },
};
export const BatchReview: Story = { args: { initialMode: "batch" } };
export const SystemActivity: Story = {
  args: { initialMode: "system-activity" },
};
export const SystemBlocked: Story = {
  args: { initialMode: "system-blocked" },
};
export const Empty: Story = { args: { initialMode: "empty" } };
export const Disposed: Story = { args: { initialMode: "disposed" } };
