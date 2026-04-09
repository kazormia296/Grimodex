import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Editor } from "@tiptap/core";
import { scheduleMatch, rebuildAndSchedule } from "./codexMatchOrchestrator";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/features/codex/rustMatcher", () => ({
  rebuildMatcher: vi.fn().mockResolvedValue(undefined),
  matchText: vi.fn().mockResolvedValue([
    {
      entryId: "c1",
      entryName: "太郎",
      entryType: "character",
      from: 0,
      to: 2,
    },
  ]),
}));

import { matchText, rebuildMatcher } from "@/features/codex/rustMatcher";

const ENTRIES: CodexMatchTarget[] = [
  { id: "c1", name: "太郎", type: "character" },
];

function makeEditor() {
  const dispatched: unknown[] = [];
  const tr = {
    setMeta: vi.fn().mockReturnThis(),
  };
  return {
    state: { tr, doc: { textContent: "太郎は走った" } },
    view: { dispatch: vi.fn((t) => dispatched.push(t)) },
    isDestroyed: false,
    _dispatched: dispatched,
  } as unknown as Editor & { _dispatched: unknown[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scheduleMatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches codexHighlightResult after debounce", async () => {
    const editor = makeEditor();
    scheduleMatch("太郎は走った", editor, ENTRIES, [], 150);

    // Before debounce fires — no dispatch yet
    expect(editor.view.dispatch).not.toHaveBeenCalled();

    // Fire debounce
    await vi.runAllTimersAsync();

    expect(matchText).toHaveBeenCalledWith("太郎は走った", ENTRIES, []);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("debounces: only the last call fires", async () => {
    const editor = makeEditor();
    scheduleMatch("text1", editor, ENTRIES, [], 150);
    scheduleMatch("text2", editor, ENTRIES, [], 150);
    scheduleMatch("text3", editor, ENTRIES, [], 150);

    await vi.runAllTimersAsync();

    // Only the final call's matchText should be invoked
    expect(matchText).toHaveBeenCalledTimes(1);
    expect(matchText).toHaveBeenCalledWith("text3", ENTRIES, []);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("discards stale result when a newer call supersedes it", async () => {
    // Deferred: lets us control when matchText("text1") resolves
    let resolveFirst!: () => void;
    const firstPending = new Promise<void>((r) => (resolveFirst = r));

    vi.mocked(matchText).mockImplementation(async (text) => {
      if (text === "text1") await firstPending;
      return [
        {
          entryId: "c1",
          entryName: "太郎",
          entryType: "character",
          from: 0,
          to: 2,
        },
      ];
    });

    const editor = makeEditor();

    // Call 1 fires its timer (debounce=0); matchText("text1") is now awaiting firstPending
    scheduleMatch("text1", editor, ENTRIES, [], 0);
    await vi.runAllTimersAsync();

    // Supersede with call 2 — version incremented; call 1's result will be stale
    scheduleMatch("text2", editor, ENTRIES, [], 0);
    await vi.runAllTimersAsync(); // matchText("text2") resolves → dispatch

    // Resolve call 1 — version mismatch → must NOT dispatch again
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve(); // flush microtask queue

    expect(matchText).toHaveBeenCalledTimes(2);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch if editor is destroyed", async () => {
    const editor = makeEditor();
    (editor as unknown as { isDestroyed: boolean }).isDestroyed = true;

    scheduleMatch("text", editor, ENTRIES, [], 0);
    await vi.runAllTimersAsync();

    expect(editor.view.dispatch).not.toHaveBeenCalled();
  });

  it("passes excludeEntryIds to matchText", async () => {
    const editor = makeEditor();
    scheduleMatch("text", editor, ENTRIES, ["c1"], 0);
    await vi.runAllTimersAsync();

    expect(matchText).toHaveBeenCalledWith("text", ENTRIES, ["c1"]);
  });
});

describe("rebuildAndSchedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears decorations and skips rebuild when entries is empty", async () => {
    const editor = makeEditor();
    await rebuildAndSchedule(editor, []);

    expect(rebuildMatcher).not.toHaveBeenCalled();
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
    // The dispatch should carry codexHighlightResult = []
    const tr = (editor as ReturnType<typeof makeEditor>).state.tr;
    expect(tr.setMeta).toHaveBeenCalledWith("codexHighlightResult", []);
  });

  it("calls rebuildMatcher then schedules match with debounce=0", async () => {
    const editor = makeEditor();
    await rebuildAndSchedule(editor, ENTRIES);

    expect(rebuildMatcher).toHaveBeenCalledWith(ENTRIES);
    // After the instant debounce (0ms), matchText should fire
    await vi.runAllTimersAsync();

    expect(matchText).toHaveBeenCalledWith("太郎は走った", ENTRIES, []);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
  });
});
