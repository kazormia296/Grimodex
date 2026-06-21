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

import {
  parsePanelWindowTarget,
  panelWindowLabel,
  buildPanelWindowOptions,
  openPanelWindow,
} from "./panelWindow";

beforeEach(() => {
  isTauriMock.mockReset();
  getByLabelMock.mockReset();
  setFocusMock.mockReset();
  ctorSpy.mockReset();
});

describe("parsePanelWindowTarget", () => {
  it("?window=panel&panel=codex → 'codex'", () => {
    expect(parsePanelWindowTarget("?window=panel&panel=codex")).toBe("codex");
  });
  it("任意の toggleable パネルを受け付ける", () => {
    expect(parsePanelWindowTarget("?window=panel&panel=foreshadow")).toBe(
      "foreshadow",
    );
  });
  it("main 窓(クエリ無し)は null", () => {
    expect(parsePanelWindowTarget("")).toBeNull();
    expect(parsePanelWindowTarget("?")).toBeNull();
  });
  it("window=panel だが panel 指定無しは null", () => {
    expect(parsePanelWindowTarget("?window=panel")).toBeNull();
  });
  it("未知の panel 値は弾いて null(不正URLでの空SlotView回避)", () => {
    expect(parsePanelWindowTarget("?window=panel&panel=garbage")).toBeNull();
  });
  it("editor は別窓対象外 → null", () => {
    expect(parsePanelWindowTarget("?window=panel&panel=editor")).toBeNull();
  });
});

describe("panelWindowLabel / buildPanelWindowOptions", () => {
  it("label は panel-<id>(capability glob panel-* と一致)", () => {
    expect(panelWindowLabel("codex")).toBe("panel-codex");
    expect(panelWindowLabel("foreshadow")).toBe("panel-foreshadow");
  });
  it("options: label/url/glass shell 継承/サイズ/title", () => {
    const o = buildPanelWindowOptions("foreshadow");
    expect(o.label).toBe("panel-foreshadow");
    expect(o.url).toContain("window=panel");
    expect(o.url).toContain("panel=foreshadow");
    expect(o.transparent).toBe(true);
    expect(o.decorations).toBe(false);
    expect(o.width).toBeGreaterThan(0);
    expect(o.height).toBeGreaterThan(0);
    expect(typeof o.title).toBe("string");
  });
});

describe("openPanelWindow", () => {
  it("非 Tauri は no-op", async () => {
    isTauriMock.mockReturnValue(false);
    await openPanelWindow("codex");
    expect(getByLabelMock).not.toHaveBeenCalled();
    expect(ctorSpy).not.toHaveBeenCalled();
  });
  it("既存窓があれば focus・新規生成しない", async () => {
    isTauriMock.mockReturnValue(true);
    getByLabelMock.mockResolvedValue({ setFocus: setFocusMock });
    await openPanelWindow("codex");
    expect(setFocusMock).toHaveBeenCalled();
    expect(ctorSpy).not.toHaveBeenCalled();
  });
  it("無ければ panel-<id> label + options で生成", async () => {
    isTauriMock.mockReturnValue(true);
    getByLabelMock.mockResolvedValue(null);
    await openPanelWindow("matrix");
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const [label, options] = ctorSpy.mock.calls[0];
    expect(label).toBe("panel-matrix");
    expect(options.url).toContain("panel=matrix");
    expect(options.transparent).toBe(true);
    expect(options.decorations).toBe(false);
  });
});
