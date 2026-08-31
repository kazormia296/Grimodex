// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import i18next from "@/lib/i18n";

import { WorkLayerPrototypePreview } from "./WorkLayerPrototypePreview";

async function renderReview() {
  render(<WorkLayerPrototypePreview initialMode="change-review" />);
  return screen.findByRole("dialog", { name: "Change Review" });
}

describe("ChangeReview", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("ja");
  });

  it("opens the Chronicle evidence proposal and shows a complete V1/V2 field diff", async () => {
    const review = within(await renderReview());

    expect(
      review.getByRole("heading", {
        name: "Change Review — Chronicle Event「脱獄」 V1→V2",
      }),
    ).toBeInTheDocument();
    expect(
      review.getAllByText("Chronicle『脱獄』のEvidenceが見つからない"),
    ).toHaveLength(2);

    const title = review.getByRole("row", { name: /タイトル/ });
    expect(within(title).getAllByText("脱獄")).toHaveLength(2);
    expect(within(title).getByText("変更なし")).toBeInTheDocument();

    const method = review.getByRole("row", { name: /手段/ });
    expect(within(method).getByText("青い剣で錠を斬り、牢を破る").tagName).toBe(
      "DEL",
    );
    expect(
      within(method).getByText("拾った鍵で錠を開け、牢を出る"),
    ).toHaveAttribute("data-change-bar", "true");

    const period = review.getByRole("row", { name: /時期/ });
    expect(within(period).getAllByText("3年霜月 · 確定")).toHaveLength(2);
    expect(within(period).getByText("変更なし")).toBeInTheDocument();

    const notes = review.getByRole("row", { name: /補足/ });
    expect(within(notes).getByText("剣の呪いが解けたことを示す").tagName).toBe(
      "DEL",
    );
    expect(within(notes).getByText("REMOVED")).toBeInTheDocument();

    const evidence = review.getByRole("row", { name: /Evidence/i });
    expect(
      within(evidence).getByText("「彼女は青い剣を鞘から抜いた」"),
    ).toBeInTheDocument();
    expect(within(evidence).getByText("MISSING")).toBeInTheDocument();
    expect(within(evidence).getByText("v48 に一致なし")).toBeInTheDocument();
    expect(
      within(evidence).getByText("「アリスは鍵を拾い、地下牢を出た」"),
    ).toBeInTheDocument();
    expect(within(evidence).getByText("¶2 · ANCHORED")).toBeInTheDocument();
  });

  it("keeps review, freshness, and projection independent beside trigger and impact evidence", async () => {
    const review = within(await renderReview());

    expect(review.getByText("REVIEW ACCEPTED · V1")).toBeInTheDocument();
    expect(review.getByText("FRESHNESS SOURCE-MISSING")).toBeInTheDocument();
    expect(review.getByText("PROJECTION APPLIED · V1")).toBeInTheDocument();
    expect(review.getByText("変更を引き起こした本文")).toBeInTheDocument();
    expect(
      review.getByText(
        "「アリスは鍵を拾い、地下牢を出た。振り返りはしなかった。」",
      ),
    ).toBeInTheDocument();
    expect(review.getByText("SCENE 12 · ¶2 · v48")).toBeInTheDocument();
    expect(review.getByText("適用した場合の影響")).toBeInTheDocument();
    expect(review.getByText("Timeline「脱獄」ノード")).toBeInTheDocument();
    expect(review.getByText("Related Scenes · 4件")).toBeInTheDocument();
    expect(review.getByText(/適用時: V2/)).toBeInTheDocument();
    expect(review.getByText(/Reject時: V1/)).toBeInTheDocument();
  });

  it.each(["Proposal を適用", "編集して適用", "Reject"])(
    "completes the %s decision in an unsaved UI preview",
    async (action) => {
      const user = userEvent.setup();
      const review = within(await renderReview());

      await user.click(review.getByRole("button", { name: action }));

      const receipt = await screen.findByRole("status", {
        name: "プレビュー判断の受領証",
      });
      expect(within(receipt).getByText(new RegExp(action))).toBeInTheDocument();
      expect(
        within(receipt).getByText(/判断はまだ保存されていません/),
      ).toBeInTheDocument();
      expect(within(receipt).getByText("NOT SAVED")).toBeInTheDocument();
    },
  );

  it.each([
    ["保留", "HOLD"],
    ["このMaterial Basisだけ無視", "BASIS IGNORED"],
  ])(
    "moves %s into its own preview disposition without a resolution receipt",
    async (action, dispositionLabel) => {
      const user = userEvent.setup();
      const review = within(await renderReview());

      await user.click(review.getByRole("button", { name: action }));

      expect(
        screen.queryByRole("status", { name: "プレビュー判断の受領証" }),
      ).not.toBeInTheDocument();
      const tray = within(
        await screen.findByRole("dialog", { name: "Attentionの作業トレイ" }),
      );
      expect(
        tray.queryByText("Chronicle『脱獄』のEvidenceが見つからない"),
      ).not.toBeInTheDocument();
      await user.click(
        tray.getByRole("button", {
          name: "処分済みの判断 5件を開く",
        }),
      );
      const disposed = within(
        screen.getByRole("region", { name: "処分済みの判断" }),
      );
      const disposedTitle = disposed.getByText(
        "Chronicle『脱獄』のEvidenceが見つからない",
      );
      const disposedItem = disposedTitle.closest("div");
      expect(disposedItem).not.toBeNull();
      expect(
        within(disposedItem as HTMLDivElement).getByText(dispositionLabel),
      ).toBeInTheDocument();
    },
  );

  it("opens a correction-rule editor preview without resolving the Finding", async () => {
    const user = userEvent.setup();
    const review = within(await renderReview());

    await user.click(
      review.getByRole("button", { name: "Correction ruleを作成" }),
    );

    expect(
      screen.queryByRole("status", { name: "プレビュー判断の受領証" }),
    ).not.toBeInTheDocument();
    const editor = within(
      screen.getByRole("region", {
        name: "Correction ruleの作成プレビュー",
      }),
    );
    expect(
      editor.getByRole("textbox", { name: "Correction rule" }),
    ).toHaveValue("Evidenceが失われたChronicle Eventを再提案する");
    expect(
      screen.getByRole("dialog", { name: "Change Review" }),
    ).toBeInTheDocument();
  });
});
