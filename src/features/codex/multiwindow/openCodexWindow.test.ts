import { describe, it, expect, vi, beforeEach } from "vitest";

const { isTauriMock, getByLabelMock, setFocusMock, ctorSpy } = vi.hoisted(
  () => ({
    isTauriMock: vi.fn(),
    getByLabelMock: vi.fn(),
    setFocusMock: vi.fn(),
    ctorSpy: vi.fn(),
  }),
);

vi.mock("@/lib/tauri", () => ({ isTauri: isTauriMock }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static getByLabel = getByLabelMock;
    constructor(label: string, options: Record<string, unknown>) {
      ctorSpy(label, options);
    }
  },
}));

import { openCodexWindow } from "./openCodexWindow";
import { CODEX_WINDOW_LABEL } from "./codexWindowMode";

beforeEach(() => {
  isTauriMock.mockReset();
  getByLabelMock.mockReset();
  setFocusMock.mockReset();
  ctorSpy.mockReset();
});

describe("openCodexWindow", () => {
  it("非 Tauri 環境では何もしない", async () => {
    isTauriMock.mockReturnValue(false);
    await openCodexWindow();
    expect(getByLabelMock).not.toHaveBeenCalled();
    expect(ctorSpy).not.toHaveBeenCalled();
  });

  it("既存窓があれば focus し、新規生成しない", async () => {
    isTauriMock.mockReturnValue(true);
    getByLabelMock.mockResolvedValue({ setFocus: setFocusMock });
    await openCodexWindow();
    expect(setFocusMock).toHaveBeenCalled();
    expect(ctorSpy).not.toHaveBeenCalled();
  });

  it("既存窓が無ければ codex-window label + options で生成する", async () => {
    isTauriMock.mockReturnValue(true);
    getByLabelMock.mockResolvedValue(null);
    await openCodexWindow();
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const [label, options] = ctorSpy.mock.calls[0];
    expect(label).toBe(CODEX_WINDOW_LABEL);
    expect(options.url).toContain("window=codex");
    expect(options.transparent).toBe(true);
    expect(options.decorations).toBe(false);
  });
});
