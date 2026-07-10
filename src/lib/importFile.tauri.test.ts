// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Tauri 分岐は `import_open_text_file` コマンドを invoke するだけ（plugin-fs は
// 使わない）。@/lib/tauri を部分 mock して isTauri=true / invoke を差し替える。
const invoke = vi.fn();
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { openTextFile } from "./importFile";

const FILTER = { name: "Text", extensions: ["txt", "md"] };

describe("openTextFile tauri 分岐", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("import_open_text_file を invoke し、Rust の {name,content} をそのまま返す", async () => {
    invoke.mockResolvedValue({ name: "原稿.txt", content: "本文" });
    await expect(openTextFile(FILTER)).resolves.toEqual({
      name: "原稿.txt",
      content: "本文",
    });
    expect(invoke).toHaveBeenCalledWith("import_open_text_file", {
      filterName: "Text",
      extensions: ["txt", "md"],
    });
  });

  it("キャンセル（null）は null を返す", async () => {
    invoke.mockResolvedValue(null);
    await expect(openTextFile(FILTER)).resolves.toBeNull();
  });
});
