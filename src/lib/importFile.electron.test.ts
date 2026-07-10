// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { openTextFile } from "./importFile";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

const FILTER = { name: "Text", extensions: ["txt", "md"] };

describe("openTextFile electron 分岐", () => {
  it("openFile → readTextFile を bridge 経由で行い、basename を返す", async () => {
    const dialog = {
      openFile: vi.fn().mockResolvedValue("/home/user/docs/原稿.txt"),
    };
    const fs = { readTextFile: vi.fn().mockResolvedValue("こんにちは") };
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      dialog,
      fs,
    };
    await expect(openTextFile(FILTER)).resolves.toEqual({
      name: "原稿.txt",
      content: "こんにちは",
    });
    expect(dialog.openFile).toHaveBeenCalledWith({
      name: "Text",
      extensions: ["txt", "md"],
    });
    expect(fs.readTextFile).toHaveBeenCalledWith("/home/user/docs/原稿.txt");
  });

  it("キャンセル（null）は null を返し readTextFile を呼ばない", async () => {
    const fs = { readTextFile: vi.fn() };
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      dialog: { openFile: vi.fn().mockResolvedValue(null) },
      fs,
    };
    await expect(openTextFile(FILTER)).resolves.toBeNull();
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });
});
