import { describe, expect, it, vi } from "vitest";
import { runChatOllamaPreflight } from "./chatOllamaPreflight";

// Negative (11) (K3/2 "D の扱い", chatOllamaPreflight.ts:83-97 at a153743b;
// DR-DA2B-R5): when the profile gate refuses the send-time Ollama probe, the
// failure is not blamed on missing Ollama metadata.

function ports(refresh: () => Promise<readonly unknown[] | null>) {
  const target = {
    provider: "ollama" as const,
    model: "llama3",
    ollamaEndpoint: "http://127.0.0.1:11434",
  };
  return {
    resolveRawAgentTarget: () => target,
    resolveAgentTarget: () => target,
    resolveConversationTarget: () => target,
    resolveCurrentRoute: () => null,
    refreshSelectedModel: vi.fn(refresh),
    awaitPendingSessionMutations: () => undefined,
    isAuthorityCurrent: () => true,
    blockIfPolicyOff: () => false,
    blockIfUnlicensed: () => false,
    translate: (key: string) => key,
    setError: vi.fn(),
    notifyError: vi.fn(),
  };
}

describe("runChatOllamaPreflight and a refused probe", () => {
  it("reports the generic error, not missing Ollama metadata", async () => {
    const p = ports(() =>
      Promise.reject(
        new Error(
          "D2A_EGRESS_DENIED: old-local-ai: route list_ai_models is closed while restricted",
        ),
      ),
    );
    await expect(runChatOllamaPreflight({ agentMode: false }, p)).resolves.toBe(
      false,
    );
    expect(p.setError).toHaveBeenCalledWith("common.error");
    expect(p.notifyError).toHaveBeenCalledTimes(1);
  });

  it("keeps the Ollama metadata message for an unavailable probe", async () => {
    const p = ports(() => Promise.resolve(null));
    await expect(runChatOllamaPreflight({ agentMode: false }, p)).resolves.toBe(
      false,
    );
    expect(p.setError).toHaveBeenCalledWith("chat.ollamaMetadataUnavailable");
  });
});
