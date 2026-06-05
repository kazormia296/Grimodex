import { describe, it, expect } from "vitest";
import type { PostEffectAnnotation } from "./types";
import { selectConsistencyFindingsForEntry } from "./consistencyByEntry";

function consistencyAnn(
  id: string,
  entryId: string,
  overrides: Partial<PostEffectAnnotation> = {},
): PostEffectAnnotation {
  return {
    id,
    category: "consistency_anchor",
    sceneId: `scene-${id}`,
    metadata: JSON.stringify({
      codex_ref: {
        entry_id: entryId,
        entry_name: "田中",
        source_field: "summary",
        expected_value: "30歳",
        found_value: "40歳",
        found_text: "四十歳の田中",
        found_context: "...四十歳の田中は...",
        confidence: "high",
        llm_reason: "年齢が設定と矛盾",
        dismiss_key: `k-${id}`,
      },
    }),
    ...overrides,
  } as unknown as PostEffectAnnotation;
}

function reviewAnn(id: string): PostEffectAnnotation {
  return {
    id,
    category: "review",
    sceneId: `scene-${id}`,
    metadata: JSON.stringify({ llm_reason: "テンポが悪い" }),
  } as unknown as PostEffectAnnotation;
}

describe("selectConsistencyFindingsForEntry", () => {
  it("returns only consistency findings referencing the given entry", () => {
    const anns = [
      consistencyAnn("a", "e1"),
      consistencyAnn("b", "e2"),
      consistencyAnn("c", "e1"),
      reviewAnn("d"),
    ];
    const found = selectConsistencyFindingsForEntry(anns, "e1");
    expect(found.map((f) => f.annotation.id)).toEqual(["a", "c"]);
    expect(found[0].meta.kind).toBe("consistency");
    expect(found[0].meta.codex?.entryName).toBe("田中");
  });

  it("returns [] for an entry with no findings", () => {
    expect(
      selectConsistencyFindingsForEntry([consistencyAnn("a", "e1")], "e9"),
    ).toEqual([]);
  });

  it("returns [] for an empty entryId (no accidental match)", () => {
    expect(
      selectConsistencyFindingsForEntry([consistencyAnn("a", "e1")], ""),
    ).toEqual([]);
  });

  it("ignores non-consistency annotations even if entryId matches nothing", () => {
    expect(selectConsistencyFindingsForEntry([reviewAnn("d")], "e1")).toEqual(
      [],
    );
  });
});
