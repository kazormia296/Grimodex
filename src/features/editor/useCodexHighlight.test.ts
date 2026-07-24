// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import type { Editor } from "@tiptap/core";
import type { PluginKey } from "@tiptap/pm/state";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRebuildAndSchedule = vi.fn().mockResolvedValue(undefined);
const mockScheduleMatch = vi.fn();

vi.mock("./codexMatchOrchestrator", () => ({
  rebuildAndSchedule: (...args: unknown[]) => mockRebuildAndSchedule(...args),
  scheduleMatch: (...args: unknown[]) => mockScheduleMatch(...args),
}));

vi.mock("@/features/codex/typeApi", () => ({
  listCodexTypes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/resolveCodexColors", () => ({
  resolveCodexColor: vi
    .fn()
    .mockReturnValue({ hl: "#ff0029", tx: "#ff0000", fg: "#ff0000" }),
}));

// Minimal store mocks
let mockEntries: unknown[] = [];
let mockEnabled = true;

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: (selector: (s: { entries: unknown[] }) => unknown) =>
    selector({ entries: mockEntries }),
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: (selector: (s: { get: () => string }) => unknown) =>
    selector({ get: () => "color-text" }),
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (
    selector: (s: { globalSettings: null; theme: string }) => unknown,
  ) => selector({ globalSettings: null, theme: "light" }),
}));

vi.mock("./codexHighlightStore", () => {
  const setMatchTargets = vi.fn();
  const setMatchedEntryIds = vi.fn();
  const setTypeColorMap = vi.fn();
  return {
    useCodexHighlightStore: (
      selector: (s: {
        setMatchTargets: typeof setMatchTargets;
        setMatchedEntryIds: typeof setMatchedEntryIds;
        setTypeColorMap: typeof setTypeColorMap;
        enabled: boolean;
      }) => unknown,
    ) =>
      selector({
        setMatchTargets,
        setMatchedEntryIds,
        setTypeColorMap,
        get enabled() {
          return mockEnabled;
        },
      }),
  };
});

vi.mock("./CodexHighlightPlugin", () => ({
  codexHighlightKey: { getState: vi.fn() } as unknown as PluginKey,
  createCodexHighlightPlugin: vi
    .fn()
    .mockReturnValue({ spec: { key: { getState: vi.fn() } } }),
}));

// jsdom doesn't implement matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockReturnValue({ matches: false }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEditor(): Editor {
  return {
    state: {
      tr: { setMeta: vi.fn().mockReturnThis() },
      doc: {
        textContent: "太郎は走った",
        descendants: (
          cb: (
            node: { isText: boolean; text: string; type: { name: string } },
            pos: number,
          ) => void,
        ) => {
          cb({ isText: true, text: "太郎は走った", type: { name: "text" } }, 0);
        },
      },
      plugins: [],
    },
    view: {
      dom: document.createElement("div"),
      dispatch: vi.fn(),
      state: { plugins: [] },
    },
    isDestroyed: false,
    on: vi.fn(),
    off: vi.fn(),
    registerPlugin: vi.fn(),
    unregisterPlugin: vi.fn(),
  } as unknown as Editor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { useCodexHighlight } from "./useCodexHighlight";

describe("useCodexHighlight — skipMatchedIds dependency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntries = [
      {
        id: "c1",
        name: "太郎",
        type: "character",
        aliases: [],
        excludedAliases: [],
      },
    ];
    mockEnabled = true;
  });

  it("calls rebuildAndSchedule with skipMatchedIds=true when initially non-active", () => {
    const editor = makeEditor();
    renderHook(() => useCodexHighlight(editor, { skipMatchedIds: true }));

    expect(mockRebuildAndSchedule).toHaveBeenCalledWith(
      editor,
      expect.any(Array),
      [],
      true,
    );
  });

  it("can force the visual Codex layer on without changing the persisted store value", () => {
    const editor = makeEditor();
    mockEnabled = false;

    renderHook(() =>
      useCodexHighlight(
        editor,
        { enabledOverride: true } as never,
      ),
    );

    expect(mockRebuildAndSchedule).toHaveBeenCalledWith(
      editor,
      expect.any(Array),
      [],
      false,
    );
    expect(mockEnabled).toBe(false);
  });

  it("re-runs rebuild when skipMatchedIds changes from true to false (focus switch)", async () => {
    const editor = makeEditor();
    let skipMatchedIds = true;

    const { rerender } = renderHook(() =>
      useCodexHighlight(editor, { skipMatchedIds }),
    );

    // Initial render: called once with true
    expect(mockRebuildAndSchedule).toHaveBeenCalledTimes(1);
    expect(mockRebuildAndSchedule).toHaveBeenLastCalledWith(
      editor,
      expect.any(Array),
      [],
      true,
    );

    // Simulate focus switch: group becomes active → skipMatchedIds: false
    await act(async () => {
      skipMatchedIds = false;
      rerender();
    });

    // After focus switch, rebuildAndSchedule must be called again with skipMatchedIds=false
    expect(mockRebuildAndSchedule).toHaveBeenCalledTimes(2);
    expect(mockRebuildAndSchedule).toHaveBeenLastCalledWith(
      editor,
      expect.any(Array),
      [],
      false,
    );
  });

  it("does NOT re-run rebuild when skipMatchedIds stays the same", async () => {
    const editor = makeEditor();
    const { rerender } = renderHook(() =>
      useCodexHighlight(editor, { skipMatchedIds: false }),
    );

    expect(mockRebuildAndSchedule).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender();
    });

    // No dependency changed → no extra rebuild
    expect(mockRebuildAndSchedule).toHaveBeenCalledTimes(1);
  });

  it("does not access a TipTap view detached before passive effects", () => {
    const editor = makeEditor();
    Object.defineProperty(editor, "view", {
      get() {
        throw new Error("The editor view is not available");
      },
    });

    expect(() =>
      renderHook(() => useCodexHighlight(editor, { skipMatchedIds: true })),
    ).not.toThrow();
    expect(mockRebuildAndSchedule).not.toHaveBeenCalled();
  });
});
