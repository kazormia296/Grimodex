// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanDeleteDialog } from "./ScanDeleteDialog";

afterEach(cleanup);

describe("ScanDeleteDialog", () => {
  it("explains the irreversible deletion boundary before confirming in Japanese", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ScanDeleteDialog
        locale="ja"
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(
      screen.getByRole("dialog", {
        name: "原稿とScanデータを削除しますか？",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/実行中のScanを停止し、Grimodexに保存された原稿/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /AI処理基盤へ送信済みのデータには各プロバイダの保持方針/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Web EditorやローカルGrimodexへ取り込んだコピーは削除されません/,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onCancel).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "原稿とScanデータを削除" }),
    );
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("renders the English boundary and locks both actions while deleting", () => {
    render(
      <ScanDeleteDialog
        locale="en"
        busy
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", {
        name: "Delete the manuscript and Scan data?",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Copies already imported into Web Editor or local Grimodex are not deleted/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  });

  it("keeps the dialog open with a deletion-specific error", () => {
    render(
      <ScanDeleteDialog
        locale="ja"
        busy={false}
        error="削除結果を確認できませんでした。アクセスが停止していない可能性があります。接続を確認して、もう一度お試しください。"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "アクセスが停止していない可能性があります",
    );
    expect(
      screen.getByRole("button", { name: "原稿とScanデータを削除" }),
    ).not.toBeDisabled();
  });
});
