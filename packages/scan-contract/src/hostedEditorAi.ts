export const HOSTED_EDITOR_AI_LIMITS = {
  maxPromptChars: 8_000,
  maxContextChars: 16_000,
  maxMessages: 48,
  maxTools: 64,
  maxToolDefinitionsBytes: 32 * 1024,
  maxToolCallsPerResponse: 16,
  maxToolCallsBytes: 32 * 1024,
  maxToolUsesInHistory: 64,
  maxToolArgumentsBytes: 8 * 1024,
  maxSchemaDepth: 8,
  maxRequestBytes: 64 * 1024,
  maxResponseTextChars: 32_000,
  maxResponseBytes: 64 * 1024,
  maxArtifactBytes: 64 * 1024,
  maxProviderCompletionTokens: 2_000,
} as const;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

export interface HostedEditorAiToolParameterSchema {
  type: string;
  description?: string;
  items?: HostedEditorAiToolParameterSchema;
  enum?: string[];
  properties?: Record<string, HostedEditorAiToolParameterSchema>;
  required?: string[];
}

export interface HostedEditorAiToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, HostedEditorAiToolParameterSchema>;
    required: string[];
  };
}

export interface HostedEditorAiToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type HostedEditorAiMessage =
  | { role: "user" | "system"; content: string }
  | {
      role: "assistant";
      content: string;
      toolUses?: HostedEditorAiToolUse[];
    }
  | {
      role: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export interface HostedEditorAiAgentRequest {
  messages: HostedEditorAiMessage[];
  tools: HostedEditorAiToolDefinition[];
}

export interface HostedEditorAiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface HostedEditorAiResponse {
  response: string;
  costWeight: number;
  toolCalls?: HostedEditorAiToolCall[];
}

export type HostedEditorAiValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : utf8ByteLength(serialized);
  } catch {
    return null;
  }
}

function isJsonValue(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): boolean {
  if (depth > HOSTED_EDITOR_AI_LIMITS.maxSchemaDepth) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= 128 &&
        value.every((item) => isJsonValue(item, depth + 1, ancestors))
      );
    }
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length <= 128 &&
      entries.every(
        ([key, nested]) =>
          key.length > 0 &&
          key.length <= 128 &&
          isJsonValue(nested, depth + 1, ancestors),
      )
    );
  } finally {
    ancestors.delete(value);
  }
}

function validToolInput(value: unknown): value is Record<string, unknown> {
  const bytes = jsonByteLength(value);
  return (
    isRecord(value) &&
    isJsonValue(value) &&
    bytes !== null &&
    bytes <= HOSTED_EDITOR_AI_LIMITS.maxToolArgumentsBytes
  );
}

function validStringArray(
  value: unknown,
  maximum: number,
  maxItemChars: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= maxItemChars,
    ) &&
    new Set(value).size === value.length
  );
}

function validParameterSchema(value: unknown, depth = 0): boolean {
  if (
    depth > HOSTED_EDITOR_AI_LIMITS.maxSchemaDepth ||
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "description",
      "enum",
      "items",
      "properties",
      "required",
      "type",
    ]) ||
    typeof value.type !== "string" ||
    !JSON_SCHEMA_TYPES.has(value.type) ||
    (value.description !== undefined &&
      (typeof value.description !== "string" ||
        value.description.length > 1_024)) ||
    (value.enum !== undefined && !validStringArray(value.enum, 64, 256))
  ) {
    return false;
  }

  if (
    value.items !== undefined &&
    !validParameterSchema(value.items, depth + 1)
  ) {
    return false;
  }

  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) return false;
    const entries = Object.entries(value.properties);
    if (
      entries.length > 64 ||
      !entries.every(
        ([key, schema]) =>
          key.length > 0 &&
          key.length <= 128 &&
          validParameterSchema(schema, depth + 1),
      )
    ) {
      return false;
    }
  }

  if (value.required !== undefined) {
    if (!validStringArray(value.required, 64, 128)) return false;
    if (
      value.properties === undefined ||
      value.required.some(
        (key) => !Object.prototype.hasOwnProperty.call(value.properties, key),
      )
    ) {
      return false;
    }
  }

  return true;
}

