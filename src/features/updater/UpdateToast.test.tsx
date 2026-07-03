// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./api", () => ({
  startUpdateDownload: vi.fn(),
  restartApp: vi.fn(),
}));

import { UpdateToast } from "./UpdateToast";
import { startUpdateDownload, restartApp } from "./api";
import { useUpdaterStore, _resetUpdaterForTests } from "./updaterStore";

const mockStart = vi.mocked(startUpdateDownload);
const mockRestart = vi.mocked(restartApp);

describe("UpdateToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetUpdaterForTests();
  });

  afterEach(() => {
    _resetUpdaterForTests();
  });

  it("renders nothing while idle", () => {
    const { container } = render(<UpdateToast />);
    expect(container).toBeEmptyDOMElement();
    // portal 先にも何も出ていない
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing while checking", () => {
    useUpdaterStore.getState().setChecking();
    render(<UpdateToast />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows available with version and update/later buttons", async () => {
    const user = userEvent.setup();
    useUpdaterStore.getState().setAvailable("2.0.0", "リリースノート");
    render(<UpdateToast />);

    expect(screen.getByText("新しいバージョンがあります")).toBeInTheDocument();
    expect(screen.getByText("v2.0.0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "今すぐ更新" }));
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("dismisses (resets store) when '後で' is clicked", async () => {
    const user = userEvent.setup();
    useUpdaterStore.getState().setAvailable("2.0.0", null);
    render(<UpdateToast />);

    await user.click(screen.getByRole("button", { name: "後で" }));
    expect(useUpdaterStore.getState().phase).toBe("idle");
  });

  it("shows download progress in MiB", () => {
    const oneMib = 1024 * 1024;
    useUpdaterStore.getState().setDownloading(oneMib, 4 * oneMib);
    render(<UpdateToast />);

    expect(screen.getByText("更新をダウンロード中…")).toBeInTheDocument();
    expect(screen.getByText("1.0 / 4.0 MiB")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("shows restart button when ready and fires restartApp", async () => {
    const user = userEvent.setup();
    useUpdaterStore.getState().setReady();
    render(<UpdateToast />);

    expect(screen.getByText("更新の準備ができました")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "再起動" }));
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it("shows the error message when phase is error", () => {
    useUpdaterStore.getState().setError("ネットワークエラー");
    render(<UpdateToast />);

    expect(screen.getByText("更新の確認に失敗しました")).toBeInTheDocument();
    expect(screen.getByText("ネットワークエラー")).toBeInTheDocument();
  });
});
