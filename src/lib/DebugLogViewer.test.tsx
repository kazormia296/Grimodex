// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { DebugLogViewer } from "./DebugLogViewer";
import { useDebugLogStore } from "./debugLog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("./imeLog", () => ({
  disableImeLog: vi.fn(),
  enableImeLog: vi.fn(),
  isImeLogEnabled: vi.fn(() => false),
  openImeTestPage: vi.fn(),
}));

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  Element.prototype.scrollIntoView = vi.fn();
  useDebugLogStore.setState({
    isOpen: true,
    entries: [
      {
        id: 1,
        level: "error",
        tag: "Global",
        message: "sample",
        timestamp: "2026-08-04T19:01:34.595Z",
      },
    ],
  });
});

describe("DebugLogViewer clipboard", () => {
  it("copy all は書き込み完了後にだけ成功表示する", async () => {
    render(<DebugLogViewer />);

    fireEvent.click(screen.getByTitle("Copy all"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("debugLog.logCopied");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("copy line の拒否を処理し、成功表示を出さない", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<DebugLogViewer />);

    fireEvent.click(screen.getByTitle("Copy line"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("debugLog.copyFailed"),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
