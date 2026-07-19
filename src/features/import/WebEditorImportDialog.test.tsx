// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  ImportTargetPanel: ({ importTarget }: { importTarget: string }) => (
    <div data-testid="import-target">{importTarget}</div>
  ),
}));
vi.mock("./flows/NovelcrafterImportFlow", () => ({
  NovelcrafterImportFlow: () => <div data-testid="flow-novelcrafter" />,
}));
vi.mock("./flows/KakuyomuImportFlow", () => ({
  KakuyomuImportFlow: () => <div data-testid="flow-kakuyomu" />,
}));
vi.mock("./flows/MarkdownImportFlow", () => ({
  MarkdownImportFlow: ({
    allowNativeFolderPicker,
  }: {
    allowNativeFolderPicker?: boolean;
  }) => (
    <div
      data-testid="flow-markdown"
      data-native-folder-picker={String(allowNativeFolderPicker)}
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
    expect(screen.getByText("hostedEditor.import.localOnlyNotice")).toBeInTheDocument();
    expect(screen.getByTestId("import-source-novelcrafter")).toBeInTheDocument();
    expect(screen.getByTestId("import-source-kakuyomu")).toBeInTheDocument();
    expect(screen.getByTestId("import-source-markdown")).toBeInTheDocument();
    expect(screen.getByTestId("import-source-novel")).toBeInTheDocument();
    expect(screen.queryByTestId("import-source-scan")).toBeNull();
    expect(screen.queryByTestId("transfer-tab-zip")).toBeNull();
    expect(screen.queryByTestId("transfer-tab-novel")).toBeNull();
  });

  it("keeps the existing target defaults while switching among allowed formats", async () => {
    render(<WebEditorImportDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId("import-target")).toHaveTextContent("newProject");

    fireEvent.click(screen.getByTestId("import-source-markdown"));
    expect(screen.getByTestId("flow-markdown")).toHaveAttribute(
      "data-native-folder-picker",
      "false",
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
});
