import { describe, expect, it } from "vitest";
import { deriveRelationSeedsFromCoMentions } from "./codexStructureExtractionApi";
import { BUILTIN_CODEX_RELATION_VOCABULARY } from "./extraction/relationVocabulary";

describe("deriveRelationSeedsFromCoMentions", () => {
  it("does not invent co-mentions across separate evidence anchors", () => {
    const seeds = deriveRelationSeedsFromCoMentions({
      proposals: [
        {
          proposalId: "p-laika",
          displayTitle: "ライカ",
          narrativeEntityId: "ne-laika",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカは師匠について語った。",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
        {
          proposalId: "p-belka",
          displayTitle: "ベルカ",
          narrativeEntityId: "ne-belka",
          evidence: [
            {
              anchorId: "a2",
              quote: "ベルカが部屋へ入ってきた。",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
      ],
      vocabulary: BUILTIN_CODEX_RELATION_VOCABULARY,
    });
    expect(seeds).toEqual([]);
  });

  it("resolves directed 父/子 from sentence structure, not proposal order", () => {
    const quote = "ベルカはライカの父だ";
    const seeds = deriveRelationSeedsFromCoMentions({
      proposals: [
        {
          proposalId: "p-laika",
          displayTitle: "ライカ",
          narrativeEntityId: "ne-laika",
          evidence: [
            {
              anchorId: "a1",
              quote,
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
        {
          proposalId: "p-belka",
          displayTitle: "ベルカ",
          narrativeEntityId: "ne-belka",
          evidence: [
            {
              anchorId: "a1",
              quote,
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
      ],
      vocabulary: BUILTIN_CODEX_RELATION_VOCABULARY.filter(
        (row) => row.forwardLabel === "父",
      ),
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      subjectEntityId: "ne-belka",
      objectEntityId: "ne-laika",
      forwardLabel: "父",
      directionality: "directed",
      documentRef: "D000001",
      anchorId: "a1",
      quote: "ベルカはライカの父",
    });
    expect(quote.startsWith(seeds[0]!.quote!)).toBe(true);
  });

  it("keeps quote provenance inside the matched span (no 240-char false exact)", () => {
    const prefix = "あ".repeat(250);
    const quote = `${prefix}ライカとベルカは友人だ`;
    const seeds = deriveRelationSeedsFromCoMentions({
      proposals: [
        {
          proposalId: "p-laika",
          displayTitle: "ライカ",
          narrativeEntityId: "ne-laika",
          evidence: [
            {
              anchorId: "a-long",
              quote,
              documentRef: "D000002",
              method: "exact",
            },
          ],
        },
        {
          proposalId: "p-belka",
          displayTitle: "ベルカ",
          narrativeEntityId: "ne-belka",
          evidence: [
            {
              anchorId: "a-long",
              quote,
              documentRef: "D000002",
              method: "exact",
            },
          ],
        },
      ],
      vocabulary: BUILTIN_CODEX_RELATION_VOCABULARY.filter(
        (row) => row.forwardLabel === "友人",
      ),
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.quote).toContain("ライカ");
    expect(seeds[0]?.quote).toContain("ベルカ");
    expect(seeds[0]?.quote).toContain("友人");
    expect(seeds[0]?.quote?.startsWith("あああ")).toBe(false);
    expect(seeds[0]?.documentRef).toBe("D000002");
    expect(seeds[0]?.anchorId).toBe("a-long");
  });

  it("does not suppress the reverse directed orientation as a duplicate", () => {
    const seeds = deriveRelationSeedsFromCoMentions({
      proposals: [
        {
          proposalId: "p-laika",
          displayTitle: "ライカ",
          narrativeEntityId: "ne-laika",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカはベルカの父だ",
              documentRef: "D000003",
              method: "exact",
            },
            {
              anchorId: "a2",
              quote: "ベルカはライカの父だ",
              documentRef: "D000003",
              method: "exact",
            },
          ],
        },
        {
          proposalId: "p-belka",
          displayTitle: "ベルカ",
          narrativeEntityId: "ne-belka",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカはベルカの父だ",
              documentRef: "D000003",
              method: "exact",
            },
            {
              anchorId: "a2",
              quote: "ベルカはライカの父だ",
              documentRef: "D000003",
              method: "exact",
            },
          ],
        },
      ],
      vocabulary: BUILTIN_CODEX_RELATION_VOCABULARY.filter(
        (row) => row.forwardLabel === "父",
      ),
    });
    expect(seeds).toHaveLength(2);
    const orientations = new Set(
      seeds.map((seed) => `${seed.subjectEntityId}>${seed.objectEntityId}`),
    );
    expect(orientations.has("ne-laika>ne-belka")).toBe(true);
    expect(orientations.has("ne-belka>ne-laika")).toBe(true);
  });

  it("aggregates the same semantic Relation across separate anchors into one seed", () => {
    const seeds = deriveRelationSeedsFromCoMentions({
      proposals: [
        {
          proposalId: "p-laika",
          displayTitle: "ライカ",
          narrativeEntityId: "ne-laika",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカとベルカは友人だ。",
              documentRef: "D000001",
              method: "exact",
            },
            {
              anchorId: "a2",
              quote: "その後もライカとベルカは友人であり続けた。",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
        {
          proposalId: "p-belka",
          displayTitle: "ベルカ",
          narrativeEntityId: "ne-belka",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカとベルカは友人だ。",
              documentRef: "D000001",
              method: "exact",
            },
            {
              anchorId: "a2",
              quote: "その後もライカとベルカは友人であり続けた。",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
      ],
      vocabulary: BUILTIN_CODEX_RELATION_VOCABULARY.filter(
        (row) => row.forwardLabel === "友人",
      ),
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.evidenceQuotes).toHaveLength(2);
    expect(seeds[0]?.evidenceQuotes?.map((row) => row.anchorId).sort()).toEqual(
      ["a1", "a2"],
    );
  });

  it("requires a relation-asserting copula for directed seeds", () => {
    const vocabulary = BUILTIN_CODEX_RELATION_VOCABULARY.filter(
      (row) => row.forwardLabel === "父" || row.forwardLabel === "師匠",
    );
    const make = (quote: string) =>
      deriveRelationSeedsFromCoMentions({
        proposals: [
          {
            proposalId: "p-laika",
            displayTitle: "ライカ",
            narrativeEntityId: "ne-laika",
            evidence: [
              {
                anchorId: "a1",
                quote,
                documentRef: "D1",
                method: "exact",
              },
            ],
          },
          {
            proposalId: "p-belka",
            displayTitle: "ベルカ",
            narrativeEntityId: "ne-belka",
            evidence: [
              {
                anchorId: "a1",
                quote,
                documentRef: "D1",
                method: "exact",
              },
            ],
          },
        ],
        vocabulary,
      });

    expect(make("ベルカはライカの父だ")).toHaveLength(1);
    expect(make("ベルカはライカの父である")).toHaveLength(1);
    expect(make("ベルカはライカの父を殺した")).toEqual([]);
    expect(make("ベルカはライカの師匠に会った")).toEqual([]);
  });

  it("requires asserting patterns for symmetric labels (rejects object/case uses)", () => {
    const vocabulary = BUILTIN_CODEX_RELATION_VOCABULARY.filter((row) =>
      ["友人", "敵", "家族"].includes(row.forwardLabel),
    );
    const make = (quote: string) =>
      deriveRelationSeedsFromCoMentions({
        proposals: [
          {
            proposalId: "p-laika",
            displayTitle: "ライカ",
            narrativeEntityId: "ne-laika",
            evidence: [
              {
                anchorId: "a1",
                quote,
                documentRef: "D1",
                method: "exact",
              },
            ],
          },
          {
            proposalId: "p-belka",
            displayTitle: "ベルカ",
            narrativeEntityId: "ne-belka",
            evidence: [
              {
                anchorId: "a1",
                quote,
                documentRef: "D1",
                method: "exact",
              },
            ],
          },
        ],
        vocabulary,
      });

    expect(make("ライカとベルカは友人だ")).toHaveLength(1);
    expect(make("ライカはベルカの友人だ")).toHaveLength(1);
    expect(make("ライカとベルカは敵を倒した。")).toEqual([]);
    expect(make("ライカとベルカは家族を守った。")).toEqual([]);
    expect(make("ライカとベルカは友人を助けた。")).toEqual([]);
  });

  it("merges overlapping canonical ranges even when quote strings differ", () => {
    const padLeft = "あ".repeat(80);
    const core = "ライカとベルカは友人だ";
    const padRight = "い".repeat(80);
    const full = `${padLeft}${core}${padRight}`;
    const laikaStart = padLeft.length;
    const belkaStart = padLeft.length + "ライカと".length;
    const documentTexts = new Map([["D-long", full]]);

    const seeds = deriveRelationSeedsFromCoMentions({
      proposals: [
        {
          proposalId: "p-laika",
          displayTitle: "ライカ",
          narrativeEntityId: "ne-laika",
          evidence: [
            {
              anchorId: "a-laika",
              quote: full.slice(0, belkaStart + "ベルカは友人だ".length),
              documentRef: "D-long",
              method: "exact-with-context",
              canonicalRange: {
                start: 0,
                end: belkaStart + "ベルカは友人だ".length,
              },
            },
          ],
        },
        {
          proposalId: "p-belka",
          displayTitle: "ベルカ",
          narrativeEntityId: "ne-belka",
          evidence: [
            {
              anchorId: "a-belka",
              quote: full.slice(laikaStart, full.length),
              documentRef: "D-long",
              method: "exact-with-context",
              canonicalRange: {
                start: laikaStart,
                end: full.length,
              },
            },
          ],
        },
      ],
      vocabulary: BUILTIN_CODEX_RELATION_VOCABULARY.filter(
        (row) => row.forwardLabel === "友人",
      ),
      documentTexts,
    });

    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.forwardLabel).toBe("友人");
    expect(seeds[0]?.quote).toContain("ライカ");
    expect(seeds[0]?.quote).toContain("ベルカ");
    expect(seeds[0]?.quote).toContain("友人");
  });
});
