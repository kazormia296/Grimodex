import { describe, expect, it } from "vitest";
import { productionRuntime } from "./production-runtime";
import {
  LIVE_CONFIG,
  createOfflineBudget,
  createOpenRouterTransport,
  loadSourceOnlyContext,
  runOfflineNorthGate,
} from "./live-driver.mjs";

const FAKE_API_KEY = "sk-test-north-gate_123";
const SOURCE_QUOTE_A = "夜半、北門の鎖が切れ、重い門扉が街路へ倒れた。";
const SOURCE_QUOTE_B = "衛兵は鐘を鳴らし、通行人を広場へ退避させた。";
const FORBIDDEN_EXTRACTION_TOKENS = [
  "chain-break",
  "gate-fall",
  "guards-ring-bell",
  "guards-evacuate-passersby",
  "night-half-chain-break",
  "night-half-gate-fall",
  "chronicle.v2.actual-gate-collapse-001",
  "C01",
  "C02",
  "C03",
  "C04",
  "C05",
  "C06",
  "C07",
  "C08",
  "C09",
  "C10",
  "C11",
  "C12",
] as const;

type NorthGateFailure = "parse" | "transport" | undefined;
type JudgeInput = {
  actualClaims: Array<{ ref: string }>;
  goldClaims: Array<{ ref: string }>;
  temporalRelations: Array<{ ref: string }>;
};

function bodyFrom(init: RequestInit | undefined): {
  readonly body: string;
  readonly messages: Array<{ role?: string; content?: string }>;
} {
  if (typeof init?.body !== "string") throw new Error("missing provider body");
  const body = JSON.parse(init.body) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  if (!body.messages) throw new Error("missing provider messages");
  return { body: init.body, messages: body.messages };
}

