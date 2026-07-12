import { describe, expect, it } from "vitest";

import {
  accumulateInputTokenDrift,
  buildInputTokenDriftMetadata,
  createInputTokenDriftTotals,
  normalizeActualInputTokens,
  type InputTokenRouteSnapshot,
} from "./inputTokenDrift";

const route: InputTokenRouteSnapshot = {
  surface: "agent",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiVariant: null,
  requestedEndpointId: null,
  resolvedEndpointId: null,
  toolProtocol: "native",
  contextWindow: 200_000,
};

describe("input token drift telemetry", () => {
  it("adds Anthropic direct cache usage but does not double-add OpenAI-family cache", () => {
    const usage = {
      inputTokens: 50,
      cacheReadTokens: 1_200,
      cacheWriteTokens: 300,
    };
    expect(normalizeActualInputTokens("anthropic", usage)).toBe(1_550);
    expect(normalizeActualInputTokens("openrouter", usage)).toBe(50);
  });

  it("accumulates one estimate and normalized actual value per request", () => {
    const first = accumulateInputTokenDrift(
      createInputTokenDriftTotals(),
      "anthropic",
      {
        estimatedInputTokens: 1_400,
        safetyMarginTokens: 32,
        inputTokens: 50,
        cacheReadTokens: 1_200,
        cacheWriteTokens: 300,
      },
    );
    const totals = accumulateInputTokenDrift(first, "anthropic", {
      estimatedInputTokens: 600,
      safetyMarginTokens: 32,
      inputTokens: 100,
    });

    expect(totals).toEqual({
      estimatedInputTokens: 2_000,
      normalizedActualInputTokens: 1_650,
      safetyMarginTokens: 64,
      cacheReadTokens: 1_200,
      cacheWriteTokens: 300,
      requestCount: 2,
    });
  });

  it("builds a route/project snapshot and actual-minus-estimated delta", () => {
    const totals = accumulateInputTokenDrift(
      createInputTokenDriftTotals(),
      "anthropic",
      {
        estimatedInputTokens: 1_500,
        safetyMarginTokens: 32,
        inputTokens: 50,
        cacheReadTokens: 1_200,
        cacheWriteTokens: 300,
      },
    );

    expect(
      buildInputTokenDriftMetadata({
        scope: "agent-parent",
        projectId: "project-1",
        route,
        estimatorFamily: "o200k_base",
        language: " JA ",
        contextPlanDigest: "ctx-deadbeef",
        totals,
      }),
    ).toEqual({
      inputTokenDrift: {
        scope: "agent-parent",
        provider: "anthropic",
        projectId: "project-1",
        route,
        estimatorFamily: "o200k_base",
        language: "ja",
        safetyMarginTokens: 32,
        contextPlanDigest: "ctx-deadbeef",
        estimatedInputTokens: 1_500,
        normalizedActualInputTokens: 1_550,
        deltaInputTokens: 50,
        cacheReadTokens: 1_200,
        cacheWriteTokens: 300,
        requestCount: 1,
      },
    });
  });
});
