import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildChroniclePromptRequest,
  CHRONICLE_PROMPT_CACHE_MIN_PREFIX_CHARS,
  supportsChroniclePromptCache,
} from "./chroniclePromptCache";
import {
  buildSynthesisPromptArtifact,
  runEventSynthesisTask,
} from "./runEventSynthesisTask";
import { runObservationExtractionTask } from "./runObservationExtractionTask";
import { runStructuredRepairTask } from "./runStructuredRepairTask";
import {
  buildChroniclePromptArtifact,
  splitChroniclePromptForCache,
} from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import { NARRATIVE_STAGE_IDS } from "@/features/narrative-extraction/reconciler/stageExecution";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";

const sendMock = vi.hoisted(() => vi.fn());
const overrideMock = vi.hoisted(() =>
  vi.fn(() => ({
    apiVariant: null as string | null,
    model: null as string | null,
    provider: null as string | null,
    endpointId: null as string | null,
  })),
);

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: sendMock,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: overrideMock,
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "project-test" }) },
}));

function observation(
  localId: string,
  quote: string,
): RawChronicleEventObservation {
  return {
    localId,
    evidence: [{ sourceRef: "S0001", quote }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate: "門が開いた",
      actuality: "actual",
      participants: [],
      temporalExpressions: [],
      durationKind: "instant",
    },
  };
}

type SentCall = {
  readonly messages: { role: string; content: string }[];
  readonly systemCacheSegments: string[] | undefined;
};

function sentCalls(): SentCall[] {
  return sendMock.mock.calls.map((call) => ({
    messages: call[0] as SentCall["messages"],
    systemCacheSegments: call[3] as SentCall["systemCacheSegments"],
  }));
}

/** What the model reads, in order: system segments, then the user message. */
function modelVisibleText(call: SentCall): string {
  return call.messages.map((message) => message.content).join("");
}

const ANTHROPIC = {
  apiVariant: null,
  model: "claude-sonnet-5-5",
  provider: "anthropic",
  endpointId: null,
};

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ text: "{}", inputTokens: 1, outputTokens: 1 });
  overrideMock.mockReset();
});

describe("splitChroniclePromptForCache", () => {
  it("splits without changing a single character of the prompt", () => {
    const artifact = buildSynthesisPromptArtifact({
      clusterRef: "cluster-1",
      observations: [observation("obs-1", "門が開いた。")],
    });
    const split = splitChroniclePromptForCache(artifact)!;
    expect(split.staticPrefix + split.dynamicRest).toBe(
      artifact.messages[0].content,
    );
    expect(split.staticPrefix).toBe(
      `${artifact.componentContract.instruction}\n\n# Context Set (chronicle.prompt/1)\n`,
    );
  });

  it("keeps Context Set values out of the static prefix", () => {
    const first = splitChroniclePromptForCache(
      buildSynthesisPromptArtifact({
        clusterRef: "cluster-A",
        observations: [observation("obs-1", "門が開いた。")],
      }),
    )!;
    const second = splitChroniclePromptForCache(
      buildSynthesisPromptArtifact({
        clusterRef: "cluster-B",
        observations: [
          observation("obs-7", "別の場面の引用。"),
          observation("obs-8", "もう一つ。"),
        ],
      }),
    )!;
    expect(second.staticPrefix).toBe(first.staticPrefix);
    expect(first.staticPrefix).not.toContain("cluster-A");
    expect(first.staticPrefix).not.toContain("obs-1");
    expect(first.staticPrefix).not.toContain("門が開いた。");
    expect(first.dynamicRest).toContain("cluster-A");
    expect(first.dynamicRest).toContain("# Output (JSON only)");
  });

  it("fails closed when the content does not have the builder shape", () => {
    const artifact = buildSynthesisPromptArtifact({
      clusterRef: "cluster-1",
      observations: [observation("obs-1", "門が開いた。")],
    });
    expect(
      splitChroniclePromptForCache({
        ...artifact,
        messages: [{ role: "user", content: "free-form prompt" }],
      }),
    ).toBeNull();
  });
});

