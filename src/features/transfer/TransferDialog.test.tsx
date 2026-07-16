// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransferDialog, type TransferTab } from "./TransferDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div data-testid="overlay">{children}</div> : null),
}));

vi.mock("@/features/import/ImportDialog", () => ({
  ImportDialogBody: ({
    onBusyChange,
  }: {
    onBusyChange?: (busy: boolean) => void;
  }) => (
    <div data-testid="body-import">
      <button type="button" onClick={() => onBusyChange?.(true)}>
        mark-import-busy
      </button>
      <button type="button" onClick={() => onBusyChange?.(false)}>
        mark-import-idle
      </button>
    </div>
  ),
}));
vi.mock("@/features/export/ZipExportDialog", () => ({
  ZipExportBody: () => <div data-testid="body-zip" />,
}));
vi.mock("@/features/export/NovelExportDialog", () => ({
  NovelExportBody: () => <div data-testid="body-novel" />,
}));

function setup(tab: TransferTab = "import") {
  const onTabChange = vi.fn();
  const onClose = vi.fn();
  render(
    <TransferDialog
      open
      tab={tab}
      onTabChange={onTabChange}
      onClose={onClose}
    />,
  );
  return { onTabChange, onClose };
}

describe("TransferDialog", () => {
  it("renders three tabs and only the active tab's body", () => {
    setup("import");
    expect(screen.getByTestId("transfer-tab-import")).toBeInTheDocument();
    expect(screen.getByTestId("transfer-tab-zip")).toBeInTheDocument();
    expect(screen.getByTestId("transfer-tab-novel")).toBeInTheDocument();
    expect(screen.getByTestId("body-import")).toBeInTheDocument();
    expect(screen.queryByTestId("body-zip")).toBeNull();
    expect(screen.queryByTestId("body-novel")).toBeNull();
  });

  it("opens the zip body when the export entry targets the zip tab", () => {
    setup("zip");
    expect(screen.getByTestId("body-zip")).toBeInTheDocument();
    expect(screen.queryByTestId("body-import")).toBeNull();
  });

  it("requests a tab change when another tab is clicked", () => {
    const { onTabChange } = setup("import");
    fireEvent.click(screen.getByTestId("transfer-tab-novel"));
    expect(onTabChange).toHaveBeenCalledWith("novel");
  });

  it("marks the active tab with aria-selected", () => {
    setup("zip");
    expect(screen.getByTestId("transfer-tab-zip")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("transfer-tab-import")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("blocks close and tab changes while the import body is busy", () => {
    const { onClose, onTabChange } = setup("import");
    fireEvent.click(screen.getByRole("button", { name: "mark-import-busy" }));
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    fireEvent.click(screen.getByTestId("transfer-tab-novel"));
    expect(onClose).not.toHaveBeenCalled();
    expect(onTabChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "mark-import-idle" }));
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
