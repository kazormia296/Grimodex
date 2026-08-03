// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetIpcQueueForTests } from "@/lib/ipcQueue";
import {
  canInstallMozkeyFromApp,
  downloadAndInstallMozkey,
} from "./mozkeyInstaller";

beforeEach(() => {
  resetIpcQueueForTests();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("Mozkey installer Electron bridge", () => {
  it("invokes the guarded main-process installer command", async () => {
    const result = {
      version: "1.2.3",
      assetName: "MozkeyIbG_v1.2.3_x64.msi",
    };
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: result });
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      invoke,
    };

    expect(canInstallMozkeyFromApp()).toBe(true);
    await expect(downloadAndInstallMozkey()).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith(
      "mozkey_download_and_install",
      undefined,
    );
  });
});
