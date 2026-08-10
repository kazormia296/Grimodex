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

  it("skips directed seeds when subject/object orientation cannot be resolved", () => {
    const quote = "ライカとベルカの話に師匠という言葉が出た";
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
              documentRef: "D000004",
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
              documentRef: "D000004",
              method: "exact",
            },
          ],
        },
      ],
      vocabulary: BUILTIN_CODEX_RELATION_VOCABULARY.filter(
        (row) => row.forwardLabel === "師匠",
      ),
    });
    expect(seeds).toEqual([]);
  });
});
