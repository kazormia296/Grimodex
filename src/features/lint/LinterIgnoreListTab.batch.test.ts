// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { computeStaleness, type EntryRow } from "./LinterIgnoreListTab";

function entry(overrides: Partial<EntryRow>): EntryRow {
  return {
    id: "ignore-1",
    rule_id: "style/repetition",
    scene_id: "scene-a",
    text_snippet: "target",
    context_before: "before ",
    context_after: " after",
    note: null,
    created_at: 1,
    sceneTitle: "Scene",
    ...overrides,
  };
}

function storedDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
}

describe("computeStaleness batched scene loading", () => {
  it("loads distinct scenes once and preserves orphan/missing-row semantics", async () => {
    const loadContents = vi.fn(async (sceneIds: string[]) => {
      expect(sceneIds).toEqual(["scene-a", "scene-missing"]);
      return new Map([["scene-a", storedDoc("before target after")]]);
    });

    const result = await computeStaleness(
      [
        entry({ id: "active" }),
        entry({
          id: "stale",
          text_snippet: "elsewhere",
          context_before: "",
          context_after: "",
        }),
        entry({
          id: "missing",
          scene_id: "scene-missing",
          sceneTitle: "Missing",
        }),
        entry({ id: "orphan", scene_id: "deleted", sceneTitle: null }),
      ],
      loadContents,
    );

    expect(loadContents).toHaveBeenCalledOnce();
    expect(Object.fromEntries(result)).toEqual({
      orphan: "orphan",
      active: "active",
      stale: "stale",
      missing: "stale",
    });
  });

  it("marks loadable entries unknown but keeps orphans on batch failure", async () => {
    const loadContents = vi.fn(async (_sceneIds: string[]) => {
      throw new Error("database unavailable");
    });

    const result = await computeStaleness(
      [
        entry({ id: "unknown" }),
        entry({ id: "orphan", scene_id: "deleted", sceneTitle: null }),
      ],
      loadContents,
    );

    expect(Object.fromEntries(result)).toEqual({
      orphan: "orphan",
      unknown: "unknown",
    });
  });
});
