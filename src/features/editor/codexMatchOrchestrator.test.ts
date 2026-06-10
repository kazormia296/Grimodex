import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Editor } from "@tiptap/core";
import { scheduleMatch, rebuildAndSchedule } from "./codexMatchOrchestrator";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import { useCodexHighlightStore } from "./codexHighlightStore";

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

/**
 * Fake editor with MUTABLE doc text (`_setText`). scheduleMatch extracts the
 * doc text lazily at debounce-fire time, so tests vary content by mutating
 * the doc between schedule and fire.
 */
function makeEditor(initialText = "太郎は走った") {
  const dispatched: unknown[] = [];
  let text = initialText;
  const tr = {
    setMeta: vi.fn().mockReturnThis(),
  };
  return {
    state: {
      tr,
      doc: {
        descendants: (
          cb: (
            node: { isText: boolean; text: string; type: { name: string } },
            pos: number,
          ) => void,
        ) => {
          cb({ isText: true, text, type: { name: "text" } }, 0);
        },
      },
    },
    view: { dispatch: vi.fn((t) => dispatched.push(t)) },
    isDestroyed: false,
    _dispatched: dispatched,
    _setText: (next: string) => {
      text = next;
    },
  } as unknown as Editor & {
    _dispatched: unknown[];
    _setText: (next: string) => void;
  };
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
    scheduleMatch(editor, ENTRIES, [], 150);

    // Before debounce fires — no dispatch yet
    expect(editor.view.dispatch).not.toHaveBeenCalled();

    // Fire debounce
    await vi.runAllTimersAsync();

    expect(matchText).toHaveBeenCalledWith("太郎は走った", ENTRIES, []);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("extracts doc text lazily at fire time, not at schedule time (perf gate)", async () => {
    // タイピング経路の perf 契約: schedule 時に full-doc walk しない。
    // schedule 後に doc が変わった場合、fire 時の最新テキストで match する。
    const editor = makeEditor("schedule時のテキスト");
    scheduleMatch(editor, ENTRIES, [], 150);

    editor._setText("fire時のテキスト");
    await vi.runAllTimersAsync();

    expect(matchText).toHaveBeenCalledTimes(1);
    expect(matchText).toHaveBeenCalledWith("fire時のテキスト", ENTRIES, []);
  });

  it("debounces: only the last call fires, with the latest doc text", async () => {
    const editor = makeEditor("text1");
    scheduleMatch(editor, ENTRIES, [], 150);
    editor._setText("text2");
    scheduleMatch(editor, ENTRIES, [], 150);
    editor._setText("text3");
    scheduleMatch(editor, ENTRIES, [], 150);

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

    const editor = makeEditor("text1");

    // Call 1 fires its timer (debounce=0); matchText("text1") is now awaiting firstPending
    scheduleMatch(editor, ENTRIES, [], 0);
    await vi.runAllTimersAsync();

    // Supersede with call 2 — version incremented; call 1's result will be stale
    editor._setText("text2");
    scheduleMatch(editor, ENTRIES, [], 0);
    await vi.runAllTimersAsync(); // matchText("text2") resolves → dispatch

    // Resolve call 1 — version mismatch → must NOT dispatch again
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve(); // flush microtask queue

    expect(matchText).toHaveBeenCalledTimes(2);
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not match nor dispatch if editor is destroyed", async () => {
    const editor = makeEditor();
    (editor as unknown as { isDestroyed: boolean }).isDestroyed = true;

    scheduleMatch(editor, ENTRIES, [], 0);
    await vi.runAllTimersAsync();

    // Early return before text extraction — matchText is never reached
    expect(matchText).not.toHaveBeenCalled();
    expect(editor.view.dispatch).not.toHaveBeenCalled();
  });

  it("passes excludeEntryIds to matchText", async () => {
    const editor = makeEditor("text");
    scheduleMatch(editor, ENTRIES, ["c1"], 0);
    await vi.runAllTimersAsync();

    expect(matchText).toHaveBeenCalledWith("text", ENTRIES, ["c1"]);
  });

  it("updates matchedEntryIds when skipMatchedIds is false (default)", async () => {
    useCodexHighlightStore.setState({ matchedEntryIds: [] });
    const editor = makeEditor();
    scheduleMatch(editor, ENTRIES, [], 0, false);
    await vi.runAllTimersAsync();

    expect(useCodexHighlightStore.getState().matchedEntryIds).toEqual(["c1"]);
  });

  it("does NOT update matchedEntryIds when skipMatchedIds is true", async () => {
    useCodexHighlightStore.setState({ matchedEntryIds: [] });
    const editor = makeEditor();
    scheduleMatch(editor, ENTRIES, [], 0, true);
    await vi.runAllTimersAsync();

    // dispatch still fires (decorations), but matchedEntryIds stays empty
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1);
    expect(useCodexHighlightStore.getState().matchedEntryIds).toEqual([]);
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

  it("clears matchedEntryIds when entries empty and skipMatchedIds is false", async () => {
    useCodexHighlightStore.setState({ matchedEntryIds: ["c1"] });
    const editor = makeEditor();
    await rebuildAndSchedule(editor, [], [], false);

    expect(useCodexHighlightStore.getState().matchedEntryIds).toEqual([]);
  });

  it("does NOT clear matchedEntryIds when entries empty and skipMatchedIds is true", async () => {
    useCodexHighlightStore.setState({ matchedEntryIds: ["c1"] });
    const editor = makeEditor();
    await rebuildAndSchedule(editor, [], [], true);

    expect(useCodexHighlightStore.getState().matchedEntryIds).toEqual(["c1"]);
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
