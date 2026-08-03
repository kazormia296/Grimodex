// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { getVersion } from "@/lib/appInfo";
import {
  _resetUpdaterForTests,
  useUpdaterStore,
} from "@/features/updater/updaterStore";
import { AppInfoHeader } from "./AppInfoHeader";

vi.mock("@/lib/appInfo", () => ({
  getVersion: vi.fn(),
}));

const mockGetVersion = vi.mocked(getVersion);

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
});