function parseTools(
  input: unknown,
): HostedEditorAiValidationResult<HostedEditorAiToolDefinition[]> {
  const serializedBytes = jsonByteLength(input);
  if (
    !Array.isArray(input) ||
    input.length > HOSTED_EDITOR_AI_LIMITS.maxTools ||
    serializedBytes === null ||
    serializedBytes > HOSTED_EDITOR_AI_LIMITS.maxToolDefinitionsBytes
  ) {
    return { ok: false, error: "hosted Editor tools exceed their limit" };
  }

  const names = new Set<string>();
  for (const value of input) {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["description", "inputSchema", "name"]) ||
      typeof value.name !== "string" ||
      !TOOL_NAME_PATTERN.test(value.name) ||
      names.has(value.name) ||
      typeof value.description !== "string" ||
      value.description.length === 0 ||
      value.description.length > 2_048 ||
      !isRecord(value.inputSchema) ||
      value.inputSchema.type !== "object" ||
      !isRecord(value.inputSchema.properties) ||
      !Array.isArray(value.inputSchema.required) ||
      !validParameterSchema(value.inputSchema)
    ) {
      return { ok: false, error: "hosted Editor tool definition is invalid" };
    }
    names.add(value.name);
  }
  return {
    ok: true,
    value: input as HostedEditorAiToolDefinition[],
  };
}

function validToolUse(
  input: unknown,
  declaredNames: ReadonlySet<string>,
): input is HostedEditorAiToolUse {
  return (
    isRecord(input) &&
    hasOnlyKeys(input, ["id", "input", "name"]) &&
    typeof input.id === "string" &&
    TOOL_CALL_ID_PATTERN.test(input.id) &&
    typeof input.name === "string" &&
    TOOL_NAME_PATTERN.test(input.name) &&
    declaredNames.has(input.name) &&
    validToolInput(input.input)
  );
}

export function parseHostedEditorAiAgentRequest(
  input: unknown,
  prompt: string,
): HostedEditorAiValidationResult<HostedEditorAiAgentRequest> {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["messages", "tools"]) ||
    typeof prompt !== "string" ||
    prompt.length === 0 ||
    prompt.length > HOSTED_EDITOR_AI_LIMITS.maxPromptChars
  ) {
    return { ok: false, error: "hosted Editor agent request is invalid" };
  }

  const parsedTools = parseTools(input.tools);
  if (!parsedTools.ok) return parsedTools;
  const requestBytes = jsonByteLength({
    operation: "codex",
    prompt,
    messages: input.messages,
    tools: input.tools,
  });
  if (
    requestBytes === null ||
    requestBytes > HOSTED_EDITOR_AI_LIMITS.maxRequestBytes
  ) {
    return { ok: false, error: "hosted Editor request body is too large" };
  }
  const declaredNames = new Set(parsedTools.value.map((tool) => tool.name));
  if (
    !Array.isArray(input.messages) ||
    input.messages.length === 0 ||
    input.messages.length > HOSTED_EDITOR_AI_LIMITS.maxMessages
  ) {
    return { ok: false, error: "hosted Editor messages exceed their limit" };
  }

  let selectedPromptIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (isRecord(message) && message.role === "user") {
      selectedPromptIndex = index;
      break;
    }
  }
  if (
    selectedPromptIndex < 0 ||
    !isRecord(input.messages[selectedPromptIndex]) ||
    input.messages[selectedPromptIndex]?.content !== prompt
  ) {
    return { ok: false, error: "hosted Editor prompt does not match messages" };
  }

  let contextCharacters = 0;
  let toolUseCount = 0;
  const pendingToolUses = new Set<string>();
  const completedToolUses = new Set<string>();
  for (const [index, message] of input.messages.entries()) {
    if (!isRecord(message) || typeof message.role !== "string") {
      return { ok: false, error: "hosted Editor message is invalid" };
    }
    if (pendingToolUses.size > 0 && message.role !== "tool_result") {
      return { ok: false, error: "hosted Editor tool result order is invalid" };
    }
    if (message.role === "user" || message.role === "system") {
      if (
        !hasOnlyKeys(message, ["content", "role"]) ||
        typeof message.content !== "string"
      ) {
        return { ok: false, error: "hosted Editor message is invalid" };
      }
    } else if (message.role === "assistant") {
      if (
        !hasOnlyKeys(message, ["content", "role", "toolUses"]) ||
        typeof message.content !== "string" ||
        (message.toolUses !== undefined && !Array.isArray(message.toolUses)) ||
        (Array.isArray(message.toolUses) &&
          message.toolUses.length >
            HOSTED_EDITOR_AI_LIMITS.maxToolCallsPerResponse)
      ) {
        return {
          ok: false,
          error: "hosted Editor assistant message is invalid",
        };
      }
      for (const toolUse of message.toolUses ?? []) {
        if (
          !validToolUse(toolUse, declaredNames) ||
          pendingToolUses.has(toolUse.id) ||
          completedToolUses.has(toolUse.id)
        ) {
          return { ok: false, error: "hosted Editor tool history is invalid" };
        }
        pendingToolUses.add(toolUse.id);
        toolUseCount += 1;
      }
    } else if (message.role === "tool_result") {
      if (
        !hasOnlyKeys(message, ["content", "isError", "role", "toolUseId"]) ||
        typeof message.toolUseId !== "string" ||
        !TOOL_CALL_ID_PATTERN.test(message.toolUseId) ||
        typeof message.content !== "string" ||
        (message.isError !== undefined &&
          typeof message.isError !== "boolean") ||
        !pendingToolUses.delete(message.toolUseId) ||
        completedToolUses.has(message.toolUseId)
      ) {
        return { ok: false, error: "hosted Editor tool result is invalid" };
      }
      completedToolUses.add(message.toolUseId);
    } else {
      return { ok: false, error: "hosted Editor message role is invalid" };
    }

    if (index !== selectedPromptIndex) {
      contextCharacters += (message.content as string).length;
    }
  }

  if (
    contextCharacters > HOSTED_EDITOR_AI_LIMITS.maxContextChars ||
    toolUseCount > HOSTED_EDITOR_AI_LIMITS.maxToolUsesInHistory ||
    pendingToolUses.size > 0
  ) {
    return { ok: false, error: "hosted Editor agent context is invalid" };
  }

  return {
    ok: true,
    value: {
      messages: input.messages as HostedEditorAiMessage[],
      tools: parsedTools.value,
    },
  };
}

