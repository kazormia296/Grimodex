// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { WorkLayerPrototypePreview } from "./WorkLayerPrototypePreview";
import { deriveAllWork } from "./workLedgerItems";
import { modelForPrototypeMode } from "./workLayerPrototype";

describe("Work Layer acceptance contracts", () => {
  it("keeps EMPTY Attention visually quiet when its zero-count tray is open", async () => {
    render(<WorkLayerPrototypePreview initialMode="empty" />);

    await screen.findByRole("dialog", { name: "Attentionの作業トレイ" });
    const attention = screen.getByRole("button", { name: "Attention 0件" });
    expect(attention).toHaveClass("text-muted-foreground");
    expect(attention).not.toHaveClass("bg-foreground");
  });

  it("gives EMPTY a self-consistent quiet ledger without active or disposed work", () => {
    const empty = modelForPrototypeMode("empty");

    expect(empty.focus).toBeNull();
    expect(empty.attention).toEqual([]);
    expect(empty.disposedAttention).toEqual([]);
    expect(empty.allWork).toEqual([
      expect.objectContaining({
        title: "伏線『青い剣』の回収位置を再確認",
        status: "waiting",
      }),
      expect.objectContaining({
        title: "東西分断後の時系列を確認",
        status: "waiting",
      }),
      expect.objectContaining({ title: "地下牢の改稿", status: "completed" }),
    ]);
    expect(deriveAllWork(empty)).toEqual(empty.allWork);
    expect(
      deriveAllWork(empty).some(
        (item) => item.status === "active" || item.status === "held",
      ),
    ).toBe(false);
  });

  it("preserves EMPTY's completed and Later work through ALL WORK and the Focus tray", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="empty" />);

    const emptyTray = await screen.findByRole("dialog", {
      name: "Attentionの作業トレイ",
    });
    expect(within(emptyTray).getByText("Focus なし")).toBeInTheDocument();
    expect(within(emptyTray).getByText("LATER")).toBeInTheDocument();
    expect(within(emptyTray).getByText("地下牢の改稿")).toBeInTheDocument();
    expect(
      within(emptyTray).getByText("伏線『青い剣』の回収位置を再確認"),
    ).toBeInTheDocument();
    expect(
      within(emptyTray).getByText("東西分断後の時系列を確認"),
    ).toBeInTheDocument();
    expect(
      within(emptyTray).queryByRole("button", {
        name: /処分済みの判断/,
      }),
    ).not.toBeInTheDocument();

    await user.click(
      within(emptyTray).getByRole("button", {
        name: "すべての作業を開く",
      }),
    );
    const ledger = await screen.findByRole("dialog", { name: "すべての作業" });
    expect(
      within(ledger).getByRole("button", { name: "進行中 0" }),
    ).toBeInTheDocument();
    expect(
      within(ledger).getByRole("button", { name: "待機 2" }),
    ).toBeInTheDocument();
    expect(
      within(ledger).getByRole("button", { name: "完了 1" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ALL WORK" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    const focusTray = await screen.findByRole("dialog", {
      name: "Focusの作業トレイ",
    });
    expect(within(focusTray).getByText("Focus なし")).toBeInTheDocument();
    expect(within(focusTray).getByText("LATER")).toBeInTheDocument();
    expect(within(focusTray).getByText("地下牢の改稿")).toBeInTheDocument();
    expect(
      within(focusTray).getByText("伏線『青い剣』の回収位置を再確認"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "TRAY·FOCUS" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("promotes EMPTY Later work to Focus without losing the remaining or completed ledger", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="empty" />);

    const emptyTray = await screen.findByRole("dialog", {
      name: "Attentionの作業トレイ",
    });
    await user.click(
      within(emptyTray).getByRole("button", {
        name: "伏線『青い剣』の回収位置を再確認へFocusを切り替える",
      }),
    );

    const focusTray = await screen.findByRole("dialog", {
      name: "Focusの作業トレイ",
    });
    expect(
      within(focusTray).getByRole("heading", {
        name: "伏線『青い剣』の回収位置を再確認",
      }),
    ).toBeInTheDocument();
    expect(
      within(focusTray).getByRole("button", {
        name: "東西分断後の時系列を確認へFocusを切り替える",
      }),
    ).toBeInTheDocument();
    expect(
      within(focusTray).queryByRole("button", {
        name: "伏線『青い剣』の回収位置を再確認へFocusを切り替える",
      }),
    ).not.toBeInTheDocument();
    await user.click(
      within(focusTray).getByRole("button", {
        name: "すべての作業を開く",
      }),
    );
    const ledger = await screen.findByRole("dialog", { name: "すべての作業" });
    expect(
      within(ledger).getByRole("button", { name: "進行中 1" }),
    ).toBeInTheDocument();
    expect(
      within(ledger).getByRole("button", { name: "待機 1" }),
    ).toBeInTheDocument();
    expect(
      within(ledger).getByRole("button", { name: "完了 1" }),
    ).toBeInTheDocument();
    expect(within(ledger).getByText("地下牢の改稿")).toBeInTheDocument();
  });

  it("keeps the normal Focus tray and ALL WORK ledger aligned after switching Later work", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="tray-focus" />);

    const tray = await screen.findByRole("dialog", {
      name: "Focusの作業トレイ",
    });
    await user.click(
      within(tray).getByRole("button", {
        name: "伏線『青い剣』の回収位置を再確認へFocusを切り替える",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "すべての作業を開く" }),
    );

    const ledger = await screen.findByRole("dialog", { name: "すべての作業" });
    expect(
      within(ledger).getByRole("button", { name: "進行中 1" }),
    ).toBeInTheDocument();
    await user.click(within(ledger).getByRole("button", { name: "進行中 1" }));
    expect(
      within(ledger).getByText("伏線『青い剣』の回収位置を再確認"),
    ).toBeInTheDocument();
  });

  it("opens source-missing Evidence directly in Change Review", async () => {
    const user = userEvent.setup();
    render(<WorkLayerPrototypePreview initialMode="tray-attention" />);

    const tray = await screen.findByRole("dialog", {
      name: "Attentionの作業トレイ",
    });
    await user.click(
      within(tray).getByRole("button", {
        name: "Chronicle『脱獄』のEvidenceが見つからないをChange Reviewで開く",
      }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Change Review" }),
    ).toHaveTextContent("Chronicle『脱獄』のEvidenceが見つからない");
    expect(
      screen.queryByRole("dialog", { name: "Resolve Lens" }),
    ).not.toBeInTheDocument();
  });
});
