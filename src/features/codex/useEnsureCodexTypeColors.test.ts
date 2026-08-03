// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCodexTypes: vi.fn(),
  setTypeColorMap: vi.fn(),
}));

vi.mock("@/features/codex/typeApi", () => ({
  listCodexTypes: mocks.listCodexTypes,
}));

vi.mock("@/features/editor/codexHighlightStore", () => ({
  useCodexHighlightStore: (
    selector: (state: {
      setTypeColorMap: typeof mocks.setTypeColorMap;
    }) => unknown,
  ) => selector({ setTypeColorMap: mocks.setTypeColorMap }),
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (
    selector: (state: {
      globalSettings: { colorTheme: string; theme: string };
    }) => unknown,
  ) =>
    selector({
      globalSettings: { colorTheme: "default", theme: "light" },
    }),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));

vi.mock("@/lib/resolveCodexColors", () => ({
  resolveCodexColor: () => ({
    hl: "#ff0000",
    tx: "#ff0000",
    fg: "#ff0000",
  }),
}));

import { useEnsureCodexTypeColors } from "./useEnsureCodexTypeColors";

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false }),
});

describe("useEnsureCodexTypeColors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCodexTypes.mockResolvedValue([]);
  });

  it("terminates an optional type-color query failure inside the effect", async () => {
    const consoleWarning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mocks.listCodexTypes.mockRejectedValueOnce(
      new Error("type color query unavailable"),
    );

    try {
      renderHook(() => useEnsureCodexTypeColors());

      await vi.waitFor(() => {
        expect(consoleWarning).toHaveBeenCalledWith(
          "[codex-type-colors] type color projection unavailable",
          expect.any(String),
        );
      });
      expect(mocks.setTypeColorMap).not.toHaveBeenCalled();
    } finally {
      consoleWarning.mockRestore();
    }
  });
});