describe("supportsChroniclePromptCache", () => {
  it("follows grimodex-ai supports_prompt_cache", () => {
    const route = (provider: string, model: string, apiVariant = null) => ({
      provider,
      model,
      apiVariant: apiVariant as string | null,
    });
    expect(supportsChroniclePromptCache(route("anthropic", "x"))).toBe(true);
    expect(
      supportsChroniclePromptCache(route("openrouter", "anthropic/claude-x")),
    ).toBe(true);
    expect(
      supportsChroniclePromptCache(route("openrouter", "openai/gpt-5")),
    ).toBe(false);
    expect(supportsChroniclePromptCache(route("openai", "claude-like"))).toBe(
      false,
    );
    expect(
      supportsChroniclePromptCache(route("openai-compatible", "claude-x")),
    ).toBe(false);
    expect(
      supportsChroniclePromptCache({
        provider: "openrouter",
        model: null,
        apiVariant: null,
      }),
    ).toBe(false);
    // The Responses API ignores cache segments; splitting would only change roles.
    expect(
      supportsChroniclePromptCache(
        route("openrouter", "anthropic/claude-x", "responses" as never),
      ),
    ).toBe(false);
  });
});

describe("buildChroniclePromptRequest", () => {
  const artifact = buildSynthesisPromptArtifact({
    clusterRef: "cluster-1",
    observations: [observation("obs-1", "門が開いた。")],
  });
  const anthropic = {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    apiVariant: null,
  };

  it("sends the original single user message when the route cannot cache", () => {
    for (const route of [
      null,
      { provider: "openai", model: "gpt-5", apiVariant: null },
      { provider: "openrouter", model: "openai/gpt-5", apiVariant: null },
    ]) {
      const request = buildChroniclePromptRequest(artifact, route);
      expect(request.messages).toEqual([
        { role: "user", content: artifact.messages[0].content },
      ]);
      expect(request.systemCacheSegments).toBeUndefined();
    }
  });

  it("moves only the static prefix into a cache segment for Anthropic", () => {
    const request = buildChroniclePromptRequest(artifact, anthropic);
    const split = splitChroniclePromptForCache(artifact)!;
    expect(request.systemCacheSegments).toEqual([split.staticPrefix]);
    expect(request.messages).toEqual([
      { role: "system", content: split.staticPrefix },
      { role: "user", content: split.dynamicRest },
    ]);
  });

  it("does not split a prefix too short to ever be cached", () => {
    const short = buildChroniclePromptArtifact({
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      componentContract: {
        contractId: "test.short",
        contractVersion: "1",
        instruction: "短い指示",
        outputShape: "{}",
      },
      contextSet: [],
      modelInputs: [],
    });
    expect(
      splitChroniclePromptForCache(short)!.staticPrefix.length,
    ).toBeLessThan(CHRONICLE_PROMPT_CACHE_MIN_PREFIX_CHARS);
    const request = buildChroniclePromptRequest(short, anthropic);
    expect(request.systemCacheSegments).toBeUndefined();
    expect(request.messages).toEqual([
      { role: "user", content: short.messages[0].content },
    ]);
  });
});

