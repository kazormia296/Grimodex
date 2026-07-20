// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { openTextFile, openWebEditorHandoffFile } from "./importFile";

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

describe("openWebEditorHandoffFile electron 分岐", () => {
  it("専用のbounded mainピッカだけを使い、汎用fs readを経由しない", async () => {
    const handoff = {
      name: "draft.grimodex-handoff",
      content: '{"schemaVersion":"grimodex/web-editor-workspace-handoff/1"}',
    };
    const openWebEditorHandoff = vi.fn().mockResolvedValue(handoff);
    const openFile = vi.fn();
    const readTextFile = vi.fn();
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      dialog: { openFile, openWebEditorHandoff },
      fs: { readTextFile },
    };

    await expect(
      openWebEditorHandoffFile({
        name: "Grimodex Web Editor handoff",
        extensions: ["grimodex-handoff"],
      }),
    ).resolves.toEqual(handoff);
    expect(openWebEditorHandoff).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();
    expect(readTextFile).not.toHaveBeenCalled();
  });
});
