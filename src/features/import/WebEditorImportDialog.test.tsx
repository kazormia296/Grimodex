// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";

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
      <div className={className} data-testid={testId}>
        {children}
      </div>
    ) : null,
}));
vi.mock("./importShared", () => ({
  ImportTargetPanel: ({
    importTarget,
    disabled,
  }: {
    importTarget: string;
    disabled?: boolean;
  }) => (
    <div data-testid="import-target" data-disabled={String(disabled)}>
      {importTarget}
    </div>
  ),
}));
vi.mock("./flows/NovelcrafterImportFlow", () => ({
  NovelcrafterImportFlow: ({
    enforceBrowserLimits,
    onBusyChange,
    onFailedChange,
  }: {
    enforceBrowserLimits?: boolean;
    onBusyChange?: (busy: boolean) => void;
    onFailedChange?: (failed: boolean) => void;
  }) => (
    <div
      data-testid="flow-novelcrafter"
      data-browser-limits={String(enforceBrowserLimits)}
    >
      <button type="button" onClick={() => onBusyChange?.(true)}>
        start import
      </button>
      <button type="button" onClick={() => onBusyChange?.(false)}>
        finish import
      </button>
      <button type="button" onClick={() => onFailedChange?.(true)}>
        fail import
      </button>
    </div>
  ),
}));
vi.mock("./flows/KakuyomuImportFlow", () => ({
  KakuyomuImportFlow: () => <div data-testid="flow-kakuyomu" />,
}));
vi.mock("./flows/MarkdownImportFlow", () => ({
  MarkdownImportFlow: ({
    allowNativeFolderPicker,
    enforceBrowserLimits,
  }: {
    allowNativeFolderPicker?: boolean;
    enforceBrowserLimits?: boolean;
  }) => (
    <div
      data-testid="flow-markdown"
      data-native-folder-picker={String(allowNativeFolderPicker)}
      data-browser-limits={String(enforceBrowserLimits)}
    />
  ),
}));
vi.mock("./flows/NovelImportFlow", () => ({
  NovelImportFlow: () => <div data-testid="flow-novel" />,
}));

import { WebEditorImportDialog } from "./WebEditorImportDialog";

afterEach(cleanup);

describe("WebEditorImportDialog", () => {
  it("uses the visual viewport, safe padding, and bounded scrolling on phone", () => {
    render(
      <WorkspaceViewportProvider profile="phone">
        <WebEditorImportDialog open onClose={vi.fn()} />
      </WorkspaceViewportProvider>,
    );

    const overlay = screen.getByTestId("web-editor-import-dialog");
    expect(overlay.className).toContain(
      "h-[var(--visual-viewport-height,100dvh)]",
    );
    expect(overlay.className).toContain("w-screen");
    expect(overlay.className).toContain("min-w-0");
    expect(overlay.className).toContain(
      "pl-[max(1rem,env(safe-area-inset-left))]",
    );
    expect(overlay.className).not.toContain("w-[680px]");

    const dialog = screen.getByRole("dialog", {
      name: "import.dialogTitleUnified",
    });
    expect(dialog.className).toContain("overflow-hidden");
    expect(dialog.className).toContain("min-w-0");

    const closeButton = screen.getByRole("button", { name: "common.close" });
    expect(closeButton.className).toContain("min-h-11");
    expect(closeButton.className).toContain("min-w-11");

    const flow = screen.getByTestId("web-editor-import-flow");
    expect(flow.className).toContain("overflow-y-auto");
    expect(flow.className).toContain("overflow-x-hidden");
  });

  it("retains the bounded desktop dialog contract", () => {
    render(<WebEditorImportDialog open onClose={vi.fn()} />);

    const overlay = screen.getByTestId("web-editor-import-dialog");
    expect(overlay.className).toContain("h-[min(560px,85vh)]");
    expect(overlay.className).toContain("w-[680px]");
    expect(overlay.className).toContain("max-w-[92vw]");
    expect(overlay.className).toContain("p-6");
    expect(overlay.className).not.toContain("w-screen");

    const closeButton = screen.getByRole("button", { name: "common.close" });
    expect(closeButton.className).toContain("p-1");
    expect(closeButton.className).not.toContain("min-h-11");
  });

  it("offers only browser-local manuscript formats and never exposes Scan or export", () => {
    render(<WebEditorImportDialog open onClose={vi.fn()} />);

    expect(
      screen.getByRole("dialog", { name: "import.dialogTitleUnified" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("hostedEditor.import.localOnlyNotice"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("import-source-novelcrafter"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("import-source-kakuyomu")).toBeInTheDocument();
    expect(screen.getByTestId("import-source-markdown")).toBeInTheDocument();
    expect(screen.getByTestId("import-source-novel")).toBeInTheDocument();
    expect(screen.queryByTestId("import-source-scan")).toBeNull();
    expect(screen.queryByTestId("transfer-tab-zip")).toBeNull();
    expect(screen.queryByTestId("transfer-tab-novel")).toBeNull();
    expect(screen.getByTestId("flow-novelcrafter")).toHaveAttribute(
      "data-browser-limits",
      "true",
    );
  });

  it("keeps the existing target defaults while switching among allowed formats", async () => {
    render(<WebEditorImportDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId("import-target")).toHaveTextContent("newProject");

    fireEvent.click(screen.getByTestId("import-source-markdown"));
    expect(screen.getByTestId("flow-markdown")).toHaveAttribute(
      "data-native-folder-picker",
      "false",
    );
    expect(screen.getByTestId("flow-markdown")).toHaveAttribute(
      "data-browser-limits",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByTestId("import-target")).toHaveTextContent(
        "currentProject",
      ),
    );
  });

  it("closes from its explicit close control", () => {
    const onClose = vi.fn();
    render(<WebEditorImportDialog open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("locks close, source, and target controls while an import is running", () => {
    const onClose = vi.fn();
    render(<WebEditorImportDialog open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "start import" }));

    const closeButton = screen.getByRole("button", { name: "common.close" });
    expect(closeButton).toBeDisabled();
    expect(screen.getByTestId("import-target")).toHaveAttribute(
      "data-disabled",
      "true",
    );
    fireEvent.click(screen.getByTestId("import-source-markdown"));
    fireEvent.click(closeButton);
    expect(screen.getByTestId("import-source-novelcrafter")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "finish import" }));
    expect(closeButton).not.toBeDisabled();
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("locks source and target after a partial failure but still allows close", () => {
    const onClose = vi.fn();
    render(<WebEditorImportDialog open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "fail import" }));

    const closeButton = screen.getByRole("button", { name: "common.close" });
    expect(closeButton).not.toBeDisabled();
    expect(screen.getByTestId("import-target")).toHaveAttribute(
      "data-disabled",
      "true",
    );
    expect(screen.getByTestId("import-source-markdown")).toBeDisabled();
    fireEvent.click(screen.getByTestId("import-source-markdown"));
    expect(screen.getByTestId("import-source-novelcrafter")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
