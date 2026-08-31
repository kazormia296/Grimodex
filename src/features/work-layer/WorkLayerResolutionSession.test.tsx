// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { WorkLayerPrototypePreview } from "./WorkLayerPrototypePreview";

describe("Work Layer preview resolution session", () => {
  it("does not offer an already resolved Finding again after resolving A then B", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="projection" />);

    const projection = await screen.findByRole("dialog", {
      name: "Resolve Projection",
    });
    await user.click(
      within(projection).getByRole("button", {
        name: "アリス・レインへBindingをプレビュー",
      }),
    );

    const firstReceipt = await screen.findByRole("status", {
      name: "プレビュー判断の受領証",
    });
    await user.click(
      within(firstReceipt).getByRole("button", {
        name: "次: Chronicle『脱獄』のEvidenceが見つからないをChange Reviewで開く",
      }),
    );

    const review = await screen.findByRole("dialog", { name: "Change Review" });
    await user.click(
      within(review).getByRole("button", { name: "Proposal を適用" }),
    );

    const finalReceipt = await screen.findByRole("status", {
      name: "プレビュー判断の受領証",
    });
    expect(
      within(finalReceipt).queryByRole("button", { name: /^次:/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Attention 0件" }),
    ).toBeInTheDocument();
  });
});
