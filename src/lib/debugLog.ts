import { create } from "zustand";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogSensitivity = "safe" | "content-derived" | "secret";

/**
 * Structured details make the privacy boundary explicit at the call site.
 * `fields` are serialized only after the sensitivity policy and field-level
 * redaction have run.
 */
export interface StructuredLogDetail {
  sensitivity: LogSensitivity;
  fields: Record<string, unknown>;
}

export type LogDetail = string | StructuredLogDetail;

export interface LogEntry {
  id: number;
  level: LogLevel;
  tag: string;
  message: string;
  detail?: string;
  timestamp: string;
}

const MAX_ENTRIES = 200;
let nextId = 1;

interface DebugLogState {
  entries: LogEntry[];
  isOpen: boolean;
  push: (
    level: LogLevel,
    tag: string,
    message: string,
    detail?: LogDetail,
  ) => void;
  clear: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

const REDACTED_SQL_PARAMS = "[redacted sql params]";
const REDACTED_LEGACY_DETAIL = "[redacted legacy detail]";
const SECRET_FIELD_NAME =
  /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;

function isProductionLogMode(): boolean {
  if (import.meta.env.PROD) return true;
  const processLike = (
    globalThis as typeof globalThis & {
      process?: { env?: { NODE_ENV?: string } };
    }
  ).process;
  return processLike?.env?.NODE_ENV === "production";
}

/**
 * Drizzle includes bound values on a dedicated `params:` line. Those values
 * may be a whole scene body, so every value is redacted regardless of length
 * and regardless of the current build mode.
 */
function redactSqlParams(message: string): string {
  return message.replace(
    /^(\s*params:\s*).*$/gim,
    (_match, prefix: string) => `${prefix}${REDACTED_SQL_PARAMS}`,
  );
}

function sanitizeLogMessage(
  message: string,
  production = isProductionLogMode(),
  sensitivity?: LogSensitivity,
): string {
  if (
    production &&
    (sensitivity === "content-derived" || sensitivity === "secret")
  ) {
    return `[redacted ${sensitivity} message]`;
  }
  const redacted = redactSqlParams(message);
  if (!production) return redacted;
  return redacted
    .split("\n")
    .filter((line) => !/^\s*at\s+/.test(line))
    .join("\n");
}

function serializeStructuredFields(fields: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(fields, (key, value: unknown) => {
    if (key === "params" || SECRET_FIELD_NAME.test(key)) {
      return "[redacted]";
    }
    if (typeof value === "string") return redactSqlParams(value);
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  });
  return serialized ?? "{}";
}

/**
 * Sanitize once, before the value reaches either the in-app store or console.
 * The explicit override exists for contract tests; production callers use the
 * build/runtime mode detected above.
 */
export function sanitizeLogDetail(
  detail: LogDetail | undefined,
  production = isProductionLogMode(),
): string | undefined {
  if (detail === undefined) return undefined;
  if (typeof detail === "string") {
    const redacted = redactSqlParams(detail);
    return production ? REDACTED_LEGACY_DETAIL : redacted;
  }
  if (
    production &&
    (detail.sensitivity === "content-derived" ||
      detail.sensitivity === "secret")
  ) {
    return `[redacted ${detail.sensitivity}]`;
  }
  return serializeStructuredFields({
    sensitivity: detail.sensitivity,
    fields: detail.fields,
  });
}

export const useDebugLogStore = create<DebugLogState>()((set) => ({
  entries: [],
  isOpen: false,

  push(level, tag, message, detail) {
    const production = isProductionLogMode();
    const sensitivity =
      typeof detail === "object" ? detail.sensitivity : undefined;
    const sanitizedMessage = sanitizeLogMessage(
      message,
      production,
      sensitivity,
    );
    const sanitizedDetail = sanitizeLogDetail(detail, production);
    const entry: LogEntry = {
      id: nextId++,
      level,
      tag,
      message: sanitizedMessage,
      detail: sanitizedDetail,
      timestamp: new Date().toISOString(),
    };

    // Also log to browser console
    const consoleFn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "debug"
            ? console.debug
            : console.info;
    consoleFn(`[${tag}] ${sanitizedMessage}`, sanitizedDetail ?? "");

    set((s) => ({
      entries: [...s.entries.slice(-(MAX_ENTRIES - 1)), entry],
    }));
  },

  clear() {
    set({ entries: [] });
  },

  toggle() {
    set((s) => ({ isOpen: !s.isOpen }));
  },

  setOpen(open) {
    set({ isOpen: open });
  },
}));

/** Convenience helpers */
export const debugLog = {
  debug: (tag: string, msg: string, detail?: LogDetail) =>
    useDebugLogStore.getState().push("debug", tag, msg, detail),
  info: (tag: string, msg: string, detail?: LogDetail) =>
    useDebugLogStore.getState().push("info", tag, msg, detail),
  warn: (tag: string, msg: string, detail?: LogDetail) =>
    useDebugLogStore.getState().push("warn", tag, msg, detail),
  error: (tag: string, msg: string, detail?: LogDetail) =>
    useDebugLogStore.getState().push("error", tag, msg, detail),
};

/** Extract a short root-cause message (for toasts) */
export function rootCause(e: unknown): string {
  if (!(e instanceof Error)) return redactSqlParams(String(e));
  let current: unknown = e;
  while (current instanceof Error && current.cause) {
    current = current.cause;
  }
  return current instanceof Error
    ? redactSqlParams(current.message)
    : redactSqlParams(String(current));
}

/** Extract a useful message from an unknown thrown value, including cause chain */
export function errorDetail(e: unknown): string {
  if (!(e instanceof Error)) return redactSqlParams(String(e));

  const includeStack = !isProductionLogMode();
  const describeError = (error: Error, prefix = ""): string => {
    const message = `${prefix}${redactSqlParams(error.message)}`;
    if (!includeStack || !error.stack) return message;
    return `${message}\n${redactSqlParams(error.stack)}`;
  };
  const parts: string[] = [describeError(e)];

  let current: unknown = e.cause;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error) {
      parts.push(describeError(current, "Caused by: "));
      current = current.cause;
    } else {
      parts.push(`Caused by: ${redactSqlParams(String(current))}`);
      break;
    }
    depth++;
  }

  return parts.join("\n");
}
