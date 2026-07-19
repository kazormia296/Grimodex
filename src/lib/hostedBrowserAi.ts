import {
  HOSTED_EDITOR_AI_LIMITS,
  parseAiDataDisclosure,
  parseHostedEditorAiAgentRequest,
  parseHostedEditorAiResponse,
  type AiDataDisclosureV1,
  type EditorUiLanguage,
  type HostedEditorAiAgentRequest,
  type HostedEditorAiMessage,
  type HostedAiSessionV1,
} from "@grimodex/scan-contract";
import type {
  AgentMessagePayload,
  AgentToolDefinition,
} from "@/features/chat/agent/agentTypes";
import type { AiDataDisclosureView } from "@/features/ai-policy/AiDataConsentDialog";
import { requestAiDataConsent } from "@/features/ai-policy/aiDataConsentBroker";
import type { BrowserAiAuthorizationRequest } from "./browser-mock";
import type {
  BrowserAiCompletion,
  BrowserAiOperation,
  BrowserAiRequest,
  BrowserAiTransport,
} from "./browser-ai";

const MAX_PROMPT_CHARS = HOSTED_EDITOR_AI_LIMITS.maxPromptChars;
const MAX_CONTEXT_CHARS = HOSTED_EDITOR_AI_LIMITS.maxContextChars;

export interface HostedBrowserAiOptions {
  apiBaseUrl: string;
  session: HostedAiSessionV1;
  locale?: EditorUiLanguage;
  getLocale?: () =>
    | EditorUiLanguage
    | undefined
    | Promise<EditorUiLanguage | undefined>;
  fetchImpl?: typeof fetch;
  requestConsent?: (disclosure: AiDataDisclosureView) => Promise<void>;
  now?: () => number;
}

export interface HostedBrowserAi {
  authorizeAiRequest(request: BrowserAiAuthorizationRequest): Promise<void>;
  transport: BrowserAiTransport;
}

