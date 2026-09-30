// @vitest-environment happy-dom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { WorkLayerPrototypePreview } from "./WorkLayerPrototypePreview";

describe("Work Layer lens and projection acceptance", () => {
  it("projects the selected Finding into the manuscript, Scene tree, and Codex while keeping Lens actions available", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="lens" />);

    const lens = await screen.findByRole("dialog", { name: "Resolve Lens" });
    expect(
      within(lens).getByTestId("work-layer-lens-anchor"),
    ).toHaveTextContent("アリス");
    expect(
      within(lens).getByTestId("work-layer-editor-anchor"),
    ).toHaveTextContent("アリス");
    expect(within(lens).getByTestId("work-layer-editor-anchor")).toHaveClass(
      "border-b-2",
    );
    expect(
      within(lens).getByTestId("work-layer-lens-leader"),
    ).toBeInTheDocument();
    expect(within(lens).getByText("SCENE ATTN · 2")).toBeInTheDocument();
    expect(within(lens).getByText("CODEX CAND · 2")).toBeInTheDocument();
    expect(
      within(lens).getByRole("region", { name: "影響" }),
    ).toHaveTextContent("Chronicle Event『脱獄』");

    await user.click(within(lens).getByRole("button", { name: "保留" }));
    expect(within(lens).getByRole("status")).toHaveTextContent(
      "保留をプレビューしました。保存されていません。",
    );
    await user.click(
      within(lens).getByRole("button", {
        name: "この2件を今後同一候補にしない",
      }),
    );
    expect(within(lens).getByRole("status")).toHaveTextContent(
      "候補ペアの除外をプレビューしました。保存されていません。",
    );

    await user.click(
      within(lens).getByRole("button", {
        name: "次: Chronicle『脱獄』のEvidenceが見つからない",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Change Review" }),
    ).toHaveTextContent("Chronicle『脱獄』のEvidenceが見つからない");
    expect(
      screen.queryByRole("dialog", { name: "Resolve Lens" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    const projection = await screen.findByRole("dialog", {
      name: "Resolve Projection",
    });
    expect(
      within(projection).getByRole("button", {
        name: "Chronicle『脱獄』のEvidenceが見つからない",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(
        within(projection).getByRole("button", { name: "一段戻る" }),
      ).toHaveFocus(),
    );
  });

  it("shares the selected candidate between Context Portal and its Lens", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="portal" />);

    const lens = await screen.findByRole("dialog", { name: "Resolve Lens" });
    const portal = await screen.findByRole("dialog", {
      name: "Context Portal",
    });
    expect(lens).toContainElement(portal);
    expect(within(lens).getByText("Scene 12 · ¶2")).toBeInTheDocument();
    expect(
      within(lens).getByText("Surface『アリス』が2件の候補に一致"),
    ).toBeInTheDocument();
    expect(
      within(lens).getByRole("region", { name: "影響" }),
    ).toBeInTheDocument();

    await user.click(
      within(portal).getByRole("radio", { name: "アリス・ハーグ" }),
    );
    await user.click(
      within(portal).getByRole("button", {
        name: "Context Portalを閉じる",
      }),
    );
    expect(
      within(lens).getByRole("radio", { name: "アリス・ハーグ" }),
    ).toBeChecked();

    await user.click(
      within(lens).getByRole("button", { name: "Context Portalを開く" }),
    );
    expect(
      within(
        await screen.findByRole("dialog", { name: "Context Portal" }),
      ).getByRole("radio", { name: "アリス・ハーグ" }),
    ).toBeChecked();

    fireEvent.keyDown(document, { key: "Escape" });
    await user.click(
      within(lens).getByRole("radio", { name: "新しい人物として作成" }),
    );
    await user.click(
      within(lens).getByRole("button", { name: "Context Portalを開く" }),
    );
    expect(
      within(
        await screen.findByRole("dialog", { name: "Context Portal" }),
      ).getByRole("radio", { name: "新しい人物として作成" }),
    ).toBeChecked();
  });

  it("offers the UI-only new-person Binding branch in the Lens", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="lens" />);

    const lens = await screen.findByRole("dialog", { name: "Resolve Lens" });
    await user.click(
      within(lens).getByRole("radio", { name: "新しい人物として作成" }),
    );
    expect(
      within(lens).getByRole("button", {
        name: "新しい人物として作成へBindingをプレビュー",
      }),
    ).toBeInTheDocument();
  });

  it("routes a Binding receipt's next Finding back to Resolve Lens", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="change-review" />);

    const review = await screen.findByRole("dialog", {
      name: "Change Review",
    });
    await user.click(
      within(review).getByRole("button", { name: "Proposal を適用" }),
    );
    const receipt = await screen.findByRole("status", {
      name: "プレビュー判断の受領証",
    });
    await user.click(
      within(receipt).getByRole("button", {
        name: "次: 『アリス』の参照先が曖昧をResolve Lensで開く",
      }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Resolve Lens" }),
    ).toHaveTextContent("『アリス』の参照先が曖昧");
    expect(
      screen.queryByRole("dialog", { name: "Change Review" }),
    ).not.toBeInTheDocument();
  });

  it("resolves the default Binding from Projection, including its new-person branch", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="projection" />);

    const projection = await screen.findByRole("dialog", {
      name: "Resolve Projection",
    });
    expect(within(projection).getByText("REBUILD ✓")).toBeInTheDocument();
    const candidateContext = within(projection).getByRole("region", {
      name: "Context Portal · Codex",
    });
    expect(candidateContext).toHaveTextContent("アリス・レイン");
    await user.click(
      within(projection).getByRole("radio", {
        name: "新しい人物として作成",
      }),
    );
    expect(candidateContext).toHaveTextContent("新しい人物として作成");
    await user.click(
      within(projection).getByRole("button", {
        name: "新しい人物として作成へBindingをプレビュー",
      }),
    );
    const receipt = await screen.findByRole("status", {
      name: "プレビュー判断の受領証",
    });
    expect(receipt).toHaveTextContent("新しい人物として作成へ Binding");
    expect(
      within(receipt).getByRole("button", {
        name: "次: Chronicle『脱獄』のEvidenceが見つからないをChange Reviewで開く",
      }),
    ).toBeInTheDocument();
  });

  it("keeps WORK GRAPH and the projection pipeline through Change Review and opens Inspection", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="change-review" />);

    const review = await screen.findByRole("dialog", {
      name: "Change Review",
    });
    expect(within(review).getByText("WORK GRAPH · 2")).toBeInTheDocument();
    expect(within(review).getByText("REBUILD ✓")).toBeInTheDocument();
    const inspect = within(review).getByRole("button", { name: "詳細を検査" });
    await user.click(inspect);
    expect(
      await screen.findByRole("dialog", { name: "Deep Inspection" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await screen.findByRole("dialog", { name: "Change Review" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "詳細を検査" })).toHaveFocus(),
    );
  });

  it("offers individual review, aggregate impact, and Deep Inspection from Batch Review", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="batch" />);

    const batch = await screen.findByRole("dialog", { name: "Batch Review" });
    const impact = within(batch).getByRole("region", {
      name: "承認した場合の影響",
    });
    expect(impact).toHaveTextContent(
      "Chronicle · Event +2 / State +1 / Relation +1",
    );
    expect(
      within(batch).getByRole("button", { name: "Deep Inspectionを開く" }),
    ).toBeInTheDocument();
    expect(within(batch).getByText("WORK GRAPH · 2")).toBeInTheDocument();
    expect(within(batch).getByText("REBUILD ✓")).toBeInTheDocument();

    const individual = within(batch).getByRole("button", {
      name: "個別に見る",
    });
    await user.click(individual);
    expect(
      await screen.findByRole("dialog", { name: "Change Review" }),
    ).toHaveTextContent("Chronicle『脱獄』のEvidenceが見つからない");

    fireEvent.keyDown(document, { key: "Escape" });
    const returnedBatch = await screen.findByRole("dialog", {
      name: "Batch Review",
    });
    await waitFor(() =>
      expect(
        within(returnedBatch).getByRole("button", { name: "個別に見る" }),
      ).toHaveFocus(),
    );
    await user.click(
      within(returnedBatch).getByRole("button", {
        name: "Deep Inspectionを開く",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Deep Inspection" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    const finalBatch = await screen.findByRole("dialog", {
      name: "Batch Review",
    });
    await waitFor(() =>
      expect(
        within(finalBatch).getByRole("button", {
          name: "Deep Inspectionを開く",
        }),
      ).toHaveFocus(),
    );
  });
});
