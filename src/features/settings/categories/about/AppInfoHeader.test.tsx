// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { getVersion } from "@/lib/appInfo";
import {
  _resetUpdaterForTests,
  useUpdaterStore,
} from "@/features/updater/updaterStore";
import { checkForUpdate } from "@/features/updater/api";
import { AppInfoHeader } from "./AppInfoHeader";

vi.mock("@/lib/appInfo", () => ({
  getVersion: vi.fn(),
}));

vi.mock("@/features/updater/api", () => ({
  checkForUpdate: vi.fn(),
  startUpdateDownload: vi.fn(),
  restartApp: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const mockGetVersion = vi.mocked(getVersion);
const mockCheckForUpdate = vi.mocked(checkForUpdate);

describe("AppInfoHeader", () => {
  beforeEach(() => {
    _resetUpdaterForTests();
    mockGetVersion.mockResolvedValue("2.0.8");
  });

  it("caps an invalid download progress payload at 100%", () => {
    useUpdaterStore.setState({
      phase: "downloading",
      downloaded: 150,
      total: 100,
    });

    render(<AppInfoHeader />);

    expect(
      screen.getByRole("button", { name: "ダウンロード中… 100%" }),
    ).toBeInTheDocument();
  });

  it("identifies the current first-party license as proprietary", () => {
    render(<AppInfoHeader />);

    expect(screen.getByText("Proprietary")).toBeInTheDocument();
  });

  // NC-1（K3/3）の (33)(iii): 閉じ込めの下で LAN の IP literal や hostname の env proxy が更新の確認を
  // ERR_PROXY_CONNECTION_FAILED で止めたとき、設定画面の手動確認が既存の error 状態とトーストで失敗を見せる。
  it("shows the existing error state and toast when a manual update check fails", async () => {
    mockCheckForUpdate.mockRejectedValue(
      new Error("net::ERR_PROXY_CONNECTION_FAILED"),
    );

    render(<AppInfoHeader />);
    fireEvent.click(screen.getByRole("button", { name: "更新を確認" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(toast.error).toHaveBeenCalledWith("更新の確認に失敗しました");
    const state = useUpdaterStore.getState();
    expect(state.phase).toBe("error");
    expect(state.error).toContain("ERR_PROXY_CONNECTION_FAILED");
  });
});
