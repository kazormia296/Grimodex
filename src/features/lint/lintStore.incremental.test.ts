// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/a11y/announcer", () => ({
  announce: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
import { useLintIgnoreStore } from "./lintIgnoreStore";
import { useLintStore } from "./lintStore";
import type { LintConfig, LintResponse, WireLintBlock } from "./types";

const mockInvoke = vi.mocked(invoke);

function block(id: number, text: string, offset: number): WireLintBlock {
  return {
    id,
    kind: "paragraph",
    text,
    str_offset_start: offset,
  };
}

const emptyResponse: LintResponse = {
  diagnostics: [],
  warnings: [],
  computed_at: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(emptyResponse);
  useLintIgnoreStore.getState().clear();
  useLintStore.getState().clear();
  useLintStore.getState().setCurrentScene("scene-1");
});

describe("lintStore incremental scheduling", () => {
  it("sends only the changed block to Rust after the first scene pass", async () => {
    const initial = [block(0, "alpha", 0), block(1, "bravo", 6)];
    await useLintStore
      .getState()
      .runLint("scene-1", initial, {}, "ja", "alpha\nbravo", []);

    const updated = [block(0, "alpha", 0), block(1, "bravo!", 6)];
    await useLintStore
      .getState()
      .runLint("scene-1", updated, {}, "ja", "alpha\nbravo!", []);

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({ blocks: initial });
    expect(mockInvoke.mock.calls[1][1]).toMatchObject({
      blocks: [updated[1]],
    });
  });

  it("invalidates every cached block when the Codex revision changes", async () => {
    const blocks = [block(0, "Alice", 0), block(1, "Bob", 6)];
    const config: LintConfig = {
      codex_entries: [
        { entry_id: "alice", canonical: "アリス", aliases: ["Alice"] },
      ],
    };
    await useLintStore
      .getState()
      .runLint("scene-1", blocks, config, "ja", "Alice\nBob", [], { codex: 1 });
    await useLintStore
      .getState()
      .runLint("scene-1", blocks, config, "ja", "Alice\nBob", [], { codex: 2 });

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1][1]).toMatchObject({ blocks });
  });
});