export function parseHostedEditorAiToolCalls(
  input: unknown,
  allowedNames?: ReadonlySet<string>,
): HostedEditorAiValidationResult<HostedEditorAiToolCall[]> {
  const serializedBytes = jsonByteLength(input);
  if (
    !Array.isArray(input) ||
    input.length > HOSTED_EDITOR_AI_LIMITS.maxToolCallsPerResponse ||
    serializedBytes === null ||
    serializedBytes > HOSTED_EDITOR_AI_LIMITS.maxToolCallsBytes
  ) {
    return { ok: false, error: "hosted Editor tool calls exceed their limit" };
  }
  const ids = new Set<string>();
  for (const value of input) {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["id", "input", "name"]) ||
      typeof value.id !== "string" ||
      !TOOL_CALL_ID_PATTERN.test(value.id) ||
      ids.has(value.id) ||
      typeof value.name !== "string" ||
      !TOOL_NAME_PATTERN.test(value.name) ||
      (allowedNames !== undefined && !allowedNames.has(value.name)) ||
      !validToolInput(value.input)
    ) {
      return { ok: false, error: "hosted Editor tool call is invalid" };
    }
    ids.add(value.id);
  }
  return { ok: true, value: input as HostedEditorAiToolCall[] };
}

export function parseHostedEditorAiResponse(
  input: unknown,
  allowedNames?: ReadonlySet<string>,
): HostedEditorAiValidationResult<HostedEditorAiResponse> {
  const responseBytes = jsonByteLength(input);
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["costWeight", "response", "toolCalls"]) ||
    typeof input.response !== "string" ||
    input.response.length > HOSTED_EDITOR_AI_LIMITS.maxResponseTextChars ||
    responseBytes === null ||
    responseBytes > HOSTED_EDITOR_AI_LIMITS.maxResponseBytes ||
    !Number.isSafeInteger(input.costWeight) ||
    (input.costWeight as number) < 1 ||
    (input.costWeight as number) > 3
  ) {
    return { ok: false, error: "hosted Editor AI response is invalid" };
  }
  let toolCalls: HostedEditorAiToolCall[] | undefined;
  if (input.toolCalls !== undefined) {
    const parsed = parseHostedEditorAiToolCalls(input.toolCalls, allowedNames);
    if (!parsed.ok || parsed.value.length === 0) {
      return { ok: false, error: "hosted Editor AI response is invalid" };
    }
    toolCalls = parsed.value;
  }
  if (input.response.length === 0 && toolCalls === undefined) {
    return { ok: false, error: "hosted Editor AI response is empty" };
  }
  return {
    ok: true,
    value: {
      response: input.response,
      costWeight: input.costWeight as number,
      ...(toolCalls ? { toolCalls } : {}),
    },
  };
}
