import { describe, expect, it, vi } from "vitest";
import type { AiSettings } from "@/features/chat/types";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";
import { createChatTurnLifecycle } from "./chatTurnLifecycle";

vi.mock("@/lib/tauri", () => ({
  cancelCurrentChatInput: vi.fn(),
  captureCurrentChatInput: vi.fn(),
  isElectron: () => true,
  retireCurrentChatInput: vi.fn(),
}));

function lifecycle() {
  return createChatTurnLifecycle({
    set: vi.fn(),
    get: vi.fn(),
    turnRuntime: {},
    isCapturedWorkspaceCurrent: vi.fn(),
    getCurrentProjectId: vi.fn(),
    codexAppApi: {},
    debugLog: vi.fn(),
    errorDetail: vi.fn(),
  } as unknown as Parameters<typeof createChatTurnLifecycle>[0]);
}

function eligibilityInput(baseUrl: string) {
  const aiSettingsEarly = {
    provider: "openai-compatible",
    model: "local-model",
    modelApiVariant: null,
    openaiCompatible: { baseUrl },
    openaiCompatibleEndpoints: [{ id: "local", label: "local", baseUrl }],
    activeOpenaiCompatibleEndpointId: "local",
  } as unknown as AiSettings;
  const turnRoute = {
    surface: "chat",
    source: "active",
    provider: "openai-compatible",
    providerOverride: null,
    transport: "http",
    endpointId: null,
    resolvedEndpointId: "local",
    apiVariant: null,
    toolProtocol: "native",
    model: "local-model",
  } as unknown as ResolvedChatTurnRoute;
  return {
    turnRoute,
    aiSettingsEarly,
    chatScope: "scene" as const,
    effectiveSceneId: "scene-1",
    activeSceneId: "scene-1",
    scopeAnchorId: null,
    threadFocusOverride: null,
    useAgentPath: false,
    capturedRagEnabled: false,
    ragActive: false,
    publicWebSearchPath: false,
  };
}

describe("captureRouteIsEligible", () => {
  it("accepts only 127.0.0.1 and [::1] IP literal endpoints", () => {
    const { captureRouteIsEligible } = lifecycle();
    for (const baseUrl of [
      "http://127.0.0.1:1234/v1",
      "http://127.0.0.1:1234/v1/",
      "http://[::1]:1234/v1",
      "http://[::1]:65535/v1/",
    ]) {
      expect(captureRouteIsEligible(eligibilityInput(baseUrl)), baseUrl).toBe(
        true,
      );
    }
  });

  it("rejects localhost, other 127/8 addresses, and alternate spellings", () => {
    const { captureRouteIsEligible } = lifecycle();
    for (const baseUrl of [
      "http://localhost:1234/v1",
      "http://LOCALHOST:1234/v1",
      "http://127.0.0.2:1234/v1",
      "http://127.1:1234/v1",
      "http://[::ffff:127.0.0.1]:1234/v1",
      "http://[0:0:0:0:0:0:0:1]:1234/v1",
      "http://0.0.0.0:1234/v1",
      "http://192.168.1.25:1234/v1",
      "https://127.0.0.1:1234/v1",
      "http://user@127.0.0.1:1234/v1",
      "http://127.0.0.1:1234/v1?x=1",
      "http://127.0.0.1:1234/v1/chat/completions",
      "http://127.0.0.1/v1",
      "http://127.0.0.1:+1234/v1",
      "http://127.0.0.1:01234/v1",
      "http://127.0.0.1:0/v1",
      "http://127.0.0.1:65536/v1",
      "http://127.0.0.1:123456/v1",
      "http://127.0.0.1:1234/v1\n",
    ]) {
      expect(captureRouteIsEligible(eligibilityInput(baseUrl)), baseUrl).toBe(
        false,
      );
    }
  });
});
