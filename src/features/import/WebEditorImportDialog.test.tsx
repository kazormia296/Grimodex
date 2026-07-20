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
  }) => (open ? <div>{children}</div> : null),
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
