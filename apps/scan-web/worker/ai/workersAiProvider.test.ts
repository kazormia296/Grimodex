import { describe, expect, it, vi } from "vitest";
import {
  createWorkersAiProvider,
  type WorkersAiBindingLike,
} from "./workersAiProvider";

const input = {
  chunkId: "chunk:test",
  sourceFingerprint: "sha256:test",
  text: "葵は灯台へ向かった。",
  sectionIds: ["section:test"],
  paragraphIds: ["paragraph:test"],
};

const output = JSON.stringify({
  schemaVersion: "grimodex-scan/chunk-extraction/1",
  chunkId: "chunk:test",
  sourceFingerprint: "sha256:test",
  entities: [
    {
      type: "character",
      name: "葵",
      aliases: [],
      evidence: [{ sectionId: "section:test", paragraphId: "paragraph:test" }],
      confidence: 0.9,
    },
  ],
  relations: [],
  events: [],
});

function provider(binding: WorkersAiBindingLike) {
  return createWorkersAiProvider(binding, {
    provider: "workers-ai",
    model: "@cf/test/model",
    maxInputCharacters: 1000,
    maxOutputCharacters: 1000,
    allowFallback: false,
  });
}

describe("Workers AI structured provider", () => {
  it("validates chunk output and binds it to the requested chunk", async () => {
    const binding = { run: vi.fn(async () => ({ response: output })) };
    await expect(provider(binding).extractChunk(input)).resolves.toMatchObject({
      chunkId: "chunk:test",
    });
    expect(binding.run).toHaveBeenCalledOnce();
  });

  it("allows exactly one repair attempt for malformed JSON", async () => {
    const binding = {
      run: vi
        .fn<WorkersAiBindingLike["run"]>()
        .mockResolvedValueOnce({ response: "not-json" })
        .mockResolvedValueOnce({ response: output }),
    };
    await expect(provider(binding).extractChunk(input)).resolves.toMatchObject({
      chunkId: "chunk:test",
    });
    expect(binding.run).toHaveBeenCalledTimes(2);
    expect(binding.run.mock.calls[1]?.[1].messages[1]?.content).toContain(
      "not-json",
    );
  });

  it("classifies rate limits and timeouts as retryable provider errors", async () => {
    const rateLimited = { status: 429 };
    await expect(
      provider({
        run: vi.fn(async () => {
          throw rateLimited;
        }),
      }).extractChunk(input),
    ).rejects.toMatchObject({ code: "rate-limited", retryable: true });
    const timeout = { name: "AbortError" };
    await expect(
      provider({
        run: vi.fn(async () => {
          throw timeout;
        }),
      }).extractChunk(input),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("validates frontier adjudication output against the ambiguity id", async () => {
    const binding = {
      run: vi.fn(async () => ({
        response: JSON.stringify({
          schemaVersion: "grimodex-scan/adjudication/1",
          ambiguityId: "ambiguity:test",
          decision: "uncertain",
          rationale: "evidence is insufficient",
        }),
      })),
    };
    await expect(
      provider(binding).adjudicate({
        sourceFingerprint: "sha256:test",
        ambiguityId: "ambiguity:test",
        candidateSummary: "character:葵 / character:アオイ",
        evidenceParagraphs: [
          { paragraphId: "paragraph:test", text: "葵は灯台へ向かった。" },
        ],
      }),
    ).resolves.toMatchObject({
      decision: "uncertain",
      ambiguityId: "ambiguity:test",
    });
  });
});
