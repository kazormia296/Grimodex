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
  incremental_scope: "block",
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
  it("retains diagnostic identity when an edit does not change lint output", async () => {
    const initial = [block(0, "alpha", 0), block(1, "bravo", 6)];
    const unchangedDiagnostic = {
      rule_id: "en/double-space",
      severity: "warning" as const,
      message: "unchanged",
      range: { start: 0, end: 1 },
    };
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [unchangedDiagnostic],
      warnings: [],
      incremental_scope: "block",
      computed_at: 1,
    });
    await useLintStore
      .getState()
      .runLint("scene-1", initial, {}, "en", "alpha\nbravo", []);
    const firstDiagnostics = useLintStore.getState().diagnostics;

    const updated = [initial[0], block(1, "bravo!", 6)];
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [],
      warnings: [],
      incremental_scope: "block",
      computed_at: 2,
    });
    await useLintStore
      .getState()
      .runLint("scene-1", updated, {}, "en", "alpha\nbravo!", []);

    expect(useLintStore.getState().diagnostics).toBe(firstDiagnostics);
    expect(useLintStore.getState().diagnostics).toEqual([unchangedDiagnostic]);
  });

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

  it("refreshes a preceding unclosed-quote diagnostic when only the next paragraph changes", async () => {
    const initial = [
      block(0, 'She said, "It was dark', 0),
      block(1, "Then silence.", 24),
    ];
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [
        {
          rule_id: "en/unclosed-quote",
          severity: "warning",
          message: "Opening quote has no matching closing quote",
          range: { start: 10, end: 23 },
        },
      ],
      warnings: [],
      incremental_scope: "nextBlock",
      computed_at: 1,
    });

    await useLintStore
      .getState()
      .runLint(
        "scene-1",
        initial,
        {},
        "en",
        'She said, "It was dark\nThen silence.',
        [],
      );
    expect(useLintStore.getState().diagnostics).toHaveLength(1);

    const updated = [
      initial[0],
      block(1, '"and it stayed dark," she continued.', 24),
    ];
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [],
      warnings: [],
      incremental_scope: "nextBlock",
      computed_at: 2,
    });

    await useLintStore
      .getState()
      .runLint(
        "scene-1",
        updated,
        {},
        "en",
        'She said, "It was dark\n"and it stayed dark," she continued.',
        [],
      );

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1][1]).toMatchObject({ blocks: updated });
    expect(useLintStore.getState().diagnostics).toEqual([]);
  });

  it("does not overwrite a cache hit that is sent only as next-block context", async () => {
    const initial = [
      block(0, "alpha", 0),
      block(1, "bravo", 6),
      block(2, "charlie", 12),
    ];
    const unchangedTailDiagnostic = {
      rule_id: "en/double-space",
      severity: "warning" as const,
      message: "tail diagnostic",
      range: { start: 12, end: 13 },
    };
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [unchangedTailDiagnostic],
      warnings: [],
      incremental_scope: "nextBlock",
      computed_at: 1,
    });
    await useLintStore
      .getState()
      .runLint("scene-1", initial, {}, "en", "alpha\nbravo\ncharlie", []);

    const updated = [initial[0], block(1, "bravo!", 6), initial[2]];
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [],
      warnings: [],
      incremental_scope: "nextBlock",
      computed_at: 2,
    });
    await useLintStore
      .getState()
      .runLint("scene-1", updated, {}, "en", "alpha\nbravo!\ncharlie", []);

    expect(mockInvoke.mock.calls[1][1]).toMatchObject({ blocks: updated });
    expect(useLintStore.getState().diagnostics).toEqual([
      unchangedTailDiagnostic,
    ]);
  });

  it("recomputes the whole scene when Rust reports a scene-scoped rule", async () => {
    const initial = [block(0, "alpha", 0), block(1, "bravo", 6)];
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [],
      warnings: [],
      incremental_scope: "scene",
      computed_at: 1,
    });
    await useLintStore
      .getState()
      .runLint("scene-1", initial, {}, "en", "alpha\nbravo", []);

    const updated = [initial[0], block(1, "bravo!", 6)];
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [],
      warnings: [],
      incremental_scope: "scene",
      computed_at: 2,
    });
    await useLintStore
      .getState()
      .runLint("scene-1", updated, {}, "en", "alpha\nbravo!", []);

    expect(mockInvoke.mock.calls[1][1]).toMatchObject({ blocks: updated });
  });

  it("falls back to scene invalidation when an older backend omits the scope", async () => {
    const initial = [block(0, "alpha", 0), block(1, "bravo", 6)];
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [],
      warnings: [],
      computed_at: 1,
    });
    await useLintStore
      .getState()
      .runLint("scene-1", initial, {}, "en", "alpha\nbravo", []);

    const updated = [initial[0], block(1, "bravo!", 6)];
    mockInvoke.mockResolvedValueOnce({
      diagnostics: [],
      warnings: [],
      computed_at: 2,
    });
    await useLintStore
      .getState()
      .runLint("scene-1", updated, {}, "en", "alpha\nbravo!", []);

    expect(mockInvoke.mock.calls[1][1]).toMatchObject({ blocks: updated });
  });
});
