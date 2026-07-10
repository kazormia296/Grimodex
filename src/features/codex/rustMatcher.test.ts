import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodexMatchTarget } from "./codexMatcher";

// ---------------------------------------------------------------------------
// Mock setup — simulate non-Tauri environment (fallback path)
// ---------------------------------------------------------------------------

// We test the JS fallback path since native IPC is not available in Vitest
// (neither Tauri nor Electron). The native path is covered by Rust unit tests
// in grimodex-core codex_matching.rs + the napi node:test smoke suite.

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  isTauri: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/shell", () => ({
  isElectron: vi.fn().mockReturnValue(false),
}));

vi.mock("@/features/project/projectLoadGate", () => ({
  isProjectLoading: vi.fn().mockReturnValue(false),
  whenProjectLoadDone: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@/lib/tauri";
import {
  rebuildMatcher,
  matchText,
  findMentionedEntriesAsync,
} from "./rustMatcher";

const ENTRIES: CodexMatchTarget[] = [
  { id: "c1", name: "太郎", type: "character" },
  { id: "c2", name: "花子", type: "character" },
  { id: "c3", name: "Alice", type: "character" },
];

// In test env, __TAURI_INTERNALS__ is not in window → fallback path is used
beforeEach(() => {
  vi.clearAllMocks();
});

describe("rebuildMatcher (non-Tauri)", () => {
  it("does not call invoke when Tauri is unavailable", async () => {
    await rebuildMatcher(ENTRIES);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("matchText (non-Tauri fallback)", () => {
  it("matches CJK entries via JS fallback", async () => {
    const matches = await matchText("太郎は走った", ENTRIES);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].entryId).toBe("c1");
  });

  it("respects excludeEntryIds", async () => {
    const matches = await matchText("太郎と花子", ENTRIES, ["c1"]);
    expect(matches.every((m) => m.entryId !== "c1")).toBe(true);
    expect(matches.some((m) => m.entryId === "c2")).toBe(true);
  });

  it("returns empty for text with no matches", async () => {
    const matches = await matchText("誰もいない", ENTRIES);
    expect(matches).toEqual([]);
  });

  it("returns empty for empty text", async () => {
    const matches = await matchText("", ENTRIES);
    expect(matches).toEqual([]);
  });
});

describe("findMentionedEntriesAsync (non-Tauri fallback)", () => {
  it("returns unique entries mentioned in text", async () => {
    const mentioned = await findMentionedEntriesAsync(
      "太郎と花子が会い、太郎は笑った",
      ENTRIES,
    );
    expect(mentioned).toHaveLength(2);
    const ids = mentioned.map((e) => e.id).sort();
    expect(ids).toEqual(["c1", "c2"]);
  });

  it("returns empty for empty text", async () => {
    const result = await findMentionedEntriesAsync("", ENTRIES);
    expect(result).toEqual([]);
  });

  it("returns empty for empty entries", async () => {
    const result = await findMentionedEntriesAsync("太郎が来た", []);
    expect(result).toEqual([]);
  });

  it("handles Latin entries case-insensitively", async () => {
    const mentioned = await findMentionedEntriesAsync(
      "alice went home",
      ENTRIES,
    );
    expect(mentioned).toHaveLength(1);
    expect(mentioned[0].id).toBe("c3");
  });
});
