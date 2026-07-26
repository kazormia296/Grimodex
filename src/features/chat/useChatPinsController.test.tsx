// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexEntry } from "@/features/codex/api";
import { useChatPinsController } from "./useChatPinsController";

const mocks = vi.hoisted(() => ({
  setInputPinnedEntryIds: vi.fn(),
}));

vi.mock("./chatStore", () => ({
  useChatStore: {
    getState: () => ({
      setInputPinnedEntryIds: mocks.setInputPinnedEntryIds,
    }),
  },
}));

vi.mock("./chatApi", () => ({
  listPinnedCodexEntries: vi.fn(async () => []),
  listPinnedSnippetEntries: vi.fn(async () => []),
  listPinnedStickyEntries: vi.fn(async () => []),
  pinCodexEntry: vi.fn(async () => {}),
  unpinCodexEntry: vi.fn(async () => {}),
  togglePinChildren: vi.fn(async () => {}),
}));

function codex(id: string): CodexEntry {
  return { id, name: id } as CodexEntry;
}

describe("useChatPinsController current-input mentions", () => {
  beforeEach(() => {
    mocks.setInputPinnedEntryIds.mockClear();
  });

  it("turns a dismissed mention pill into a source-level auto exclusion", async () => {
    const excludeEntryFromAuto = vi.fn();
    excludeEntryFromAuto.mockReturnValue(true);
    const clearAutoExclusion = vi.fn();
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: false,
        activeSessionId: null,
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => null,
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto,
        clearAutoExclusion,
        refreshContextLayers: async () => null,
      }),
    );

    act(() => result.current.handleDetectedEntries(["alice"]));
    await waitFor(() =>
      expect(result.current.inputPinnedIds.has("alice")).toBe(true),
    );

    await act(async () => result.current.handleRemoveEntry("alice"));

    expect(excludeEntryFromAuto).toHaveBeenCalledWith("alice");
    expect(result.current.inputPinnedIds.has("alice")).toBe(false);
    await waitFor(() =>
      expect(mocks.setInputPinnedEntryIds).toHaveBeenLastCalledWith([]),
    );
    act(() => result.current.resetInputDismissed());
    expect(clearAutoExclusion).toHaveBeenCalledWith("alice");
  });

  it("represents current mentions without automatic child expansion", async () => {
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: false,
        activeSessionId: null,
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => null,
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers: async () => null,
      }),
    );

    act(() => result.current.handleDetectedEntries(["alice"]));
    await waitFor(() =>
      expect(result.current.inputPinnedEntries).toHaveLength(1),
    );
    expect(result.current.inputPinnedEntries[0]).toMatchObject({
      id: "alice",
      withChildren: false,
      pinSource: "chat_mention",
    });
  });
});
