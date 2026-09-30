import { describe, expect, it } from "vitest";
import { productJourneyChronicleResponse } from "./productJourneyChronicleAi.js";

const sentences = [
  "衛兵が門を開けた。",
  "旅人は、衛兵が門を開けたという噂を聞いた。",
  "衛兵は門を開けるつもりだった。",
  "衛兵は門を開ける夢を見た。",
  "船頭が鐘を鳴らした。",
];
const actualities = ["actual", "rumored", "planned", "dreamed", "actual"];
function request(pathId: string, context: string) {
  return {
    messages: [
      {
        role: "user",
        content: [
          "Ignore this template: Eold-001; cluster-old; localId=old-observation",
          "# Context Set (chronicle.prompt/1)",
          context,
          "",
          "# Output (JSON only)",
          '{"evidenceRefs":["Etemplate-001"],"clusterRef":"cluster-template"}',
        ].join("\n"),
      },
    ],
    auditContext: { pathId, executionId: "audit-execution" },
  };
}
function observationRequest(binding: string) {
  return request(
    "narrative_observation_extract",
    [
      "--- contextId=observation-citation-window:window-1 inputRef=citation-window:window-1 ---",
      ...sentences.map((text, index) =>
        JSON.stringify({
          kind: "evidence",
          text,
          evidenceRef: `E${binding}-${index + 1}`,
        }),
      ),
    ].join("\n"),
  );
}
function synthesisRequest(binding: string, indices = [0, 1, 2, 3]) {
  return request(
    "narrative_event_synthesize",
    [
      `--- contextId=event-cluster:cluster-${binding} inputRef=cluster:cluster-${binding} ---\ncluster-${binding}`,
      ...indices.map((index) =>
        [
          `--- contextId=event-observation:${binding}:opaque-${index} inputRef=observation:${binding}:opaque-${index} ---`,
          `- localId=${binding}:opaque-${index}; actuality=${actualities[index]}; predicate=${index === 4 ? "鐘を鳴らす" : "門を開ける"}; evidence=S1:${sentences[index]}`,
        ].join("\n"),
      ),
    ].join("\n\n"),
  );
}
function parsed(value: unknown) {
  const response = productJourneyChronicleResponse(value);
  expect(response).not.toBeNull();
  return JSON.parse(response!);
}

describe("request-bound Chronicle Journey response", () => {
  it("keeps five fixed semantic claims while copying only current citation aliases", () => {
    for (const binding of ["first", "second"]) {
      const input = observationRequest(binding);
      const before = JSON.stringify(input);
      const result = parsed(input);
      expect(result.observations).toHaveLength(5);
      expect(
        result.observations.map(
          (row: { payload: { actuality: string } }) => row.payload.actuality,
        ),
      ).toEqual(["actual", "rumored", "planned", "dreamed", "actual"]);
      expect(
        result.observations.map(
          (row: { evidenceRefs: string[] }) => row.evidenceRefs,
        ),
      ).toEqual(sentences.map((_, index) => [`E${binding}-${index + 1}`]));
      expect(result.observations[3].assertion.narrativeFrame).toBe("dream");
      expect(JSON.stringify(result)).not.toContain("template");
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("deliberately returns three wrong actual hypotheses and one valid actual subset in the mixed cluster", () => {
    for (const binding of ["first", "second"]) {
      const result = parsed(synthesisRequest(binding));
      expect(result.clusterRef).toBe(`cluster-${binding}`);
      expect(result.resolution).toBe("multiple-events");
      expect(
        result.events.map((event: { actuality: string }) => event.actuality),
      ).toEqual(["actual", "actual", "actual", "actual"]);
      expect(
        result.events.map(
          (event: { observationRefs: string[] }) => event.observationRefs,
        ),
      ).toEqual([0, 1, 2, 3].map((index) => [`${binding}:opaque-${index}`]));
      expect(
        result.events.map(
          (event: { titleSuggestion: string }) => event.titleSuggestion,
        ),
      ).toEqual([
        "門が開いた",
        "噂に含まれる開門",
        "計画に含まれる開門",
        "夢に含まれる開門",
      ]);
    }
  });

  it("retains the independent actual cluster with its own current identifiers", () => {
    expect(parsed(synthesisRequest("independent", [4]))).toMatchObject({
      clusterRef: "cluster-independent",
      resolution: "single-event",
      events: [
        {
          observationRefs: ["independent:opaque-4"],
          actuality: "actual",
          titleSuggestion: "鐘が鳴った",
        },
      ],
    });
  });

  it("rejects missing or ambiguous fixture evidence instead of inventing a citation", () => {
    const input = observationRequest("current");
    input.messages[0]!.content = input.messages[0]!.content.replace(
      sentences[1]!,
      "別の文。",
    );
    expect(() => parsed(input)).toThrow(
      "evidence segment unavailable or ambiguous",
    );
    const duplicate = observationRequest("current");
    duplicate.messages[0]!.content = duplicate.messages[0]!.content.replace(
      "\n# Output",
      `\n${JSON.stringify({ kind: "evidence", text: sentences[0], evidenceRef: "Eduplicate" })}\n# Output`,
    );
    expect(() => parsed(duplicate)).toThrow(
      "evidence segment unavailable or ambiguous",
    );
  });

  it("rejects incomplete mixed membership and mismatched context coordinates", () => {
    expect(() => parsed(synthesisRequest("subset", [0]))).toThrow(
      "cluster membership changed",
    );
    const input = synthesisRequest("current");
    input.messages[0]!.content = input.messages[0]!.content.replace(
      "inputRef=observation:current:opaque-0",
      "inputRef=observation:foreign:opaque-0",
    );
    expect(() => parsed(input)).toThrow("Observation coordinates disagree");
  });

  it("preserves unrelated nonstream fake responses and makes unexpected repair explicit", () => {
    expect(productJourneyChronicleResponse(undefined)).toBeNull();
    expect(productJourneyChronicleResponse({ messages: [] })).toBeNull();
    expect(
      productJourneyChronicleResponse({ auditContext: { pathId: "chat" } }),
    ).toBeNull();
    expect(() =>
      productJourneyChronicleResponse({
        auditContext: { pathId: "narrative_structured_repair" },
      }),
    ).toThrow("unexpectedly entered repair");
  });
});
