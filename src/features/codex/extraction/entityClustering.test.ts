import { describe, expect, it } from "vitest";
import { clusterEntityMentions } from "./entityClustering";
import type {
  EntityIdentityObservation,
  EntityMentionObservation,
} from "@/features/narrative-extraction/ir/observations/entityIdentity";

function mention(
  overrides: Partial<EntityMentionObservation> &
    Pick<EntityMentionObservation, "localId"> & {
      surface?: string | null;
      form?: EntityMentionObservation["payload"]["mentionForm"];
      sourceRef?: string;
    },
): EntityMentionObservation {
  const surface = overrides.surface ?? "ライカ";
  return {
    localId: overrides.localId,
    kind: "entity-mention",
    evidence: overrides.evidence ?? [
      {
        sourceRef: overrides.sourceRef ?? "S0001",
        quote: surface ?? "彼",
      },
    ],
    assertion: overrides.assertion ?? {
      attribution: "narrator",
      narrativeFrame: "story-world",
    },
    payload: overrides.payload ?? {
      surface,
      mentionForm: overrides.form ?? "proper-name",
      entityClassHints: ["person"],
      referent: { kind: "local", localId: overrides.localId },
    },
  };
}

function identity(
  localId: string,
  left: string,
  right: string,
): EntityIdentityObservation {
  return {
    localId,
    kind: "entity-identity",
    evidence: [{ sourceRef: "S0001", quote: "黒騎士と呼ばれるライカ" }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      subject: { kind: "local", localId: left },
      identity: {
        kind: "same-as",
        other: { kind: "local", localId: right },
      },
      temporalMode: "timeless",
    },
  };
}

describe("clusterEntityMentions", () => {
  it("blocks same normalized surface into one cluster", () => {
    const clusters = clusterEntityMentions({
      seeds: [
        {
          seedId: "seed-1",
          surface: "ライカ",
          normalizedSurface: "ライカ",
          sourceRefs: ["S0001"],
        },
      ],
      mentions: [
        mention({ localId: "m1", surface: "ライカ" }),
        mention({ localId: "m2", surface: "ライカ" }),
      ],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.mentionObservationIds).toEqual(["m1", "m2"]);
    expect(clusters[0]?.deterministicSeedIds).toEqual(["seed-1"]);
  });

  it("keeps different surfaces in separate clusters without O(N²) merge", () => {
    const clusters = clusterEntityMentions({
      seeds: [],
      mentions: [
        mention({ localId: "m1", surface: "ライカ" }),
        mention({ localId: "m2", surface: "マルフーシャ" }),
      ],
    });
    expect(clusters).toHaveLength(2);
  });

  it("merges explicit same-as identity observations", () => {
    const clusters = clusterEntityMentions({
      seeds: [],
      mentions: [
        mention({ localId: "m1", surface: "ライカ" }),
        mention({ localId: "m2", surface: "黒騎士", form: "alias" }),
      ],
      identities: [identity("id1", "m1", "m2")],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.mentionObservationIds).toEqual(["m1", "m2"]);
    expect(clusters[0]?.identityObservationIds).toEqual(["id1"]);
  });

  it("attaches a unique same-window pronoun to the named mention", () => {
    const clusters = clusterEntityMentions({
      seeds: [],
      mentions: [
        mention({ localId: "m1", surface: "ライカ", sourceRef: "S0001" }),
        mention({
          localId: "m2",
          surface: "彼女",
          form: "pronoun",
          sourceRef: "S0001",
        }),
      ],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.mentionObservationIds).toEqual(["m1", "m2"]);
  });
});
