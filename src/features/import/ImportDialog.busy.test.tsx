// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./importShared", () => ({
  ImportTargetPanel: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="desktop-import-target" data-disabled={String(disabled)} />
  ),
}));
vi.mock("./flows/NovelcrafterImportFlow", () => ({
  NovelcrafterImportFlow: ({
    enforceBrowserLimits,
    onClose,
    onFailedChange,
  }: {
    enforceBrowserLimits?: boolean;
    onClose: () => void;
    onFailedChange?: (failed: boolean) => void;
  }) => (
    <div>
      <div data-testid="desktop-import-limits">
        {String(enforceBrowserLimits)}
      </div>
      <button type="button" onClick={() => onFailedChange?.(true)}>
        fail local import
      </button>
      <button type="button" onClick={onClose}>
        close failed import
      </button>
    </div>
  ),
}));
vi.mock("./flows/KakuyomuImportFlow", () => ({
  KakuyomuImportFlow: () => null,
}));
vi.mock("./flows/MarkdownImportFlow", () => ({
  MarkdownImportFlow: () => null,
}));
vi.mock("./flows/NovelImportFlow", () => ({
  NovelImportFlow: () => null,
}));
vi.mock("./flows/ScanImportFlow", () => ({
  ScanImportFlow: ({
    onClose,
    onComplete,
    onBusyChange,
  }: {
    onClose: () => void;
    onComplete?: () => void;
    onBusyChange?: (busy: boolean) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onBusyChange?.(true)}>
        start apply
      </button>
      <button type="button" onClick={onClose}>
        request close
      </button>
      <button type="button" onClick={onComplete}>
        complete apply
      </button>
    </div>
  ),
}));

import { ImportDialogBody } from "./ImportDialog";

afterEach(cleanup);

describe("ImportDialogBody Scan busy state", () => {
  it("blocks close/source changes during apply but closes after completion", () => {
    const onClose = vi.fn();
    render(<ImportDialogBody onClose={onClose} />);
    expect(screen.getByTestId("desktop-import-limits")).toHaveTextContent(
      "undefined",
    );
    fireEvent.click(screen.getByTestId("import-source-scan"));
    fireEvent.click(screen.getByRole("button", { name: "start apply" }));

    fireEvent.click(screen.getByRole("button", { name: "request close" }));
    fireEvent.click(screen.getByTestId("import-source-novel"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("import-source-scan")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "complete apply" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("locks desktop import controls after a partial failure but allows close", () => {
    const onClose = vi.fn();
    render(<ImportDialogBody onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "fail local import" }));

    expect(screen.getByTestId("import-source-markdown")).toBeDisabled();
    expect(screen.getByTestId("desktop-import-target")).toHaveAttribute(
      "data-disabled",
      "true",
    );
    fireEvent.click(screen.getByTestId("import-source-markdown"));
    expect(screen.getByTestId("import-source-novelcrafter")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "close failed import" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});
