import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";

// 地図の AI Branch が AI へ送る種（seed）・Spotlight は、作者が hidden（AI に秘匿）と
// 印した Codex を含まない。

const h = vi.hoisted(() => ({
  codex: [] as Array<Record<string, unknown>>,
  pins: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: { getState: () => ({ entries: h.codex }) },
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ nodes: [] }) },
}));
vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: { getState: () => ({ entries: [] }) },
}));
vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: { getState: () => ({ activeSessionId: "s1" }) },
}));
vi.mock("@/features/chat/chatApi", () => ({
  listPinnedCodexEntries: async () => h.pins,
  listPinnedSnippetEntries: async () => [],
  listPinnedStickyEntries: async () => [],
}));
vi.mock("@/features/project/contextAtoms", () => ({
  fetchProjectContext: async () => null,
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ get: () => "" }) },
}));

import {
  collectAiBranchSeeds,
  fetchActiveSessionSpotlight,
} from "./aiBranchContext";

function entry(id: string, contextMode: string) {
  return {
    id,
    name: `name-${id}`,
    summary: `summary-${id}`,
    content: "",
    contextMode,
  };
}

describe("AI Branch の seed・Spotlight と hidden の Codex", () => {
  beforeEach(() => {
    h.codex = [
      entry("a", "hidden"),
      entry("b", "mentioned"),
      entry("c", "suppress"),
      entry("d", "always"),
    ];
    h.pins = [entry("a", "hidden"), entry("b", "mentioned")];
  });

  it("hidden の Codex ノードは seed に入れず、ほかは足し引きしない", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({
      id: `codex:${id}`,
    })) as Node[];
    const seeds = collectAiBranchSeeds(nodes, [], []);
    expect(seeds.map((s) => s.title)).toEqual(["name-b", "name-c", "name-d"]);
    expect(JSON.stringify(seeds)).not.toContain("summary-a");
  });

  it("hidden の pin は Spotlight に入れない", async () => {
    const seeds = await fetchActiveSessionSpotlight();
    expect(seeds.map((s) => s.title)).toEqual(["name-b"]);
  });
});
