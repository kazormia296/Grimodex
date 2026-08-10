import { describe, expect, it } from "vitest";
import type { CodexEntityHypothesis } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import { planBindCodexEntityProposals } from "./proposalPlanner";

function hypothesis(
  overrides: Partial<CodexEntityHypothesis["payload"]> & {
    hypothesisId?: string;
  } = {},
): CodexEntityHypothesis {
  const { hypothesisId, ...payloadOverrides } = overrides;
  return {
    hypothesisId: hypothesisId ?? "hyp-1",
    clusterRef: "cluster-1",
    payload: {
      entityId: "ne-1",
      canonicalName: "ライカ",
      mentionSurfaces: [
        {
          surface: "ライカ",
          form: "proper-name",
          observationIds: ["obs-1"],
        },
      ],
      aliases: [],
      coarseClass: "person",
      typeResolution: { status: "resolved", typeRef: "T0001" },
      existingResolution: { status: "none" },
      summarySuggestion: "騎士見習い",
      ...payloadOverrides,
    },
  };
}

describe("planBindCodexEntityProposals", () => {
  it("emits create-new for nameable entities with no existing match", () => {
    const planned = planBindCodexEntityProposals({
      hypotheses: [hypothesis()],
      createId: () => "p1",
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.blocked).toBe(false);
    expect(planned[0]?.proposal.payload.binding).toEqual({
      kind: "create-new",
      entry: {
        name: "ライカ",
        aliases: [],
        summary: "騎士見習い",
      },
    });
  });

  it("does not create-new for pronoun-only clusters", () => {
    const planned = planBindCodexEntityProposals({
      hypotheses: [
        hypothesis({
          canonicalName: "彼女",
          mentionSurfaces: [
            {
              surface: "彼女",
              form: "pronoun",
              observationIds: ["obs-p"],
            },
          ],
        }),
      ],
      createId: () => "p-pronoun",
    });
    expect(planned).toHaveLength(0);
  });

  it("includes only explicit identity aliases", () => {
    const planned = planBindCodexEntityProposals({
      hypotheses: [
        hypothesis({
          aliases: [
            {
              surface: "灰の目",
              status: "explicit",
              identityObservationIds: ["id-1"],
            },
            {
              surface: "あの子",
              status: "coreference-only",
              identityObservationIds: [],
            },
            {
              surface: "少女",
              status: "user-confirmation-required",
              identityObservationIds: [],
            },
          ],
        }),
      ],
      createId: () => "p-alias",
    });
    expect(planned[0]?.proposal.payload.aliases).toEqual([
      { surface: "灰の目", status: "explicit" },
    ]);
    const binding = planned[0]?.proposal.payload.binding;
    expect(binding?.kind).toBe("create-new");
    if (binding?.kind === "create-new") {
      expect(binding.entry.aliases).toEqual(["灰の目"]);
    }
  });

  it("binds existing with fill-if-empty summary only", () => {
    const planned = planBindCodexEntityProposals({
      hypotheses: [
        hypothesis({
          existingResolution: {
            status: "resolved",
            ref: "K0001",
            method: "exact-name",
          },
          aliases: [
            {
              surface: "灰の目",
              status: "explicit",
              identityObservationIds: ["id-1"],
            },
          ],
          summarySuggestion: "補完候補",
        }),
      ],
      createId: () => "p-bind",
    });
    expect(planned[0]?.proposal.payload.binding).toEqual({
      kind: "bind-existing",
      entityRef: "K0001",
      enrichment: {
        aliasesToAdd: ["灰の目"],
        summary: { kind: "fill-if-empty", value: "補完候補" },
      },
    });
  });

  it("marks type unresolved create-new as blocked", () => {
    const planned = planBindCodexEntityProposals({
      hypotheses: [
        hypothesis({
          typeResolution: { status: "unresolved" },
        }),
      ],
      createId: () => "p-type",
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.blocked).toBe(true);
    expect(planned[0]?.blockedReason).toMatch(/Type/);
  });

  it("emits unresolved when existing matches are ambiguous", () => {
    const planned = planBindCodexEntityProposals({
      hypotheses: [
        hypothesis({
          existingResolution: {
            status: "ambiguous",
            candidates: [
              {
                ref: "K0001",
                score: 90,
                methods: ["exact-name"],
              },
              {
                ref: "K0002",
                score: 88,
                methods: ["exact-name"],
              },
            ],
          },
        }),
      ],
      createId: () => "p-amb",
    });
    expect(planned[0]?.blocked).toBe(true);
    expect(planned[0]?.proposal.payload.binding.kind).toBe("unresolved");
  });
});
