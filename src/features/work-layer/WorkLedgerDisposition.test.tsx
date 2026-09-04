// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import i18next from "@/lib/i18n";

import { WorkLayerPrototypePreview } from "./WorkLayerPrototypePreview";

describe("ALL WORK preview dispositions", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("ja");
  });

  it.each([
    ["保留", "HOLD"],
    ["このMaterial Basisだけ無視", "BASIS IGNORED"],
  ])(
    "projects %s into ALL WORK by the Finding identity",
    async (action, dispositionTag) => {
      const user = userEvent.setup();
      render(<WorkLayerPrototypePreview initialMode="change-review" />);

      const review = await screen.findByRole("dialog", {
        name: "Change Review",
      });
      await user.click(within(review).getByRole("button", { name: action }));

      const tray = await screen.findByRole("dialog", {
        name: "Attentionの作業トレイ",
      });
      await user.click(
        within(tray).getByRole("button", { name: "すべての作業を開く" }),
      );

      const ledger = await screen.findByRole("dialog", {
        name: "すべての作業",
      });
      expect(
        within(ledger).getByRole("button", { name: "保留 4" }),
      ).toBeInTheDocument();

      const finding = within(ledger).getByText(
        "Chronicle『脱獄』のEvidenceが見つからない",
      );
      const findingRow = finding.closest('[data-status="held"]');
      expect(findingRow).not.toBeNull();
      expect(
        within(findingRow as HTMLElement).getByText(dispositionTag),
      ).toBeInTheDocument();
    },
  );
});
