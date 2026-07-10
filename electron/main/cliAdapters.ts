export type CliKind = "claude" | "codex" | "opencode";

export type CliAdapterEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | {
      type: "done";
      inputTokens: number | null;
      outputTokens: number | null;
      stopReason: string;
    };

export interface CliLineAdapter {
  parseLine(line: string): CliAdapterEvent[];
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function getProperty(value: unknown, key: string): unknown {
  return isJsonObject(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | null {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : null;
}

function getPreferredProperty(
  value: unknown,
  primaryKey: string,
  fallbackKey: string,
): unknown {
  if (!isJsonObject(value)) {
    return undefined;
  }
  return hasOwn(value, primaryKey) ? value[primaryKey] : value[fallbackKey];
}

function getTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseJson(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

/** Return only the newly appended Unicode code points for one cumulative value. */
function takeUnicodeSuffixDelta(
  state: Map<string, number>,
  id: string,
  full: string,
): string | null {
  const codePoints = Array.from(full);
  const previousLength = state.get(id) ?? 0;
  if (codePoints.length <= previousLength) {
    return null;
  }

  const delta = codePoints.slice(previousLength).join("");
  state.set(id, codePoints.length);
  return delta.length > 0 ? delta : null;
}

class ClaudeLineAdapter implements CliLineAdapter {
  private lastEmittedCodePoints = 0;

  parseLine(line: string): CliAdapterEvent[] {
    const json = parseJson(line);
    const eventType = getString(json, "type");

    if (eventType === "assistant") {
      return this.parseAssistant(json);
    }
    if (eventType === "result") {
      const usage = getProperty(json, "usage");
      return [
        {
          type: "done",
          inputTokens: getTokenCount(getProperty(usage, "input_tokens")),
          outputTokens: getTokenCount(getProperty(usage, "output_tokens")),
          stopReason: getString(json, "stop_reason") ?? "end_turn",
        },
      ];
    }
    return [];
  }

  private parseAssistant(json: unknown): CliAdapterEvent[] {
    const content = getProperty(getProperty(json, "message"), "content");
    let full = "";

    if (Array.isArray(content)) {
      for (const block of content) {
        if (getString(block, "type") !== "text") {
          continue;
        }
        const text = getString(block, "text");
        if (text !== null) {
          full += text;
        }
      }
    }

    const codePoints = Array.from(full);
    if (codePoints.length <= this.lastEmittedCodePoints) {
      return [];
    }

    const delta = codePoints.slice(this.lastEmittedCodePoints).join("");
    this.lastEmittedCodePoints = codePoints.length;
    return delta.length > 0 ? [{ type: "text", delta }] : [];
  }
}

class CodexLineAdapter implements CliLineAdapter {
  private readonly messageCodePoints = new Map<string, number>();
  private readonly reasoningCodePoints = new Map<string, number>();

  parseLine(line: string): CliAdapterEvent[] {
    const json = parseJson(line);
    const eventType = getString(json, "type");

    if (
      eventType === "item.completed" ||
      eventType === "item.updated" ||
      eventType === "item.added"
    ) {
      return this.parseItem(getProperty(json, "item"));
    }

    if (eventType === "turn.completed" || eventType === "thread.completed") {
      return this.parseUsage(json);
    }

    if (eventType === "error") {
      const error = getProperty(json, "error");
      const candidate =
        isJsonObject(error) && hasOwn(error, "message")
          ? error.message
          : getProperty(json, "message");
      const message =
        typeof candidate === "string" ? candidate : "Codex CLI error";
      return [
        { type: "text", delta: `[error] ${message}\n` },
        {
          type: "done",
          inputTokens: null,
          outputTokens: null,
          stopReason: "error",
        },
      ];
    }

    return [];
  }

  private parseItem(item: unknown): CliAdapterEvent[] {
    if (!isJsonObject(item)) {
      return [];
    }

    const itemTypeValue = hasOwn(item, "item_type")
      ? item.item_type
      : item.type;
    if (typeof itemTypeValue !== "string") {
      return [];
    }

    if (
      itemTypeValue === "assistant_message" ||
      itemTypeValue === "agent_message"
    ) {
      return this.parseItemText(item, this.messageCodePoints, "text");
    }
    if (itemTypeValue === "reasoning") {
      return this.parseItemText(item, this.reasoningCodePoints, "thinking");
    }
    return [];
  }

  private parseItemText(
    item: JsonObject,
    state: Map<string, number>,
    type: "text" | "thinking",
  ): CliAdapterEvent[] {
    const rawId = typeof item.id === "string" ? item.id : "";
    const id = rawId.length > 0 ? rawId : "_anon";

    if (typeof item.text === "string") {
      const delta = takeUnicodeSuffixDelta(state, id, item.text);
      return delta === null ? [] : [{ type, delta }];
    }

    if (typeof item.delta === "string" && item.delta.length > 0) {
      return [{ type, delta: item.delta }];
    }
    return [];
  }

  private parseUsage(json: unknown): CliAdapterEvent[] {
    const usage = getProperty(json, "usage");
    if (usage === undefined) {
      return [];
    }

    const inputTokens = getTokenCount(
      getPreferredProperty(usage, "input_tokens", "prompt_tokens"),
    );
    const outputTokens = getTokenCount(
      getPreferredProperty(usage, "output_tokens", "completion_tokens"),
    );
    if (inputTokens === null && outputTokens === null) {
      return [];
    }

    return [
      {
        type: "done",
        inputTokens,
        outputTokens,
        stopReason: "end_turn",
      },
    ];
  }
}

class OpenCodeLineAdapter implements CliLineAdapter {
  private readonly textPartCodePoints = new Map<string, number>();

  parseLine(line: string): CliAdapterEvent[] {
    const json = parseJson(line);
    const eventType = getString(json, "type");

    if (eventType === "text") {
      const part = getProperty(json, "part");
      const rawId = getString(part, "id") ?? "";
      const id = rawId.length > 0 ? rawId : "_text";
      const text = getString(part, "text");
      if (text === null) {
        return [];
      }
      const delta = takeUnicodeSuffixDelta(this.textPartCodePoints, id, text);
      return delta === null ? [] : [{ type: "text", delta }];
    }

    if (eventType === "step_finish") {
      if (!isJsonObject(json) || !hasOwn(json, "part")) {
        return [];
      }
      const part = json.part;
      const partType = getString(part, "type");
      if (partType !== null && partType !== "step-finish") {
        return [];
      }

      const reason = getString(part, "reason");
      if (reason === "tool-calls") {
        return [];
      }
      const tokens = getProperty(part, "tokens");
      return [
        {
          type: "done",
          inputTokens: getTokenCount(getProperty(tokens, "input")),
          outputTokens: getTokenCount(getProperty(tokens, "output")),
          stopReason: reason ?? "end_turn",
        },
      ];
    }

    if (eventType === "error") {
      const error = getProperty(json, "error");
      const data = getProperty(error, "data");
      let candidate: unknown;
      if (isJsonObject(data) && hasOwn(data, "message")) {
        candidate = data.message;
      } else if (isJsonObject(error) && hasOwn(error, "message")) {
        candidate = error.message;
      }
      const message =
        typeof candidate === "string" ? candidate : "OpenCode CLI error";
      return [
        { type: "text", delta: `[error] ${message}\n` },
        {
          type: "done",
          inputTokens: null,
          outputTokens: null,
          stopReason: "error",
        },
      ];
    }

    return [];
  }
}

export function createCliLineAdapter(kind: CliKind): CliLineAdapter {
  switch (kind) {
    case "claude":
      return new ClaudeLineAdapter();
    case "codex":
      return new CodexLineAdapter();
    case "opencode":
      return new OpenCodeLineAdapter();
    default:
      throw new Error(`invalid CLI kind: ${String(kind)}`);
  }
}
