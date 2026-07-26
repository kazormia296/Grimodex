import type {
  CodexAppEvent,
  CodexAppEventEnvelope,
  CodexAppItem,
} from "../../shared/codexAppProtocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function recordValue(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function numberValue(...values: unknown[]): number | null {
  return (
    values.find(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    ) ?? null
  );
}

function truncate(
  value: string | undefined,
  max = 1024 * 1024,
): string | undefined {
  if (value === undefined || value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated]`;
}

function normalizeItem(
  params: unknown,
  fallbackType: CodexAppItem["type"] = "unknown",
  fallbackStatus: CodexAppItem["status"] = "unknown",
): CodexAppItem | null {
  if (!isRecord(params)) return null;
  const rawItem = isRecord(params.item) ? params.item : params;
  const id = stringValue(rawItem.id, rawItem.itemId, params.itemId);
  if (!id) return null;
  const rawType = stringValue(rawItem.type, rawItem.kind, params.type);
  const type: CodexAppItem["type"] =
    rawType?.includes("agent") || rawType === "agentMessage"
      ? "agent-message"
      : rawType?.includes("reason")
        ? "reasoning"
        : rawType?.includes("command")
          ? "command"
          : rawType?.toLowerCase().includes("mcp")
            ? "mcp-tool"
            : rawType?.includes("file")
              ? "file-change"
              : rawType?.includes("plan")
                ? "plan"
                : fallbackType;
  const statusValue = stringValue(rawItem.status, params.status);
  const status: CodexAppItem["status"] =
    statusValue === "started" ||
    statusValue === "completed" ||
    statusValue === "failed" ||
    statusValue === "interrupted"
      ? statusValue
      : fallbackStatus;
  const changes = Array.isArray(rawItem.changes)
    ? rawItem.changes.filter(isRecord)
    : [];
  const changePaths = changes
    .map((change) => change.path)
    .filter((value): value is string => typeof value === "string")
    .slice(0, 256);
  const changeDiff = truncate(
    changes
      .map((change) => change.diff)
      .filter((value): value is string => typeof value === "string")
      .join("\n"),
  );
  return {
    id,
    type,
    status,
    title: stringValue(rawItem.title, rawItem.name),
    text: truncate(stringValue(rawItem.text, rawItem.message, rawItem.content)),
    command:
      typeof rawItem.command === "string"
        ? [rawItem.command]
        : Array.isArray(rawItem.command)
          ? rawItem.command
              .filter((value): value is string => typeof value === "string")
              .slice(0, 128)
          : undefined,
    output: truncate(
      stringValue(
        rawItem.output,
        rawItem.stdout,
        rawItem.result,
        rawItem.aggregatedOutput,
        rawItem.delta,
      ),
    ),
    affectedPaths:
      changePaths.length > 0
        ? changePaths
        : Array.isArray(rawItem.affectedPaths)
          ? rawItem.affectedPaths
              .filter((value): value is string => typeof value === "string")
              .slice(0, 256)
          : undefined,
    diff: changeDiff || truncate(stringValue(rawItem.diff)),
    raw: rawItem,
  };
}

function eventEnvelope(
  context: Omit<CodexAppEventEnvelope, "event">,
  event: CodexAppEvent,
  itemId?: string,
): CodexAppEventEnvelope {
  return { ...context, ...(itemId ? { itemId } : {}), event };
}

/** Normalize the small stable notification subset into Grimodex events. */
export function mapCodexNotification(
  method: string,
  params: unknown,
  context: Omit<CodexAppEventEnvelope, "event">,
): CodexAppEventEnvelope | null {
  const record = isRecord(params) ? params : {};
  const thread = recordValue(params, "thread");
  const turn = recordValue(params, "turn");
  const item = recordValue(params, "item");
  const threadId = stringValue(record.threadId, thread?.id, thread?.threadId);
  const turnId = stringValue(record.turnId, turn?.id, turn?.turnId);
  const withTurn = turnId ? { ...context, codexTurnId: turnId } : context;

  if (method === "thread/started") {
    return threadId
      ? eventEnvelope(context, { type: "thread-started", threadId })
      : null;
  }
  if (method === "turn/started") {
    return turnId
      ? eventEnvelope(withTurn, { type: "turn-started", turnId })
      : null;
  }
  if (method === "item/agentMessage/delta") {
    const delta = stringValue(record.delta, record.text, record.content);
    return delta
      ? eventEnvelope(withTurn, { type: "text-delta", delta })
      : null;
  }
  if (
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta"
  ) {
    const delta = stringValue(record.delta, record.text, record.content);
    return delta
      ? eventEnvelope(withTurn, { type: "thinking-delta", delta })
      : null;
  }
  if (method === "item/started") {
    const normalized = normalizeItem(params, "unknown", "started");
    return normalized
      ? eventEnvelope(
          withTurn,
          { type: "item-started", item: normalized },
          normalized.id,
        )
      : null;
  }
  if (method === "item/completed") {
    const normalized = normalizeItem(params, "unknown", "completed");
    return normalized
      ? eventEnvelope(
          withTurn,
          { type: "item-completed", item: normalized },
          normalized.id,
        )
      : null;
  }
  if (method === "thread/tokenUsage/updated") {
    const tokenUsage = recordValue(params, "tokenUsage");
    const usage =
      recordValue(tokenUsage, "last") ??
      recordValue(tokenUsage, "total") ??
      recordValue(params, "usage") ??
      record;
    return eventEnvelope(withTurn, {
      type: "usage",
      inputTokens: numberValue(usage.inputTokens, usage.input_tokens),
      outputTokens: numberValue(usage.outputTokens, usage.output_tokens),
      cachedInputTokens: numberValue(
        usage.cachedInputTokens,
        usage.cached_input_tokens,
      ),
    });
  }
  if (method === "turn/completed") {
    const status = recordValue(params, "status") ?? turn;
    const turnStatus = stringValue(
      turn?.status,
      status?.status,
      record.stopReason,
      record.stop_reason,
    );
    if (turnStatus === "failed") {
      const failure =
        recordValue(turn, "error") ??
        recordValue(status, "error") ??
        recordValue(params, "error");
      return eventEnvelope(withTurn, {
        type: "turn-error",
        message:
          stringValue(failure?.message, record.message) ??
          "Codex app-server turn failed",
        code: stringValue(failure?.code, record.code),
        retryable: false,
      });
    }
    const stopReason =
      stringValue(
        record.stopReason,
        record.stop_reason,
        status?.reason,
        status?.status,
        turn?.status,
      ) ?? "completed";
    const usage = recordValue(params, "usage");
    return eventEnvelope(withTurn, {
      type: "turn-completed",
      stopReason,
      inputTokens: numberValue(record.inputTokens, usage?.inputTokens),
      outputTokens: numberValue(record.outputTokens, usage?.outputTokens),
    });
  }
  if (method === "error") {
    const error = recordValue(params, "error");
    return eventEnvelope(withTurn, {
      type: "turn-error",
      message:
        stringValue(record.message, error?.message) ?? "Codex app-server error",
      code: stringValue(record.code, error?.code),
      retryable: record.willRetry === true || record.retryable === true,
    });
  }
  if (method === "warning") {
    return eventEnvelope(withTurn, {
      type: "warning",
      message:
        stringValue(record.message, record.text) ?? "Codex app-server warning",
    });
  }

  // Newer Codex versions expose item-specific deltas. Keep them visible as a
  // bounded item event until a dedicated UI card is available.
  if (
    method === "item/commandExecution/outputDelta" ||
    method === "item/mcpToolCall/progress" ||
    method === "item/fileChange/outputDelta" ||
    method === "item/fileChange/patchUpdated" ||
    method === "item/plan/delta"
  ) {
    const fallbackType: CodexAppItem["type"] = method.includes(
      "commandExecution",
    )
      ? "command"
      : method.includes("mcpToolCall")
        ? "mcp-tool"
        : method.includes("fileChange")
          ? "file-change"
          : "plan";
    const normalized = normalizeItem(params, fallbackType, "started");
    return normalized
      ? eventEnvelope(
          withTurn,
          { type: "item-completed", item: normalized },
          normalized.id,
        )
      : null;
  }
  if (item) return null;
  return null;
}
