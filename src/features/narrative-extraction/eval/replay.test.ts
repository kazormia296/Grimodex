import { describe, expect, it } from "vitest";
import { validateNarrativeEvalReplayArtifact } from "./replay";

const CORPUS_DIGEST = `sha256:${"1".repeat(64)}`;
const PROMPT_DIGEST = `sha256:${"2".repeat(64)}`;
const RESPONSE_DIGEST = `sha256:${"3".repeat(64)}`;

function validReplay(): unknown {
  return {
    schemaVersion: 1,
    replayId: "replay-chronicle-001",
    caseId: "chronicle.micro.rumor-vs-fact-001",
    capturedAt: "2026-08-10T01:02:03.000Z",
    corpusDigest: CORPUS_DIGEST,
    versions: {
      prompt: "chronicle-observation-prompt/1",
      responseSchema: "chronicle-observation-schema/1",
      extractor: "chronicle-window-extractor/1",
      parser: "chronicle-observation-parser/1",
    },
    promptDigest: PROMPT_DIGEST,
    response: {
      rawText: '{"observations":[]}',
      digest: RESPONSE_DIGEST,
    },
    model: {
      provider: "openrouter",
      requestedModel: "openai/gpt-5.6-luna",
      resolvedModel: "openai/gpt-5.6-luna-20260709",
      reasoningEffort: "medium",
    },
    usage: {
      inputTokens: 320,
      outputTokens: 41,
      runtimeMs: 812,
      costUsd: 0.00123,
    },
  };
}

const expectedContext = {
  caseId: "chronicle.micro.rumor-vs-fact-001",
  corpusDigest: CORPUS_DIGEST,
  versions: {
    prompt: "chronicle-observation-prompt/1",
    responseSchema: "chronicle-observation-schema/1",
    extractor: "chronicle-window-extractor/1",
    parser: "chronicle-observation-parser/1",
  },
};

function diagnosticCodes(
  result: ReturnType<typeof validateNarrativeEvalReplayArtifact>,
) {
  if (result.ok) return [];
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe("validateNarrativeEvalReplayArtifact", () => {
  it("accepts a replay with pinned versions, digests, resolved model metadata, usage, and cost", () => {
    const result = validateNarrativeEvalReplayArtifact(
      validReplay(),
      expectedContext,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      caseId: expectedContext.caseId,
      corpusDigest: CORPUS_DIGEST,
      versions: expectedContext.versions,
      model: {
        provider: "openrouter",
        requestedModel: "openai/gpt-5.6-luna",
        resolvedModel: "openai/gpt-5.6-luna-20260709",
        reasoningEffort: "medium",
      },
      usage: {
        inputTokens: 320,
        outputTokens: 41,
        runtimeMs: 812,
        costUsd: 0.00123,
      },
    });
  });

  it.each([
    [
      "case id",
      { caseId: "chronicle.micro.some-other-case" },
      "REPLAY_CASE_ID_MISMATCH",
    ],
    [
      "corpus digest",
      { corpusDigest: `sha256:${"9".repeat(64)}` },
      "REPLAY_CORPUS_DIGEST_MISMATCH",
    ],
    [
      "prompt version",
      {
        versions: {
          ...expectedContext.versions,
          prompt: "chronicle-observation-prompt/0",
        },
      },
      "REPLAY_PROMPT_VERSION_MISMATCH",
    ],
    [
      "response schema version",
      {
        versions: {
          ...expectedContext.versions,
          responseSchema: "chronicle-observation-schema/0",
        },
      },
      "REPLAY_RESPONSE_SCHEMA_VERSION_MISMATCH",
    ],
    [
      "extractor version",
      {
        versions: {
          ...expectedContext.versions,
          extractor: "chronicle-window-extractor/0",
        },
      },
      "REPLAY_EXTRACTOR_VERSION_MISMATCH",
    ],
    [
      "parser version",
      {
        versions: {
          ...expectedContext.versions,
          parser: "chronicle-observation-parser/0",
        },
      },
      "REPLAY_PARSER_VERSION_MISMATCH",
    ],
  ])("rejects a mismatched %s", (_name, replacement, expectedCode) => {
    const candidate = {
      ...(validReplay() as Record<string, unknown>),
      ...replacement,
    };

    const result = validateNarrativeEvalReplayArtifact(
      candidate,
      expectedContext,
    );

    expect(result.ok).toBe(false);
    expect(diagnosticCodes(result)).toContain(expectedCode);
  });

  it("requires requested and provider-resolved model identities plus reasoning effort", () => {
    const candidate = validReplay() as {
      model: Record<string, unknown>;
    };
    candidate.model = {
      provider: "openrouter",
      requestedModel: "openai/gpt-5.6-luna",
    };

    const result = validateNarrativeEvalReplayArtifact(
      candidate,
      expectedContext,
    );

    expect(result.ok).toBe(false);
    expect(diagnosticCodes(result)).toEqual(
      expect.arrayContaining([
        "REPLAY_RESOLVED_MODEL_REQUIRED",
        "REPLAY_REASONING_EFFORT_REQUIRED",
      ]),
    );
  });

  it("rejects malformed content digests rather than treating labels as integrity evidence", () => {
    const candidate = {
      ...(validReplay() as Record<string, unknown>),
      promptDigest: "latest",
      response: {
        rawText: '{"observations":[]}',
        digest: "not-a-digest",
      },
    };

    const result = validateNarrativeEvalReplayArtifact(
      candidate,
      expectedContext,
    );

    expect(result.ok).toBe(false);
    expect(diagnosticCodes(result)).toEqual(
      expect.arrayContaining([
        "REPLAY_PROMPT_DIGEST_INVALID",
        "REPLAY_RESPONSE_DIGEST_INVALID",
      ]),
    );
  });

  it.each([
    ["apiKey", { request: { apiKey: "disposable-secret-value" } }],
    [
      "authorization",
      { transport: { headers: { authorization: "Bearer secret-value" } } },
    ],
    ["secret", { diagnostics: [{ secret: "secret-value" }] }],
  ])(
    "rejects nested credential field %s without echoing its value",
    (_name, injected) => {
      const candidate = {
        ...(validReplay() as Record<string, unknown>),
        ...injected,
      };

      const result = validateNarrativeEvalReplayArtifact(
        candidate,
        expectedContext,
      );

      expect(result.ok).toBe(false);
      expect(diagnosticCodes(result)).toContain("REPLAY_CREDENTIAL_PRESENT");
      expect(JSON.stringify(result)).not.toContain("secret-value");
      expect(JSON.stringify(result)).not.toContain("disposable-secret-value");
    },
  );

  it("allows token counts while forbidding credential-shaped token fields", () => {
    const allowed = validateNarrativeEvalReplayArtifact(
      validReplay(),
      expectedContext,
    );
    const candidate = {
      ...(validReplay() as Record<string, unknown>),
      transport: { bearerToken: "secret-value" },
    };
    const forbidden = validateNarrativeEvalReplayArtifact(
      candidate,
      expectedContext,
    );

    expect(allowed.ok).toBe(true);
    expect(forbidden.ok).toBe(false);
    expect(diagnosticCodes(forbidden)).toContain("REPLAY_CREDENTIAL_PRESENT");
    expect(JSON.stringify(forbidden)).not.toContain("secret-value");
  });
});
