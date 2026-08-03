import type { AgentPreflightTarget } from "./chatTurnRouting";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";

interface ChatOllamaPreflightInput {
  agentMode: boolean;
}

interface ChatOllamaPreflightPorts {
  resolveRawAgentTarget: () => AgentPreflightTarget;
  resolveAgentTarget: () => AgentPreflightTarget;
  resolveConversationTarget: () => AgentPreflightTarget;
  resolveCurrentRoute: (
    surface: "chat" | "agent",
  ) => ResolvedChatTurnRoute | null;
  refreshSelectedModel: (
    target: AgentPreflightTarget,
    requireCapabilities: boolean,
  ) => Promise<readonly unknown[] | null>;
  awaitPendingSessionMutations: () => Promise<void> | undefined;
  isAuthorityCurrent: () => boolean;
  blockIfPolicyOff: () => boolean;
  blockIfUnlicensed: () => boolean;
  translate: (key: string, options?: Record<string, unknown>) => string;
  setError: (message: string) => void;
  notifyError: (message: string) => void;
}

function targetKey(target: AgentPreflightTarget): string {
  return `${target.ollamaEndpoint}\u0000${target.model}`;
}

function requiresOllamaProbe(target: AgentPreflightTarget): boolean {
  return (
    target.provider === "ollama" &&
    Boolean(target.model) &&
    target.model !== "openrouter/fusion"
  );
}

type ChatOllamaPreflightDecision = boolean | Promise<boolean>;

function continueWhenReady(
  decision: ChatOllamaPreflightDecision,
  next: () => ChatOllamaPreflightDecision,
): ChatOllamaPreflightDecision {
  if (typeof decision === "boolean") {
    return decision ? next() : false;
  }
  return decision.then((ready) => (ready ? next() : false));
}

export function runChatOllamaPreflight(
  input: ChatOllamaPreflightInput,
  ports: ChatOllamaPreflightPorts,
): ChatOllamaPreflightDecision {
  const probedTargets = new Set<string>();
  const probeTarget = (
    target: AgentPreflightTarget,
    requireCapabilities: boolean,
  ): Promise<boolean> => {
    // The original call site awaited every Ollama target, including an empty
    // model or a duplicate target. Keep that yield boundary intact.
    if (!requiresOllamaProbe(target)) return Promise.resolve(true);
    const key = targetKey(target);
    if (probedTargets.has(key)) return Promise.resolve(true);
    probedTargets.add(key);

    return (async () => {
      const observedModels = await ports.refreshSelectedModel(
        target,
        requireCapabilities,
      );
      const pendingSessionMutations = ports.awaitPendingSessionMutations();
      if (pendingSessionMutations) {
        await pendingSessionMutations;
      }
      if (!ports.isAuthorityCurrent()) return false;

      // Policy/license may change while the local metadata request is in
      // flight; re-check before publishing the user/assistant placeholders.
      if (ports.blockIfPolicyOff()) return false;
      if (ports.blockIfUnlicensed()) return false;
      if (observedModels === null || observedModels.length === 0) {
        const message =
          observedModels === null
            ? ports.translate("chat.ollamaMetadataUnavailable", {
                model: target.model,
              })
            : ports.translate("chat.ollamaModelUnavailable", {
                model: target.model,
              });
        ports.setError(message);
        ports.notifyError(
          ports.translate("chat.sendFailed", {
            message,
          }),
        );
        return false;
      }
      return true;
    })();
  };

  if (input.agentMode) {
    const finishAgentPreflight = (): boolean => {
      const finalAgentRoute = ports.resolveCurrentRoute("agent");
      const finalTarget =
        finalAgentRoute?.capabilities.supportsTools === false
          ? ports.resolveConversationTarget()
          : ports.resolveAgentTarget();
      if (
        requiresOllamaProbe(finalTarget) &&
        !probedTargets.has(targetKey(finalTarget))
      ) {
        // A route transition outside raw-role → gated-agent → conversation is
        // not safe to send without another selected-model observation.
        return false;
      }
      return true;
    };

    const continueAfterAgentTarget = (): ChatOllamaPreflightDecision => {
      // Stage 3: a no-tools Agent route is deliberately sent as plain chat.
      // Probe the conversation role as well so the final Ollama context guard
      // never evaluates (or sends) an unobserved fallback model.
      const agentRouteAfterProbe = ports.resolveCurrentRoute("agent");
      const conversationTarget = ports.resolveConversationTarget();
      if (
        agentRouteAfterProbe?.capabilities.supportsTools === false &&
        conversationTarget.provider === "ollama"
      ) {
        return continueWhenReady(
          probeTarget(conversationTarget, false),
          finishAgentPreflight,
        );
      }
      return finishAgentPreflight();
    };

    const continueAfterRawTarget = (): ChatOllamaPreflightDecision => {
      // Stage 2: capability gating may now resolve to the active model. Probe
      // that eventual Agent route before trusting its tools/context metadata.
      const agentTarget = ports.resolveAgentTarget();
      if (agentTarget.provider === "ollama") {
        return continueWhenReady(
          probeTarget(agentTarget, true),
          continueAfterAgentTarget,
        );
      }
      return continueAfterAgentTarget();
    };

    // Stage 1: probe the raw Agent assignment even when a cached no-tools
    // flag currently gates it out. The selected model's `/api/show` result
    // can make a replaced tag eligible again.
    const rawAgentTarget = ports.resolveRawAgentTarget();
    if (rawAgentTarget.provider === "ollama") {
      return continueWhenReady(
        probeTarget(rawAgentTarget, true),
        continueAfterRawTarget,
      );
    }
    return continueAfterRawTarget();
  }

  const conversationTarget = ports.resolveConversationTarget();
  if (conversationTarget.provider === "ollama") {
    // Plain Ollama chat also refreshes the selected model so it never uses the
    // generic unknown-model 8k limit. Small requests remain usable when only
    // the model maximum is known; exact effective overflows are still
    // diagnosed by the final payload guard.
    return probeTarget(conversationTarget, false);
  }
  return true;
}
