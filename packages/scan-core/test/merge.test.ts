import { describe, expect, it } from "vitest";
import { mergeEntities, mergeRelations } from "../src/index.js";

const evidence = {
  sectionId: "section:0:abcd1234",
  paragraphId: "paragraph:0:0:11111111",
};

describe("deterministic extraction merge", () => {
  it("merges exact names, normalized names, and explicit aliases", () => {
    const result = mergeEntities([
      {
        type: "character",
        name: "葵",
        aliases: ["アオイ"],
        evidence: [evidence],
        confidence: 0.7,
      },
      {
        type: "character",
        name: " 葵 ",
        aliases: [],
        evidence: [{ ...evidence, paragraphId: "paragraph:0:1:22222222" }],
        confidence: 0.9,
      },
      {
        type: "character",
        name: "アオイ",
        aliases: [],
        evidence: [evidence],
        confidence: 0.8,
      },
    ]);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.aliases).toContain("アオイ");
    expect(result.entities[0]?.evidence).toHaveLength(2);
    expect(result.ambiguities).toHaveLength(0);
  });

  it("does not auto-merge ambiguous homonyms", () => {
    const result = mergeEntities([
      {
        type: "character",
        name: "司",
        aliases: [],
        evidence: [evidence],
        confidence: 0.8,
      },
      {
        type: "place",
        name: "司",
        aliases: [],
        evidence: [evidence],
        confidence: 0.8,
      },
    ]);

    expect(result.entities).toHaveLength(2);
    expect(result.ambiguities).toHaveLength(1);
  });

  it("merges duplicate relations after resolving entity names", () => {
    const entities = mergeEntities([
      {
        type: "character",
        name: "葵",
        aliases: [],
        evidence: [evidence],
        confidence: 0.8,
      },
      {
        type: "place",
        name: "灯台",
        aliases: [],
        evidence: [evidence],
        confidence: 0.8,
      },
    ]);
    const result = mergeRelations(
      [
        {
          fromName: "葵",
          toName: "灯台",
          type: "located-at",
          evidence: [evidence],
          confidence: 0.6,
        },
        {
          fromName: "葵",
          toName: "灯台",
          type: "located-at",
          evidence: [{ ...evidence, paragraphId: "paragraph:0:1:22222222" }],
          confidence: 0.9,
        },
      ],
      entities.entities,
    );

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]?.evidence).toHaveLength(2);
    expect(result.unresolved).toHaveLength(0);
  });

  it("keeps entity identity stable when equivalent candidates are permuted", () => {
    const candidates = [
      {
        type: "character" as const,
        name: "葵",
        aliases: ["アオイ"],
        summary: "灯台守",
        evidence: [evidence],
        confidence: 0.7,
      },
      {
        type: "character" as const,
        name: " 葵 ",
        aliases: [],
        summary: "灯台守",
        evidence: [{ ...evidence, paragraphId: "paragraph:0:1:22222222" }],
        confidence: 0.9,
      },
    ];

    const forward = mergeEntities(candidates);
    const reverse = mergeEntities([...candidates].reverse());
    expect(reverse.entities[0]?.id).toBe(forward.entities[0]?.id);
    expect(reverse.entities[0]?.name).toBe(forward.entities[0]?.name);
  });
});
