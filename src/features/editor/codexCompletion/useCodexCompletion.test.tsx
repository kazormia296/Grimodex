// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexCompletion } from "./useCodexCompletion";

describe("useCodexCompletion", () => {
  afterEach(() => cleanup());

  it("does not reload Codex data from each editor instance", () => {
    const ensureEntriesLoaded = vi.fn(() => Promise.resolve());
    useCodexStore.setState({ ensureEntriesLoaded });

    const first = renderHook(() => useCodexCompletion(null));
    const second = renderHook(() => useCodexCompletion(null));

    expect(ensureEntriesLoaded).not.toHaveBeenCalled();
    first.unmount();
    second.unmount();
  });
});
