import { describe, expect, it } from "vitest";
import fixture from "../shared/productJourneyMultiWindowFixture.json" with { type: "json" };
import { productJourneyChronicleResponse } from "./productJourneyChronicleAi.js";
import {
  productJourneyMultiWindowObservation,
  productJourneyMultiWindowSynthesis,
} from "./productJourneyMultiWindowAi.js";

const row = (key: string) => fixture.rows.find((r) => r.key === key)!;

function windowSection(
  windowId: string,
  segments: { kind: string; text: string; evidenceRef?: string }[],
) {
  return {
    contextId: `observation-citation-window:${windowId}`,
    inputRef: `citation-window:${windowId}`,
    value: segments.map((s) => JSON.stringify(s)).join("\n"),
  };
}
function request(pathId: string, context: string) {
  return {
    messages: [
      {
        role: "user",
        content: [
          "# Context Set (chronicle.prompt/1)",
          context,
          "",
          "# Output (JSON only)",
          "{}",
        ].join("\n"),
      },
    ],
    auditContext: { pathId, executionId: "audit-execution" },
  };
}
const synthesisSections = (keys: string[]) => [
  {
    contextId: "event-cluster:cluster-0001",
    inputRef: "cluster:cluster-0001",
    value: "cluster-0001",
  },
  ...keys.map((key, index) => ({
    contextId: `event-observation:window-00${index + 1}:${key}`,
    inputRef: `observation:window-00${index + 1}:${key}`,
    value: `- localId=window-00${index + 1}:${key}; actuality=actual; predicate=${row(key).predicate}; evidence=S1:x`,
  })),
];

describe("multi-window Journey response", () => {
  it("answers only a marker that is a visible span, with that span's alias", () => {
    const reply = productJourneyMultiWindowObservation([
      windowSection("window-001", [
        { kind: "context", text: "Filler one. " },
        { kind: "span", text: "Filler two. ", evidenceRef: "E-1" },
        { kind: "span", text: row("seal-first").marker, evidenceRef: "E-2" },
        { kind: "span", text: row("seal-last").marker, evidenceRef: "E-3" },
      ]),
    ]) as { observations: { localId: string; evidenceRefs: string[] }[] };
    expect(reply.observations.map((o) => [o.localId, o.evidenceRefs])).toEqual([
      ["seal-first", ["E-2"]],
      ["seal-last", ["E-3"]],
    ]);
  });

  it("leaves a marker that is only context to the window that owns it", () => {
    const reply = productJourneyMultiWindowObservation([
      windowSection("window-002", [
        { kind: "context", text: row("seal-first").marker },
        { kind: "span", text: row("bell-middle").marker, evidenceRef: "E-9" },
      ]),
    ]) as { observations: { localId: string }[] };
    expect(reply.observations.map((o) => o.localId)).toEqual(["bell-middle"]);
  });

  it("does not answer a request without any marker", () => {
    expect(
      productJourneyMultiWindowObservation([
        windowSection("window-001", [
          { kind: "span", text: "衛兵が門を開けた。", evidenceRef: "E-1" },
        ]),
      ]),
    ).toBeNull();
    expect(
      productJourneyMultiWindowSynthesis([
        ...synthesisSections([]),
        {
          contextId: "event-observation:o1",
          inputRef: "observation:o1",
          value:
            "- localId=o1; actuality=actual; predicate=門を開ける; evidence=S1:x",
        },
      ]),
    ).toBeNull();
  });

  it("folds observations of different windows into one event of one cluster", () => {
    const reply = productJourneyMultiWindowSynthesis(
      synthesisSections(["seal-first", "seal-last"]),
    ) as { events: { observationRefs: string[]; titleSuggestion: string }[] };
    expect(reply.events).toHaveLength(1);
    expect(reply.events[0]!.observationRefs).toEqual([
      "window-001:seal-first",
      "window-002:seal-last",
    ]);
    expect(reply.events[0]!.titleSuggestion).toBe(fixture.clusters.seal.title);
  });

  it("refuses a cluster that mixes two fixture clusters", () => {
    expect(() =>
      productJourneyMultiWindowSynthesis(
        synthesisSections(["seal-first", "bell-middle"]),
      ),
    ).toThrow(/ambiguous/);
  });

  it("is reached through the Chronicle Journey response for both stages", () => {
    const observation = JSON.parse(
      productJourneyChronicleResponse(
        request(
          "narrative_observation_extract",
          [
            "--- contextId=observation-citation-window:window-001 inputRef=citation-window:window-001 ---",
            JSON.stringify({
              kind: "span",
              text: row("fire-first").marker,
              evidenceRef: "E-1",
            }),
          ].join("\n"),
        ),
      )!,
    );
    expect(observation.observations).toHaveLength(1);
    const synthesis = JSON.parse(
      productJourneyChronicleResponse(
        request(
          "narrative_event_synthesize",
          synthesisSections(["writ-middle"])
            .map(
              (s) =>
                `--- contextId=${s.contextId} inputRef=${s.inputRef} ---\n${s.value}`,
            )
            .join("\n"),
        ),
      )!,
    );
    expect(synthesis.events[0].titleSuggestion).toBe(
      fixture.clusters.writ.title,
    );
  });
});
