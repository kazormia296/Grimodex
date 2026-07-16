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
  ImportTargetPanel: () => null,
}));
vi.mock("./flows/NovelcrafterImportFlow", () => ({
  NovelcrafterImportFlow: () => null,
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
});
