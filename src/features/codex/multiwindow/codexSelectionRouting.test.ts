import { describe, it, expect, vi, beforeEach } from "vitest";

const { getPanelWindowHandleMock, emitSelectEntryMock } = vi.hoisted(() => ({
  getPanelWindowHandleMock: vi.fn(),
  emitSelectEntryMock: vi.fn(),
}));
const showPanel = vi.fn();
const isPanelActive = vi.fn();
const requestSelectEntry = vi.fn();

vi.mock("@/features/layout/multiwindow/panelWindow", () => ({
  getPanelWindowHandle: getPanelWindowHandleMock,
  getPanelWindowTarget: () => null,
}));
vi.mock("./codexWindowSync", () => ({
  emitSelectEntry: emitSelectEntryMock,
  onSelectEntry: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: () => ({ showPanel, isPanelActive }) },
}));
vi.mock("../codexStore", () => ({
  useCodexStore: { getState: () => ({ requestSelectEntry }) },
}));

import { requestOpenInCodex } from "./codexSelectionRouting";

beforeEach(() => {
  getPanelWindowHandleMock.mockReset();
  emitSelectEntryMock.mockReset().mockResolvedValue(undefined);
  showPanel.mockReset();
  isPanelActive.mockReset();
  requestSelectEntry.mockReset();
});

describe("requestOpenInCodex routing", () => {
  it("別窓あり → 選択を broadcast して focus、メイン窓のパネルは開かない(要望4)", async () => {
    const setFocus = vi.fn().mockResolvedValue(undefined);
    getPanelWindowHandleMock.mockResolvedValue({ setFocus });
    await requestOpenInCodex("e1");
    expect(emitSelectEntryMock).toHaveBeenCalledWith("e1");
    expect(setFocus).toHaveBeenCalled();
    expect(showPanel).not.toHaveBeenCalled();
    expect(requestSelectEntry).not.toHaveBeenCalled();
  });

  it("別窓なし → メイン窓で Codex パネルを開いて選択(従来動作)", async () => {
    getPanelWindowHandleMock.mockResolvedValue(null);
    await requestOpenInCodex("e2");
    expect(showPanel).toHaveBeenCalledWith("codex");
    expect(requestSelectEntry).toHaveBeenCalledWith("e2");
    expect(emitSelectEntryMock).not.toHaveBeenCalled();
  });
});
