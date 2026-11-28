import type { Memory } from "@mastra/memory";

import type { NapiMemoryBackendLike } from "./napiMemoryBackend.js";

// dist/src-BkElV36S.js reads config.observation?.bufferOnIdle ?? false; the public type omits it.
type ExplicitMemoryOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof Memory>[0]>["options"]
> & {
  observationalMemory: object & {
    observation: object & { bufferOnIdle: false };
  };
};

export interface MemoryConfigurationInput {
  readonly enabled: boolean;
  readonly primaryModel: object;
  readonly memoryModel?: object | "" | null;
  readonly backend: NapiMemoryBackendLike;
  readonly language: string;
  readonly storage: NonNullable<ConstructorParameters<typeof Memory>[0]>["storage"];
  readonly vector: NonNullable<ConstructorParameters<typeof Memory>[0]>["vector"];
}

export function resolveMemoryModel(
  primaryModel: object,
  memoryModel?: object | "" | null,
): object;
export function resolveMemoryModel(
  primaryModel: unknown,
  memoryModel?: unknown,
): object {
  const resolved = memoryModel === "" || memoryModel == null ? primaryModel : memoryModel;
  if (typeof resolved !== "object" || resolved === null) {
    throw new TypeError("Mastra memory model must be a model object");
  }
  return resolved;
}

export function createMastraMemoryConfiguration(
  input: MemoryConfigurationInput,
): NonNullable<ConstructorParameters<typeof Memory>[0]> | null {
  if (!input.enabled) return null;
  const embedder = {
    specificationVersion: "v2" as const,
    provider: "grimodex",
    modelId: `grimodex-local-memory-${input.language}`,
    maxEmbeddingsPerCall: 64,
    supportsParallelCalls: false,
    async doEmbed({ values }: { values: string[] }) {
      const result = JSON.parse(
        await input.backend.memoryEmbedTexts(input.language, values),
      ) as { embeddings: number[][] };
      return { embeddings: result.embeddings };
    },
  };
  const options: ExplicitMemoryOptions = {
    observationalMemory: {
      model: resolveMemoryModel(input.primaryModel, input.memoryModel),
      retrieval: false,
      observation: {
        bufferTokens: false,
        observeAttachments: false,
        bufferOnIdle: false,
      },
    },
    semanticRecall: { scope: "thread" },
    workingMemory: {
      enabled: true,
      scope: "resource",
      agentManaged: false,
      template: "# Preferences and writing style\n- Preferences:\n- Writing style:",
    },
  } as ExplicitMemoryOptions;
  return { storage: input.storage, vector: input.vector, options, embedder };
}
