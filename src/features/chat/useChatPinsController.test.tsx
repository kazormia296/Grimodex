// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexEntry } from "@/features/codex/api";
import type {
  PinnedCodexEntryWithData,
  PinnedStickyEntryWithData,
} from "./chatApi";
import { toast } from "sonner";
import * as chatApi from "./chatApi";
import { useChatPinsController } from "./useChatPinsController";

interface MockChatAuthorityState {
  activeSessionId: string | null;
  isLoadingSessions: boolean;
  isLoadingMessages: boolean;
  isStreaming: boolean;
}

type MockChatStoreSubscriber = (
  state: MockChatAuthorityState,
  previous: MockChatAuthorityState,
) => void;

const mocks = vi.hoisted(() => ({
  activeSessionId: null as string | null,
  isLoadingSessions: false,
  isLoadingMessages: false,
  isStreaming: false,
  storeSubscribers: new Set<MockChatStoreSubscriber>(),
  setInputPinnedEntryIds: vi.fn(),
  listPinnedCodexEntries: vi.fn(
    async (): Promise<PinnedCodexEntryWithData[]> => [],
  ),
  listPinnedSnippetEntries: vi.fn(async () => []),
  listPinnedStickyEntries: vi.fn(
    async (): Promise<PinnedStickyEntryWithData[]> => [],
  ),
  pinCodexEntry: vi.fn(async () => {}),
  unpinCodexEntry: vi.fn(async () => {}),
  unpinStickyEntry: vi.fn(async () => {}),
  togglePinChildren: vi.fn(async () => {}),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("./chatStore", () => ({
  captureChatComposerAuthority: () => ({
    activeSessionId: mocks.activeSessionId,
    sessionMutation: {},
  }),
  awaitChatComposerAuthority: async (authority: {
    activeSessionId: string | null;
  }) => authority.activeSessionId === mocks.activeSessionId,
  useChatStore: {
    getState: () => ({
      activeSessionId: mocks.activeSessionId,
      isLoadingSessions: mocks.isLoadingSessions,
      isLoadingMessages: mocks.isLoadingMessages,
      isStreaming: mocks.isStreaming,
      setInputPinnedEntryIds: mocks.setInputPinnedEntryIds,
    }),
    subscribe: (subscriber: MockChatStoreSubscriber) => {
      mocks.storeSubscribers.add(subscriber);
      return () => mocks.storeSubscribers.delete(subscriber);
    },
  },
}));

vi.mock("./chatApi", () => ({
  listPinnedCodexEntries: mocks.listPinnedCodexEntries,
  listPinnedSnippetEntries: mocks.listPinnedSnippetEntries,
  listPinnedStickyEntries: mocks.listPinnedStickyEntries,
  pinCodexEntry: mocks.pinCodexEntry,
  unpinCodexEntry: mocks.unpinCodexEntry,
  unpinStickyEntry: mocks.unpinStickyEntry,
  togglePinChildren: mocks.togglePinChildren,
}));

function codex(id: string): CodexEntry {
  return { id, name: id } as CodexEntry;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function currentMockChatState(): MockChatAuthorityState {
  return {
    activeSessionId: mocks.activeSessionId,
    isLoadingSessions: mocks.isLoadingSessions,
    isLoadingMessages: mocks.isLoadingMessages,
    isStreaming: mocks.isStreaming,
  };
}

function notifyMockChatState(previous: MockChatAuthorityState): void {
  const current = currentMockChatState();
  for (const subscriber of mocks.storeSubscribers) {
    subscriber(current, previous);
  }
}

describe("useChatPinsController current-input mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeSessionId = null;
    mocks.isLoadingSessions = false;
    mocks.isLoadingMessages = false;
    mocks.isStreaming = false;
    mocks.storeSubscribers.clear();
    mocks.listPinnedCodexEntries.mockResolvedValue([]);
    mocks.listPinnedSnippetEntries.mockResolvedValue([]);
    mocks.listPinnedStickyEntries.mockResolvedValue([]);
    mocks.pinCodexEntry.mockResolvedValue(undefined);
    mocks.unpinCodexEntry.mockResolvedValue(undefined);
    mocks.unpinStickyEntry.mockResolvedValue(undefined);
    mocks.togglePinChildren.mockResolvedValue(undefined);
  });

  it("persists Spotlight and publishes the refreshed pinned entry", async () => {
    mocks.activeSessionId = "session-1";
    const pinned = {
      ...codex("alice"),
      withChildren: false,
      pinnedType: "codex",
      pinSource: "manual",
    } as PinnedCodexEntryWithData;
    mocks.listPinnedCodexEntries.mockResolvedValue([pinned]);
    const removeEntryFromAuto = vi.fn();
    const clearAutoExclusion = vi.fn();
    const refreshContextLayers = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto,
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion,
        refreshContextLayers,
      }),
    );

    await act(async () => result.current.handlePin("alice"));

    expect(chatApi.pinCodexEntry).toHaveBeenCalledWith(
      "session-1",
      "alice",
      false,
      "manual",
      "codex",
    );
    expect(result.current.pinnedIds.has("alice")).toBe(true);
    expect(removeEntryFromAuto).toHaveBeenCalledWith("alice");
    expect(clearAutoExclusion).toHaveBeenCalledWith("alice");
    expect(refreshContextLayers).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows feedback instead of silently ignoring an unavailable session", async () => {
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
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

    await act(async () => result.current.handlePin("alice"));

    expect(chatApi.pinCodexEntry).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("reports a failed Spotlight write without leaving an unhandled rejection", async () => {
    mocks.activeSessionId = "session-1";
    mocks.pinCodexEntry.mockRejectedValueOnce(new Error("pin failed"));
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers: async () => null,
      }),
    );

    await act(async () => result.current.handlePin("alice"));

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("does not publish or mutate the replacement session after a pin changes sessions", async () => {
    mocks.activeSessionId = "session-1";
    const write = deferred<void>();
    mocks.pinCodexEntry.mockReturnValueOnce(write.promise);
    const removeEntryFromAuto = vi.fn();
    const clearAutoExclusion = vi.fn();
    const refreshContextLayers = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto,
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion,
        refreshContextLayers,
      }),
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handlePin("alice");
    });
    await waitFor(() => expect(mocks.pinCodexEntry).toHaveBeenCalledOnce());

    mocks.activeSessionId = "session-2";
    write.resolve();
    await act(async () => pending);

    expect(removeEntryFromAuto).not.toHaveBeenCalled();
    expect(clearAutoExclusion).not.toHaveBeenCalled();
    expect(refreshContextLayers).not.toHaveBeenCalled();
  });

  it("does not persist a queued click into the session selected later", async () => {
    mocks.activeSessionId = "session-1";
    const firstWrite = deferred<void>();
    mocks.pinCodexEntry.mockReturnValueOnce(firstWrite.promise);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice"), codex("bob")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers: async () => null,
      }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handlePin("alice");
      second = result.current.handlePin("bob");
    });
    await waitFor(() => expect(mocks.pinCodexEntry).toHaveBeenCalledOnce());

    mocks.activeSessionId = "session-2";
    firstWrite.resolve();
    await act(async () => Promise.all([first, second]));

    expect(mocks.pinCodexEntry).toHaveBeenCalledTimes(1);
    expect(mocks.pinCodexEntry).toHaveBeenCalledWith(
      "session-1",
      "alice",
      false,
      "manual",
      "codex",
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("creates one initial session and pins the whole creator batch into it", async () => {
    mocks.activeSessionId = null;
    const ensureSession = vi.fn(async () => {
      mocks.activeSessionId = "session-1";
      return "session-1";
    });
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: null,
        pinsVersion: 0,
        allCodexEntries: [codex("alice"), codex("bob")],
        ensureSession,
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers: async () => null,
      }),
    );

    await act(async () => result.current.handlePinBatch(["alice", "bob"]));

    expect(ensureSession).toHaveBeenCalledOnce();
    expect(mocks.pinCodexEntry).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "alice",
      false,
      "manual",
      "codex",
    );
    expect(mocks.pinCodexEntry).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "bob",
      false,
      "manual",
      "codex",
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reconciles a partially persisted creator batch before reporting failure", async () => {
    mocks.activeSessionId = "session-1";
    const alicePin = {
      ...codex("alice"),
      withChildren: false,
      pinnedType: "codex",
      pinSource: "manual",
    } as PinnedCodexEntryWithData;
    mocks.pinCodexEntry
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second pin failed"));
    const refreshContextLayers = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice"), codex("bob")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers,
      }),
    );
    await waitFor(() =>
      expect(mocks.listPinnedCodexEntries).toHaveBeenCalledWith("session-1"),
    );
    mocks.listPinnedCodexEntries.mockResolvedValue([alicePin]);

    let succeeded!: boolean;
    await act(async () => {
      succeeded = await result.current.handlePinBatch(["alice", "bob"]);
    });

    expect(succeeded).toBe(false);
    expect(result.current.pinnedIds.has("alice")).toBe(true);
    expect(refreshContextLayers).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("retries a replacement session read invalidated by a settling mutation", async () => {
    mocks.activeSessionId = "session-1";
    const write = deferred<void>();
    mocks.pinCodexEntry.mockReturnValueOnce(write.promise);
    const bobPin = {
      ...codex("bob"),
      withChildren: false,
      pinnedType: "codex",
      pinSource: "manual",
    } as PinnedCodexEntryWithData;
    const firstSessionTwoRead = deferred<PinnedCodexEntryWithData[]>();
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useChatPinsController({
          isActive: true,
          activeSessionId: sessionId,
          pinsVersion: 0,
          allCodexEntries: [codex("alice"), codex("bob")],
          ensureSession: async () => "session-1",
          removeEntryFromAuto: vi.fn(),
          excludeEntryFromAuto: vi.fn(),
          clearAutoExclusion: vi.fn(),
          refreshContextLayers: async () => null,
        }),
      { initialProps: { sessionId: "session-1" } },
    );
    await waitFor(() =>
      expect(mocks.listPinnedCodexEntries).toHaveBeenCalledWith("session-1"),
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handlePin("alice");
    });
    await waitFor(() => expect(mocks.pinCodexEntry).toHaveBeenCalledOnce());

    mocks.listPinnedCodexEntries
      .mockReturnValueOnce(firstSessionTwoRead.promise)
      .mockResolvedValue([bobPin]);
    mocks.activeSessionId = "session-2";
    rerender({ sessionId: "session-2" });
    await waitFor(() =>
      expect(mocks.listPinnedCodexEntries).toHaveBeenCalledWith("session-2"),
    );

    write.resolve();
    await act(async () => pending);
    await waitFor(() => expect(result.current.pinnedIds.has("bob")).toBe(true));

    firstSessionTwoRead.resolve([]);
  });

  it("finishes pin readback during streaming and defers context refresh", async () => {
    mocks.activeSessionId = "session-1";
    const write = deferred<void>();
    mocks.pinCodexEntry.mockReturnValueOnce(write.promise);
    const pinned = {
      ...codex("alice"),
      withChildren: false,
      pinnedType: "codex",
      pinSource: "manual",
    } as PinnedCodexEntryWithData;
    const sticky: PinnedStickyEntryWithData = {
      id: "sticky-1",
      title: "Sticky",
      content: "Context",
      pinnedType: "sticky",
    };
    const refreshContextLayers = vi.fn(async () => null);
    const { result, rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) =>
        useChatPinsController({
          isActive: true,
          activeSessionId: "session-1",
          pinsVersion: 0,
          mutationsDisabled: disabled,
          allCodexEntries: [codex("alice")],
          ensureSession: async () => "session-1",
          removeEntryFromAuto: vi.fn(),
          excludeEntryFromAuto: vi.fn(),
          clearAutoExclusion: vi.fn(),
          refreshContextLayers,
        }),
      { initialProps: { disabled: false } },
    );
    await waitFor(() =>
      expect(mocks.listPinnedCodexEntries).toHaveBeenCalledWith("session-1"),
    );

    mocks.listPinnedCodexEntries.mockResolvedValue([pinned]);
    mocks.listPinnedStickyEntries.mockResolvedValue([sticky]);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handlePin("alice");
    });
    await waitFor(() => expect(mocks.pinCodexEntry).toHaveBeenCalledOnce());

    mocks.isStreaming = true;
    rerender({ disabled: true });
    write.resolve();
    await act(async () => pending);

    expect(result.current.pinnedIds.has("alice")).toBe(true);
    expect(result.current.pinnedStickies).toEqual([sticky]);
    expect(refreshContextLayers).not.toHaveBeenCalled();

    mocks.isStreaming = false;
    rerender({ disabled: false });
    await waitFor(() => expect(refreshContextLayers).toHaveBeenCalledOnce());
  });

  it("retries the first failed refresh after a busy defer without a prop transition", async () => {
    mocks.activeSessionId = "session-1";
    const write = deferred<void>();
    mocks.pinCodexEntry.mockReturnValueOnce(write.promise);
    const refreshContextLayers = vi
      .fn<() => Promise<null>>()
      .mockRejectedValueOnce(new Error("first deferred refresh failed"))
      .mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        mutationsDisabled: false,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers,
      }),
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handlePin("alice");
    });
    await waitFor(() => expect(mocks.pinCodexEntry).toHaveBeenCalledOnce());

    mocks.isStreaming = true;
    write.resolve();
    await act(async () => pending);
    expect(refreshContextLayers).not.toHaveBeenCalled();

    const previous = currentMockChatState();
    act(() => {
      mocks.isStreaming = false;
      notifyMockChatState(previous);
    });
    await waitFor(() => expect(refreshContextLayers).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("retries one failed context refresh without creating a retry loop", async () => {
    mocks.activeSessionId = "session-1";
    const refreshContextLayers = vi
      .fn<() => Promise<null>>()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers,
      }),
    );

    await act(async () => result.current.handlePin("alice"));

    await waitFor(() => expect(refreshContextLayers).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("hides the previous session pins before the replacement read completes", async () => {
    mocks.activeSessionId = "session-1";
    const sessionOnePin = {
      ...codex("alice"),
      withChildren: false,
      pinnedType: "codex",
      pinSource: "manual",
    } as PinnedCodexEntryWithData;
    mocks.listPinnedCodexEntries.mockResolvedValueOnce([sessionOnePin]);
    const sessionTwoRead = deferred<PinnedCodexEntryWithData[]>();
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useChatPinsController({
          isActive: true,
          activeSessionId: sessionId,
          pinsVersion: 0,
          allCodexEntries: [codex("alice")],
          ensureSession: async () => sessionId,
          removeEntryFromAuto: vi.fn(),
          excludeEntryFromAuto: vi.fn(),
          clearAutoExclusion: vi.fn(),
          refreshContextLayers: async () => null,
        }),
      { initialProps: { sessionId: "session-1" } },
    );
    await waitFor(() =>
      expect(result.current.pinnedIds.has("alice")).toBe(true),
    );

    mocks.listPinnedCodexEntries.mockReturnValueOnce(sessionTwoRead.promise);
    mocks.activeSessionId = "session-2";
    rerender({ sessionId: "session-2" });

    expect(result.current.pinnedEntries).toEqual([]);
    sessionTwoRead.resolve([]);
    await waitFor(() =>
      expect(mocks.listPinnedCodexEntries).toHaveBeenCalledWith("session-2"),
    );
  });

  it("does not create an auto exclusion when unpin persistence fails", async () => {
    mocks.activeSessionId = "session-1";
    mocks.unpinCodexEntry.mockRejectedValueOnce(new Error("unpin failed"));
    const excludeEntryFromAuto = vi.fn(() => true);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto,
        clearAutoExclusion: vi.fn(),
        refreshContextLayers: async () => null,
      }),
    );

    await act(async () => result.current.handleRemoveEntry("alice"));

    expect(excludeEntryFromAuto).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("clears an auto exclusion before refreshing a returned pin", async () => {
    mocks.activeSessionId = "session-1";
    const clearAutoExclusion = vi.fn();
    const refreshContextLayers = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion,
        refreshContextLayers,
      }),
    );

    await act(async () => result.current.handleReturnToAuto("alice"));

    expect(mocks.unpinCodexEntry).toHaveBeenCalledWith("session-1", "alice");
    expect(clearAutoExclusion).toHaveBeenCalledWith("alice");
    expect(refreshContextLayers).toHaveBeenCalledOnce();
    expect(clearAutoExclusion.mock.invocationCallOrder[0]).toBeLessThan(
      refreshContextLayers.mock.invocationCallOrder[0],
    );
  });

  it("catches a failed sticky unpin without refreshing stale state", async () => {
    mocks.activeSessionId = "session-1";
    mocks.unpinStickyEntry.mockRejectedValueOnce(
      new Error("sticky unpin failed"),
    );
    const refreshContextLayers = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers,
      }),
    );

    await act(async () => result.current.handleUnpinSticky("sticky-1"));

    expect(mocks.unpinStickyEntry).toHaveBeenCalledWith(
      "session-1",
      "sticky-1",
    );
    expect(refreshContextLayers).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("does not create an auto exclusion when the session changes during unpin readback", async () => {
    mocks.activeSessionId = "session-1";
    const readback = deferred<PinnedCodexEntryWithData[]>();
    const refreshContextLayers = vi.fn(async () => null);
    const excludeEntryFromAuto = vi.fn(() => true);
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto,
        clearAutoExclusion: vi.fn(),
        refreshContextLayers,
      }),
    );
    await waitFor(() =>
      expect(mocks.listPinnedCodexEntries).toHaveBeenCalledWith("session-1"),
    );
    mocks.listPinnedCodexEntries.mockReturnValueOnce(readback.promise);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleRemoveEntry("alice");
    });
    await waitFor(() => expect(mocks.unpinCodexEntry).toHaveBeenCalledOnce());

    mocks.activeSessionId = "session-2";
    readback.resolve([]);
    await act(async () => pending);

    expect(excludeEntryFromAuto).not.toHaveBeenCalled();
    expect(refreshContextLayers).not.toHaveBeenCalled();
  });

  it("reports a failed children toggle without an unhandled rejection", async () => {
    mocks.activeSessionId = "session-1";
    mocks.togglePinChildren.mockRejectedValueOnce(new Error("toggle failed"));
    const { result } = renderHook(() =>
      useChatPinsController({
        isActive: true,
        activeSessionId: "session-1",
        pinsVersion: 0,
        allCodexEntries: [codex("alice")],
        ensureSession: async () => "session-1",
        removeEntryFromAuto: vi.fn(),
        excludeEntryFromAuto: vi.fn(),
        clearAutoExclusion: vi.fn(),
        refreshContextLayers: async () => null,
      }),
    );

    await act(async () =>
      result.current.handleTogglePinChildren("alice", true),
    );

    expect(toast.error).toHaveBeenCalledTimes(1);
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