type HostedOperation = "chat" | "inline" | "codex";

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("Hosted AI API must use HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

function messageContent(message: AgentMessagePayload): string {
  // Never forward hidden provider reasoning blocks; only the user-visible
  // assistant content and explicit tool-result text become provider context.
  return message.content;
}

function hostedAgentMessage(
  message: AgentMessagePayload,
): HostedEditorAiMessage {
  const content = messageContent(message).trim();
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content,
      ...(message.toolUses && message.toolUses.length > 0
        ? {
            toolUses: message.toolUses.map((toolUse) => ({
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input,
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool_result") {
    return {
      role: "tool_result",
      toolUseId: message.toolUseId,
      content,
      ...(message.isError === undefined ? {} : { isError: message.isError }),
    };
  }
  return { role: message.role, content };
}

function toHostedAgentRequest(
  messages: AgentMessagePayload[],
  tools: AgentToolDefinition[],
): { prompt: string; agent: HostedEditorAiAgentRequest } {
  if (messages.length > HOSTED_EDITOR_AI_LIMITS.maxMessages) {
    throw new Error("Hosted AI agent context is too large");
  }
  const normalized = messages.map(hostedAgentMessage);
  let promptIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index]?.role === "user") {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) throw new Error("Hosted AI prompt is empty");
  const promptMessage = normalized[promptIndex];
  if (!promptMessage || promptMessage.role !== "user") {
    throw new Error("Hosted AI prompt is empty");
  }
  const prompt = promptMessage.content.slice(0, MAX_PROMPT_CHARS);
  if (!prompt) throw new Error("Hosted AI prompt is empty");
  normalized[promptIndex] = { ...promptMessage, content: prompt };

  // Preserve the structured tool_use/tool_result pairing while applying the
  // same 16k visible-context budget as chat/inline. Earlier visible text is
  // truncated first; hidden thinking never enters `normalized`.
  let remainingContext = MAX_CONTEXT_CHARS;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (index === promptIndex) continue;
    const message = normalized[index];
    if (!message) continue;
    const content =
      remainingContext > 0 ? message.content.slice(-remainingContext) : "";
    remainingContext -= content.length;
    normalized[index] = { ...message, content } as HostedEditorAiMessage;
  }

  const parsed = parseHostedEditorAiAgentRequest(
    { messages: normalized, tools },
    prompt,
  );
  if (!parsed.ok) throw new Error("Hosted AI agent request is invalid");
  return { prompt, agent: parsed.value };
}

function toAgentMessages(request: BrowserAiRequest): AgentMessagePayload[] {
  return request.messages.map((message) => ({
    role:
      message.role === "system" || message.role === "assistant"
        ? message.role
        : "user",
    content: message.content,
  }));
}

function splitPromptAndContext(messages: AgentMessagePayload[]): {
  prompt: string;
  context?: string;
} {
  const populated = messages
    .map((message) => ({
      role: message.role,
      content: messageContent(message).trim(),
    }))
    .filter((message) => message.content.length > 0);
  let promptIndex = -1;
  for (let index = populated.length - 1; index >= 0; index -= 1) {
    if (populated[index]?.role === "user") {
      promptIndex = index;
      break;
    }
  }
  const selectedIndex = promptIndex >= 0 ? promptIndex : populated.length - 1;
  const selected = populated[selectedIndex];
  if (!selected) throw new Error("Hosted AI prompt is empty");
  const prompt = selected.content.slice(0, MAX_PROMPT_CHARS);
  const context = populated
    .filter((_, index) => index !== selectedIndex)
    .map((message) => `[${message.role}]\n${message.content}`)
    .join("\n\n")
    .slice(-MAX_CONTEXT_CHARS);
  return context ? { prompt, context } : { prompt };
}

function hostedCompletion(
  payload: unknown,
  allowedToolNames?: ReadonlySet<string>,
): BrowserAiCompletion {
  const parsed = parseHostedEditorAiResponse(payload, allowedToolNames);
  if (!parsed.ok) throw new Error("Hosted AI response is invalid");
  const { response, toolCalls } = parsed.value;
  return {
    blocks: [
      ...(response ? [{ type: "text" as const, content: response }] : []),
      ...(toolCalls ?? []).map((toolCall) => ({
        type: "tool_use" as const,
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      })),
    ],
    stopReason: toolCalls && toolCalls.length > 0 ? "tool_use" : "end_turn",
  };
}

function sessionExpired(session: HostedAiSessionV1, now: number): boolean {
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function operationFor(request: BrowserAiRequest): HostedOperation {
  return request.operation === "inline" ? "inline" : "chat";
}

export function createHostedBrowserAi(
  options: HostedBrowserAiOptions,
): HostedBrowserAi {
  const apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestConsent = options.requestConsent ?? requestAiDataConsent;
  const now = options.now ?? Date.now;
  let authorizedDisclosure: AiDataDisclosureV1 | null = null;
  const controllers = new Map<BrowserAiOperation, AbortController>();

  function requireCurrentSession(): void {
    if (sessionExpired(options.session, now())) {
      authorizedDisclosure = null;
      throw new Error(
        "Hosted AI session has expired. Open the Editor from Scan again.",
      );
    }
  }

  async function authorizeAiRequest(
    _request: BrowserAiAuthorizationRequest,
  ): Promise<void> {
    requireCurrentSession();
    const locale = (await options.getLocale?.()) ?? options.locale;
    const disclosureLocale = locale
      ? `?locale=${encodeURIComponent(locale)}`
      : "";
    const response = await fetchImpl(
      `${apiBaseUrl}/api/v1/ai-disclosures/hosted-editor${disclosureLocale}`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "include",
        headers: { accept: "application/json" },
        referrerPolicy: "no-referrer",
      },
    );
    if (!response.ok) {
      authorizedDisclosure = null;
      throw new Error(`Hosted AI disclosure failed (${response.status})`);
    }
    const parsed = parseAiDataDisclosure(await response.json());
    if (!parsed.ok || parsed.value.route !== "hosted-editor") {
      authorizedDisclosure = null;
      throw new Error("Hosted AI disclosure is invalid");
    }
    await requestConsent(parsed.value);
    // Keep only the opaque, server-issued disclosure needed for the next
    // provider call. The consent broker persists no manuscript or credential.
    authorizedDisclosure = parsed.value;
  }

  async function completeHosted(
    request: BrowserAiRequest,
    hostedOperation: HostedOperation,
    messages: AgentMessagePayload[],
    agent?: HostedEditorAiAgentRequest,
  ): Promise<BrowserAiCompletion> {
    requireCurrentSession();
    const disclosure = authorizedDisclosure;
    if (!disclosure) throw new Error("Hosted AI consent is required");
    const controller = new AbortController();
    controllers.get(request.operation)?.abort();
    controllers.set(request.operation, controller);
    const split = splitPromptAndContext(messages);
    const prompt = split.prompt;
    if (agent && !parseHostedEditorAiAgentRequest(agent, prompt).ok) {
      throw new Error("Hosted AI agent request is invalid");
    }
    const context = agent ? undefined : split.context;
    try {
      const response = await fetchImpl(
        `${apiBaseUrl}/api/v1/scans/${encodeURIComponent(options.session.scanId)}/editor-ai`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-ai-consent-id": disclosure.consentId,
            [disclosure.contentPolicy.acknowledgementHeader]:
              disclosure.contentPolicy.version,
            "x-editor-session-token": options.session.token,
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            operation: hostedOperation,
            prompt,
            ...(context ? { context } : {}),
            ...(agent ? { messages: agent.messages, tools: agent.tools } : {}),
          }),
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        if (response.status === 401 || response.status === 404) {
          authorizedDisclosure = null;
          throw new Error(
            "Hosted AI session is no longer valid. Open the Editor from Scan again.",
          );
        }
        if (response.status === 428) authorizedDisclosure = null;
        throw new Error(`Hosted AI request failed (${response.status})`);
      }
      const payload = await response.json();
      return hostedCompletion(
        payload,
        agent ? new Set(agent.tools.map((tool) => tool.name)) : undefined,
      );
    } finally {
      if (controllers.get(request.operation) === controller) {
        controllers.delete(request.operation);
      }
    }
  }

  const transport: BrowserAiTransport = {
    complete(request) {
      return completeHosted(
        request,
        operationFor(request),
        toAgentMessages(request),
      );
    },
    completeAgent(
      request: BrowserAiRequest,
      messages: AgentMessagePayload[],
      tools: AgentToolDefinition[],
    ) {
      const { agent } = toHostedAgentRequest(messages, tools);
      return completeHosted(request, "codex", messages, agent);
    },
    async stream(request, sink) {
      const response = await completeHosted(
        request,
        operationFor(request),
        toAgentMessages(request),
      );
      for (const block of response.blocks) {
        if (block.type === "text" || block.type === "thinking") {
          sink.text(block.content, block.type);
        }
      }
      sink.done({ stopReason: response.stopReason });
    },
    abort(operation) {
      controllers.get(operation)?.abort();
    },
  };

  return { authorizeAiRequest, transport };
}
