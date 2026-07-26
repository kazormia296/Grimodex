// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { TransferDialog, type TransferTab } from "./TransferDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
    className,
    testId,
  }: {
    open: boolean;
    children: ReactNode;
    className?: string;
    testId?: string;
  }) =>
    open ? (
      <div className={className} data-testid={testId ?? "overlay"}>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/features/import/ImportDialog", () => ({
  ImportDialogBody: ({
    onBusyChange,
    onFailureChange,
  }: {
    onBusyChange?: (busy: boolean) => void;
    onFailureChange?: (failed: boolean) => void;
  }) => (
    <div data-testid="body-import">
      <button type="button" onClick={() => onBusyChange?.(true)}>
        mark-import-busy
      </button>
      <button type="button" onClick={() => onBusyChange?.(false)}>
        mark-import-idle
      </button>
      <button type="button" onClick={() => onFailureChange?.(true)}>
        mark-import-failed
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

function setup(
  tab: TransferTab = "import",
  profile: "wide" | "phone" = "wide",
) {
  const onTabChange = vi.fn();
  const onClose = vi.fn();
  render(
    <WorkspaceViewportProvider profile={profile}>
      <TransferDialog
        open
        tab={tab}
        onTabChange={onTabChange}
        onClose={onClose}
      />
    </WorkspaceViewportProvider>,
  );
  return { onTabChange, onClose };
}

describe("TransferDialog", () => {
  it("uses the visual viewport, four safe areas, and horizontal scrolling tabs on phone", () => {
    setup("import", "phone");

    const overlay = screen.getByTestId("transfer-dialog");
    expect(overlay.className).toContain(
      "h-[var(--visual-viewport-height,100dvh)]",
    );
    expect(overlay.className).toContain("w-screen");
    expect(overlay.className).toContain("flex-col");
    expect(overlay.className).toContain("pt-[env(safe-area-inset-top)]");
    expect(overlay.className).toContain("pr-[env(safe-area-inset-right)]");
    expect(overlay.className).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(overlay.className).toContain("pl-[env(safe-area-inset-left)]");
    expect(overlay.className).not.toContain("w-[760px]");

    const tabs = screen.getByRole("tablist", {
      name: "transfer.tablistLabel",
    });
    expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
    expect(tabs.className).toContain("overflow-x-auto");
    expect(tabs.className).toContain("w-full");
    expect(tabs.className).not.toContain("w-[150px]");

    const activeTab = screen.getByTestId("transfer-tab-import");
    expect(activeTab.className).toContain("min-h-11");
    expect(activeTab.className).toContain("shrink-0");

    const closeButton = screen.getByRole("button", { name: "common.close" });
    expect(closeButton.className).toContain("min-h-11");
    expect(closeButton.className).toContain("min-w-11");

    const panel = screen.getByTestId("transfer-dialog-panel");
    expect(panel.className).toContain("overflow-y-auto");
    expect(panel.className).toContain("overflow-x-hidden");
    expect(panel.className).toContain("[&_button]:min-h-11");
  });

  it("retains the bounded desktop dialog and vertical tabs on wide", () => {
    setup("import", "wide");

    const overlay = screen.getByTestId("transfer-dialog");
    expect(overlay.className).toContain("h-[min(600px,85vh)]");
    expect(overlay.className).toContain("w-[760px]");
    expect(overlay.className).toContain("max-w-[92vw]");
    expect(overlay.className).not.toContain("w-screen");
    expect(overlay.className).not.toContain("safe-area-inset");

    const tabs = screen.getByRole("tablist", {
      name: "transfer.tablistLabel",
    });
    expect(tabs).toHaveAttribute("aria-orientation", "vertical");
    expect(tabs.className).toContain("w-[150px]");
    expect(tabs.className).toContain("flex-col");
    expect(tabs.className).not.toContain("overflow-x-auto");

    expect(
      screen.getByRole("button", { name: "common.close" }).className,
    ).toContain("p-1");
    expect(
      screen.getByRole("button", { name: "common.close" }).className,
    ).not.toContain("min-h-11");
    expect(screen.getByTestId("transfer-dialog-panel").className).not.toContain(
      "[&_button]:min-h-11",
    );
  });

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

  it("blocks tab changes after a partial import failure but allows close", () => {
    const { onClose, onTabChange } = setup("import");
    fireEvent.click(screen.getByRole("button", { name: "mark-import-failed" }));

    expect(screen.getByTestId("transfer-tab-novel")).toBeDisabled();
    fireEvent.click(screen.getByTestId("transfer-tab-novel"));
    expect(onTabChange).not.toHaveBeenCalled();

    const closeButton = screen.getByRole("button", { name: "common.close" });
    expect(closeButton).not.toBeDisabled();
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
