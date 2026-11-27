import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createMastraMemoryConfiguration,
  resolveMemoryModel,
} from "./memoryConfiguration.js";
import type { NapiMemoryBackendLike } from "./napiMemoryBackend.js";

const backend = {
  memoryEmbedTexts: vi.fn(async () => JSON.stringify({ embeddings: [[0.1]] })),
} as unknown as NapiMemoryBackendLike;

describe("Mastra memory configuration", () => {
  it("resolves empty memoryModel to the primary object and rejects string ids", () => {
    const primary = { modelId: "primary" };
    expect(resolveMemoryModel(primary, "")).toBe(primary);
    expect(resolveMemoryModel(primary, { modelId: "memory" })).toEqual({
      modelId: "memory",
    });
    if (false) {
      // @ts-expect-error model ids are rejected by the typed API.
      resolveMemoryModel(primary, "provider/model");
    }
    expect(() => resolveMemoryModel(primary, "provider/model" as never)).toThrow(
      "Mastra memory model must be a model object",
    );
  });

  it("does not build configuration while the M gate is closed", () => {
    expect(
      createMastraMemoryConfiguration({
        enabled: false,
        primaryModel: {},
        backend,
        language: "ja",
        storage: {} as never,
        vector: false,
      }),
    ).toBeNull();
  });

  it("sets every requested option explicitly and embeds through the Native object", async () => {
    const config = createMastraMemoryConfiguration({
      enabled: true,
      primaryModel: { modelId: "primary" },
      memoryModel: "",
      backend,
      language: "ja",
      storage: {} as never,
      vector: false,
    });
    expect(config).not.toBeNull();
    const options = config!.options as unknown as Record<string, unknown>;
    expect(options.observationalMemory).toMatchObject({
      model: { modelId: "primary" },
      retrieval: false,
      observation: {
        bufferTokens: false,
        bufferOnIdle: false,
        observeAttachments: false,
      },
    });
    expect(options.semanticRecall).toMatchObject({ scope: "thread" });
    expect(options.workingMemory).toMatchObject({
      enabled: true,
      scope: "resource",
      agentManaged: false,
      template: expect.stringMatching(/Preferences and writing style/),
    });
    await (
      config!.embedder as unknown as {
        doEmbed(input: { values: string[] }): PromiseLike<unknown>;
      }
    ).doEmbed({ values: ["本文"] });
    expect(backend.memoryEmbedTexts).toHaveBeenCalledWith("ja", ["本文"]);
  });

  it("pins the Mastra dist contract for the untyped bufferOnIdle option", () => {
    const distPath = path.resolve(
      process.cwd(),
      "node_modules/@mastra/memory/dist/src-BkElV36S.js",
    );
    expect(readFileSync(distPath, "utf8")).toContain(
      "config.observation?.bufferOnIdle ?? false",
    );
  });
});