function citationAliases(prompt: string): readonly [string, string] {
  const aliases = [
    ...new Set(
      [...prompt.matchAll(/evidenceRef":"(E[^<"]+-\d{3})"/g)].map(
        (match) => match[1]!,
      ),
    ),
  ];
  if (aliases.length !== 2) {
    throw new Error(`expected two bound citation aliases, got ${aliases.length}`);
  }
  return [aliases[0]!, aliases[1]!];
}

function observationResponse(prompt: string): string {
  const [firstAlias, secondAlias] = citationAliases(prompt);
  return JSON.stringify({
    observations: [
      {
        localId: "north-chain",
        evidenceRefs: [firstAlias],
        assertion: { attribution: "narrator", narrativeFrame: "story-world" },
        payload: {
          predicate: "鎖が切れた",
          actuality: "actual",
          participants: [{ surface: "北門の鎖", role: "主題" }],
          temporalExpressions: ["夜半"],
          durationKind: "instant",
        },
      },
      {
        localId: "north-gate",
        evidenceRefs: [firstAlias],
        assertion: { attribution: "narrator", narrativeFrame: "story-world" },
        payload: {
          predicate: "門扉が倒れた",
          actuality: "actual",
          participants: [
            { surface: "重い門扉", role: "主題" },
            { surface: "街路", role: "移動先" },
          ],
          temporalExpressions: ["夜半"],
          durationKind: "instant",
        },
      },
      {
        localId: "north-bell",
        evidenceRefs: [secondAlias],
        assertion: { attribution: "narrator", narrativeFrame: "story-world" },
        payload: {
          predicate: "鐘を鳴らした",
          actuality: "actual",
          participants: [
            { surface: "衛兵", role: "行為者" },
            { surface: "鐘", role: "対象" },
          ],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
      {
        localId: "north-evacuation",
        evidenceRefs: [secondAlias],
        assertion: { attribution: "narrator", narrativeFrame: "story-world" },
        payload: {
          predicate: "退避させた",
          actuality: "actual",
          participants: [
            { surface: "衛兵", role: "行為者" },
            { surface: "通行人", role: "対象" },
            { surface: "広場", role: "移動先" },
          ],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
    ],
  });
}

function synthesisResponse(prompt: string): string {
  const clusterRef = prompt.match(/contextId=event-cluster:([^\s]+)/)?.[1];
  const observationRefs = [
    ...prompt.matchAll(/contextId=event-observation:([^\s]+)/g),
  ].map((match) => match[1]!);
  if (!clusterRef || observationRefs.length !== 1) {
    throw new Error("unexpected synthesis context");
  }
  return JSON.stringify({
    clusterRef,
    resolution: "single-event",
    events: [
      {
        observationRefs,
        titleSuggestion: "北門の出来事",
        summary: "北門で確認された出来事",
        actuality: "actual",
        significance: "major",
      },
    ],
  });
}

function judgeResponse(prompt: string): string {
  const userMessage = prompt;
  const inputMatch = userMessage.match(/\"input\":(\{.*\})\}$/s);
  if (!inputMatch) throw new Error("missing opaque judge input");
  const input = JSON.parse(inputMatch[1]!) as JudgeInput;
  return JSON.stringify({
    schemaVersion: 1,
    judgeVersion: "chronicle-llm-judge-offline/1",
    primaryAssignments: input.actualClaims.map((actual, index) => ({
      actualRef: actual.ref,
      goldRef: input.goldClaims[index]!.ref,
      axes: {
        predicate: "match",
        participants: "match",
        roles: "match",
        actuality: "match",
        attribution: "match",
        narrativeFrame: "match",
        sourceSupport: "match",
      },
    })),
    unmatchedActuals: [],
    unmatchedGolds: [],
    temporalRelations: input.temporalRelations.map((relation, index) => ({
      relationRef: relation.ref,
      actualRef: input.actualClaims[index]!.ref,
      status: "match",
    })),
  });
}

async function runNorthGateWithFakeProvider(options: {
  readonly failure?: NorthGateFailure;
  readonly failureAt?: number;
}) {
  const context = await loadSourceOnlyContext(productionRuntime, {
    requestIdentity: "chronicle-llm-judge-live-north-gate-test",
  });
  const budget = createOfflineBudget();
  const calls: Array<{
    readonly stage: "observation" | "synthesis" | "judge";
    readonly body: string;
  }> = [];
  let callIndex = 0;
  const fetchImpl = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    callIndex += 1;
    const request = bodyFrom(init);
    const stage =
      callIndex === 1
        ? "observation"
        : callIndex <= 5
          ? "synthesis"
          : "judge";
    calls.push({ stage, body: request.body });
    if (stage !== "judge") {
      for (const token of FORBIDDEN_EXTRACTION_TOKENS) {
        if (request.body.includes(token)) {
          throw new Error(`Gold leaked into ${stage} request: ${token}`);
        }
      }
    }
    if (options.failureAt === callIndex && options.failure === "transport") {
      return new Response("provider unavailable", { status: 503 });
    }
    if (options.failureAt === callIndex && options.failure === "parse") {
      return new Response(
        JSON.stringify({
          model: LIVE_CONFIG.model,
          choices: [
            { message: { content: "not-json" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const prompt = request.messages[0]?.content;
    if (!prompt) throw new Error("missing stage prompt");
    const text =
      stage === "observation"
        ? observationResponse(prompt)
        : stage === "synthesis"
          ? synthesisResponse(prompt)
          : judgeResponse(request.messages[1]?.content ?? "");
    return new Response(
      JSON.stringify({
        model: LIVE_CONFIG.model,
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const transport = createOpenRouterTransport({
    apiKey: FAKE_API_KEY,
    budget,
    fetchImpl,
  });
  try {
    const result = await runOfflineNorthGate({
      runtime: productionRuntime,
      context,
      transport,
      budget,
    });
    return { budget, calls, context, result, error: null };
  } catch (error) {
    return { budget, calls, context, result: null, error };
  }
}

describe("live north gate driver", () => {
  it("runs production observation, synthesis, exact raw replay, parity, and judge", async () => {
    const run = await runNorthGateWithFakeProvider({});

    expect(run.error).toBeNull();
    if (!run.result) throw new Error("expected north-gate success");
    expect(run.context.evalCase.expected.observations).toEqual({
      required: [],
      forbidden: [],
    });
    expect(run.calls.map((call) => call.stage)).toEqual([
      "observation",
      "synthesis",
      "synthesis",
      "synthesis",
      "synthesis",
      "judge",
    ]);
    expect(run.calls).toHaveLength(6);
    expect(run.result.liveArtifacts.observations).toHaveLength(4);
    expect(run.result.replayRun.input.actualClaims).toHaveLength(4);
    expect(run.result.liveArtifacts.parseFailureCount).toBe(0);
    expect(run.result.liveArtifacts.unresolvedEvidenceCount).toBe(0);
    expect(run.result.serialized).toContain('"semanticStatus":"PASS"');
    expect(run.budget.northGateOpened).toBe(true);
    expect(run.budget.budget.extractionSynthesisCount).toBe(5);
    expect(run.budget.budget.judgeCount).toBe(1);
    expect(run.budget.dispatches).toHaveLength(6);
    expect(run.budget.dispatches.every((dispatch) => dispatch.status === "completed")).toBe(true);
    expect(run.budget.terminalState).toBe("judge-completed");
    expect(run.calls[0]!.body).toContain(SOURCE_QUOTE_A);
    expect(run.calls[0]!.body).toContain(SOURCE_QUOTE_B);
  }, 120_000);

  it("stops immediately on malformed observation output with no synthesis or judge POST", async () => {
    const run = await runNorthGateWithFakeProvider({
      failure: "parse",
      failureAt: 1,
    });

    expect(run.error).toMatchObject({
      code: "NEX_CHRONICLE_CITATION_ID_RESPONSE_INVALID",
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.stage).toBe("observation");
    expect(run.budget.dispatches).toHaveLength(1);
    expect(run.budget.dispatches[0]).toMatchObject({
      stage: "observation",
      status: "completed",
    });
    expect(run.budget.budget.extractionSynthesisCount).toBe(1);
    expect(run.budget.budget.judgeCount).toBe(0);
    expect(run.budget.terminalState).toBe("failed");
  }, 120_000);

  it("stops after a synthesis transport failure with no later synthesis or judge POST", async () => {
    const run = await runNorthGateWithFakeProvider({
      failure: "transport",
      failureAt: 2,
    });

    expect(run.error).toMatchObject({
      code: "transport-failure",
      stage: "synthesis",
    });
    expect(run.calls).toHaveLength(2);
    expect(run.calls.map((call) => call.stage)).toEqual([
      "observation",
      "synthesis",
    ]);
    expect(run.budget.dispatches).toHaveLength(2);
    expect(run.budget.dispatches[0]).toMatchObject({
      stage: "observation",
      status: "completed",
    });
    expect(run.budget.dispatches[1]).toMatchObject({
      stage: "synthesis",
      status: "failed",
      terminalCode: "transport-failure",
    });
    expect(run.budget.budget.judgeCount).toBe(0);
    expect(run.budget.terminalState).toBe("failed");
  }, 120_000);
});