describe("Chronicle stage requests", () => {
  const observations = [
    observation("obs-1", "門が開いた。"),
    observation("obs-2", "兵が走った。"),
  ];

  async function runSynthesis(
    clusterRef: string,
    override: typeof ANTHROPIC | Record<string, string | null>,
  ) {
    overrideMock.mockReturnValue(override as never);
    await runEventSynthesisTask({
      clusterRef,
      observations,
      projectId: "project-test",
      repairOnFailure: false,
    });
  }

  it("event synthesis: Anthropic gets one identical cache segment per call", async () => {
    await runSynthesis("cluster-A", ANTHROPIC);
    await runSynthesis("cluster-B", ANTHROPIC);
    const [a, b] = sentCalls();
    expect(a!.systemCacheSegments).toHaveLength(1);
    expect(a!.systemCacheSegments).toEqual(b!.systemCacheSegments);
    const segment = a!.systemCacheSegments![0]!;
    expect(segment.length).toBeGreaterThanOrEqual(
      CHRONICLE_PROMPT_CACHE_MIN_PREFIX_CHARS,
    );
    for (const volatile of ["cluster-A", "obs-1", "門が開いた。", "S0001"]) {
      expect(segment).not.toContain(volatile);
    }
    // The segment is the system message; the volatile rest is the user message.
    expect(a!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(a!.messages[0]!.content).toBe(segment);
    expect(a!.messages[1]!.content).toContain("cluster-A");
    expect(b!.messages[1]!.content).toContain("cluster-B");
    expect(a!.messages[1]!.content).not.toBe(b!.messages[1]!.content);
  });

  it("event synthesis: the model-visible text equals the unsplit prompt", async () => {
    await runSynthesis("cluster-A", ANTHROPIC);
    await runSynthesis("cluster-A", {
      apiVariant: null,
      model: "openai/gpt-5",
      provider: "openrouter",
      endpointId: null,
    });
    const [cached, unsplit] = sentCalls();
    const expected = buildSynthesisPromptArtifact({
      clusterRef: "cluster-A",
      observations,
    }).messages[0].content;
    expect(modelVisibleText(cached!)).toBe(expected);
    expect(unsplit!.messages).toEqual([{ role: "user", content: expected }]);
  });

  it("event synthesis: OpenRouter Claude caches, OpenRouter non-Claude and others do not", async () => {
    await runSynthesis("cluster-A", {
      apiVariant: null,
      model: "anthropic/claude-sonnet-5-5",
      provider: "openrouter",
      endpointId: null,
    });
    await runSynthesis("cluster-A", {
      apiVariant: null,
      model: "openai/gpt-5",
      provider: "openrouter",
      endpointId: null,
    });
    await runSynthesis("cluster-A", {
      apiVariant: null,
      model: "gpt-5",
      provider: "openai",
      endpointId: null,
    });
    await runSynthesis("cluster-A", {
      apiVariant: "responses",
      model: "anthropic/claude-sonnet-5-5",
      provider: "openrouter",
      endpointId: null,
    });
    const calls = sentCalls();
    expect(calls[0]!.systemCacheSegments).toHaveLength(1);
    for (const call of calls.slice(1)) {
      expect(call.systemCacheSegments).toBeUndefined();
      expect(call.messages.map((m) => m.role)).toEqual(["user"]);
    }
  });

  it("observation extraction: the cache segment is the same across windows", async () => {
    overrideMock.mockReturnValue(ANTHROPIC as never);
    for (const text of ["第一の本文。", "まったく別の本文。"]) {
      await runObservationExtractionTask({
        windows: [{ sourceRef: "S0001", text }],
        projectId: "project-test",
        repairOnFailure: false,
      });
    }
    const [first, second] = sentCalls();
    expect(first!.systemCacheSegments).toHaveLength(1);
    expect(first!.systemCacheSegments).toEqual(second!.systemCacheSegments);
    expect(first!.systemCacheSegments![0]).not.toContain("第一の本文。");
    expect(first!.messages[1]!.content).toContain("第一の本文。");
    expect(second!.messages[1]!.content).toContain("まったく別の本文。");
  });

  it("structured repair: never puts broken text into a cache segment", async () => {
    overrideMock.mockReturnValue(ANTHROPIC as never);
    await runStructuredRepairTask({
      brokenText: "壊れた出力 BROKEN-MARKER",
      expectedShape: '{"observations":[]}',
      projectId: "project-test",
      responseValidator: () => "invalid",
    });
    const [call] = sentCalls();
    expect(call).toBeDefined();
    expect(call!.systemCacheSegments?.join("") ?? "").not.toContain(
      "BROKEN-MARKER",
    );
    expect(modelVisibleText(call!)).toContain("BROKEN-MARKER");
  });
});
