// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { importWebEditorWorkspaceHandoff } from "./webEditorWorkspaceImport";
import { WebEditorWorkspaceImportDialog } from "./WebEditorWorkspaceImportDialog";

vi.mock("./webEditorWorkspaceImport", () => ({
  importWebEditorWorkspaceHandoff: vi.fn(),
}));

const importHandoff = vi.mocked(importWebEditorWorkspaceHandoff);

afterEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("ja");
});

describe("WebEditorWorkspaceImportDialog", () => {
  it("stays open when file selection is canceled", async () => {
    importHandoff.mockResolvedValue({ status: "canceled" });
    const onClose = vi.fn();

    render(<WebEditorWorkspaceImportDialog open onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "引き継ぎファイルを選択" }),
    );

    await waitFor(() => expect(importHandoff).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes only after a workspace is imported", async () => {
    importHandoff.mockResolvedValue({
      status: "imported",
      fileName: "draft.grimodex-handoff",
      handoff: {} as never,
      path: "/tmp/workspace",
      projectId: "project-1",
    });
    const onClose = vi.fn();

    render(<WebEditorWorkspaceImportDialog open onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "引き継ぎファイルを選択" }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("shows a recoverable error and leaves the dialog open", async () => {
    importHandoff.mockRejectedValue(new Error("invalid manifest"));
    const onClose = vi.fn();

    render(<WebEditorWorkspaceImportDialog open onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "引き継ぎファイルを選択" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /invalid manifest/,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "引き継ぎファイルを選択" }),
    ).toBeEnabled();
  });
});
