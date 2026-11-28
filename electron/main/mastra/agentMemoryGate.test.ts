import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
}));

vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    constructor(config: Record<string, unknown>) {
      mocks.configs.push(config);
    }
    __setLogger() {}
    async listTools() {
      return {};
    }
    async generate() {}
  },
}));

import { MastraCompositeStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";
import type {
  NapiMemoryBackendLike,
  NapiMemoryVectorBackendLike,
} from "./napiMemoryBackend.js";
import { NativeMemoryStorage } from "./nativeMemoryStorage.js";
import {
  createMastraAgentRuntime,
  type MastraAgentTurnInput,
} from "./agentRuntime.js";
import { NativeMemoryVector } from "./nativeMemoryVector.js";

const ROUTE = {
  thinking: null,
  effort: null,
  reasoningEnabled: null,
  reasoningEffort: null,
  apiVariant: null,
  webSearch: null,
  model: "test-model",
  provider: "anthropic",
  endpointId: null,
  expectedOllamaEndpoint: null,
} as const;

function turn(
  memory?: NonNullable<MastraAgentTurnInput["memory"]>,
): MastraAgentTurnInput {
  return {
    instructions: "system",
    messages: [{ role: "user", content: "hello" }],
    route: ROUTE,
    systemCacheSegments: null,
    systemVolatileTail: null,
    send: async () => ({ blocks: [], stopReason: "end_turn" }),
    audit: {} as never,
    signal: new AbortController().signal,
    ...(memory ? { memory } : {}),
  };
}

function mockBackend(): NapiMemoryBackendLike & NapiMemoryVectorBackendLike {
  return {
    memoryEmbedTexts: vi.fn(),
    memoryThreadRead: vi.fn(),
    memoryThreadWrite: vi.fn(),
    memoryThreadDelete: vi.fn(),
    memoryMessageRead: vi.fn(),
    memoryMessageWrite: vi.fn(),
    memoryMessageDelete: vi.fn(),
    memoryResourceRead: vi.fn(),
    memoryResourceWrite: vi.fn(),
    memoryObservationalMemoryRead: vi.fn(),
    memoryObservationalMemoryWrite: vi.fn(),
    memoryVectorCreateIndex: vi.fn(),
    memoryVectorUpsert: vi.fn(),
    memoryVectorQuery: vi.fn(),
    memoryVectorListIndexes: vi.fn(),
    memoryVectorDescribeIndex: vi.fn(),
    memoryVectorDeleteIndex: vi.fn(),
    memoryVectorUpdate: vi.fn(),
    memoryVectorDelete: vi.fn(),
    memoryVectorDeleteMany: vi.fn(),
  };
}

describe("Mastra Memory flag M seam", () => {
  beforeEach(() => {
    mocks.configs.length = 0;
  });

  it("leaves Agent memory unset while flag M is closed", async () => {
    await createMastraAgentRuntime().runTurn(turn());

    expect(mocks.configs[0]).not.toHaveProperty("memory");
  });

  it("uses the Native adapters when flag M is open", async () => {
    await createMastraAgentRuntime().runTurn(
      turn({ backend: mockBackend(), projectId: "p1" }),
    );

    const memory = mocks.configs[0]?.memory;
    expect(memory).toBeInstanceOf(Memory);
    expect((memory as Memory).storage).toBeInstanceOf(MastraCompositeStore);
    expect((memory as Memory).storage.stores?.memory).toBeInstanceOf(
      NativeMemoryStorage,
    );
    expect((memory as Memory).vector).toBeInstanceOf(NativeMemoryVector);
  });
});
