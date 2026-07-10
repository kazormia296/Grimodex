// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { readDir, readTextFile } from "./fs";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("fs electron 分岐", () => {
  it("readTextFile / readDir を bridge.fs へ写像する", async () => {
    const entries = [
      { name: "第一章.md", isDirectory: false, isFile: true, isSymlink: false },
    ];
    const fs = {
      readTextFile: vi.fn().mockResolvedValue("本文テキスト"),
      readDir: vi.fn().mockResolvedValue(entries),
    };
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      fs,
    };
    await expect(readTextFile("/ws/scene.md")).resolves.toBe("本文テキスト");
    expect(fs.readTextFile).toHaveBeenCalledWith("/ws/scene.md");
    await expect(readDir("/ws")).resolves.toEqual(entries);
    expect(fs.readDir).toHaveBeenCalledWith("/ws");
  });

  it("非 Tauri / 非 Electron では従来どおり reject する", async () => {
    await expect(readTextFile("/x")).rejects.toThrow(
      /unavailable outside the Tauri runtime/,
    );
    await expect(readDir("/x")).rejects.toThrow(
      /unavailable outside the Tauri runtime/,
    );
  });
});
