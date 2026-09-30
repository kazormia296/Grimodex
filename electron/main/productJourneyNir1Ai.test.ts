import { describe, expect, it } from "vitest";
import corpus from "../../evals/nir1-retrieval/corpus.json" with { type: "json" };
import { productJourneyChronicleResponse } from "./productJourneyChronicleAi.js";

type Scene = {
  id: string;
  body: string;
  interpretationSeed?: {
    summary: string;
    actuality: string;
    attribution: string;
    narrativeFrame: string;
  } | null;
};
const scenes: Scene[] = Object.values(corpus.languages).flatMap(
  (language) => language.scenes,
);
function request(pathId: string, context: string) {
  return {
    auditContext: { pathId },
    messages: [
      {
        role: "user",
        content: `Do not use Eold or cluster-old.\n# Context Set (chronicle.prompt/1)\n${context}\n# Output (JSON only)\n{}`,
      },
    ],
  };
}
function observe(scene: Scene, binding: string, segments?: unknown[]) {
  return request(
    "narrative_observation_extract",
    [
      "--- contextId=observation-citation-window:current inputRef=citation-window:current ---",
      ...(
        segments ?? [
          {
            kind: "span",
            text: scene.body.slice(0, 10),
            evidenceRef: `E${binding}-1`,
          },
          {
            kind: "span",
            text: scene.body.slice(10),
            evidenceRef: `E${binding}-2`,
          },
          { kind: "separator", text: "\n" },
        ]
      ).map((segment) => JSON.stringify(segment)),
    ].join("\n"),
  );
}
function synthesize(scene: Scene, binding: string) {
  return request(
    "narrative_event_synthesize",
    [
      `--- contextId=event-cluster:${binding} inputRef=cluster:${binding} ---\n${binding}`,
      `--- contextId=event-observation:${binding}:opaque inputRef=observation:${binding}:opaque ---\n- localId=${binding}:opaque; actuality=actual; predicate=${scene.interpretationSeed!.summary}; evidence=S1:${scene.body}`,
    ].join("\n\n"),
  );
}

describe("frozen NIR-1 deterministic provider mapping", () => {
  it("passes every whole source through current aliases and keeps fixed semantic meaning", () => {
    const supported = scenes.filter((scene) => scene.interpretationSeed);
    expect(supported).toHaveLength(28);
    for (const scene of supported) {
      for (const binding of ["first", "second"]) {
        const input = observe(scene, binding);
        const before = JSON.stringify(input);
        const response = JSON.parse(productJourneyChronicleResponse(input)!);
        expect(response.observations).toHaveLength(1);
        expect(response.observations[0]).toMatchObject({
          evidenceRefs: [`E${binding}-1`, `E${binding}-2`],
          assertion: { attribution: "narrator", narrativeFrame: "story-world" },
          payload: {
            predicate: scene.interpretationSeed!.summary,
            actuality: "actual",
          },
        });
        expect(JSON.stringify(input)).toBe(before);
        const synthesis = JSON.parse(
          productJourneyChronicleResponse(synthesize(scene, binding))!,
        );
        expect(synthesis).toMatchObject({
          clusterRef: binding,
          resolution: "single-event",
          events: [
            {
              summary: scene.interpretationSeed!.summary,
              observationRefs: [`${binding}:opaque`],
              actuality: "actual",
            },
          ],
        });
      }
    }
  });

  it("refuses every Raw-only source, including dream and style passages", () => {
    const unsupported = scenes.filter((scene) => !scene.interpretationSeed);
    expect(unsupported).toHaveLength(16);
    for (const scene of unsupported)
      expect(() =>
        productJourneyChronicleResponse(observe(scene, "current")),
      ).toThrow("Raw-only source");
  });

  it("rejects absent, duplicate or context-only citations without inventing Evidence", () => {
    const scene = scenes[0]!;
    for (const segments of [
      [{ kind: "span", text: scene.body }],
      [{ kind: "context", text: scene.body, evidenceRef: "Eoutside" }],
      [
        {
          kind: "span",
          text: scene.body.slice(0, 10),
          evidenceRef: "Edup",
        },
        { kind: "span", text: scene.body.slice(10), evidenceRef: "Edup" },
      ],
    ])
      expect(() =>
        productJourneyChronicleResponse(observe(scene, "current", segments)),
      ).toThrow("complete current source citations");
  });

  it("rejects a partial source, another source added to the target or foreign synthesis coordinates", () => {
    const scene = scenes[0]!;
    for (const body of [
      scene.body.slice(0, -5),
      `${scene.body}\n${scenes[1]!.body}`,
    ])
      expect(() =>
        productJourneyChronicleResponse(observe({ ...scene, body }, "current")),
      ).toThrow();
    const input = synthesize(scene, "current");
    input.messages[0]!.content = input.messages[0]!.content.replace(
      "inputRef=observation:current:opaque",
      "inputRef=observation:foreign",
    );
    expect(() => productJourneyChronicleResponse(input)).toThrow(
      "coordinates or actuality disagree",
    );
  });
});
