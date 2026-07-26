// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { openFolderDialog } from "./dialog";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("openFolderDialog electron 分岐", () => {
  it("bridge.dialog.openFolder へ写像する", async () => {
    const openFolder = vi.fn().mockResolvedValue("/home/user/novel");
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      dialog: { openFolder },
    };
    await expect(openFolderDialog()).resolves.toBe("/home/user/novel");
    expect(openFolder).toHaveBeenCalledOnce();
  });

  it("キャンセル（null）はそのまま null を返す", async () => {
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      dialog: { openFolder: vi.fn().mockResolvedValue(null) },
    };
    await expect(openFolderDialog()).resolves.toBeNull();
  });
});
