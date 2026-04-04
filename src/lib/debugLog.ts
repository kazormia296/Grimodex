import { create } from "zustand";

export type LogLevel = "debug" | "info" | "warn" | "error";

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
    detail?: string,
  ) => void;
  clear: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

export const useDebugLogStore = create<DebugLogState>()((set) => ({
  entries: [],
  isOpen: false,

  push(level, tag, message, detail) {
    const entry: LogEntry = {
      id: nextId++,
      level,
      tag,
      message,
      detail,
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
    consoleFn(`[${tag}] ${message}`, detail ?? "");

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
  debug: (tag: string, msg: string, detail?: string) =>
    useDebugLogStore.getState().push("debug", tag, msg, detail),
  info: (tag: string, msg: string, detail?: string) =>
    useDebugLogStore.getState().push("info", tag, msg, detail),
  warn: (tag: string, msg: string, detail?: string) =>
    useDebugLogStore.getState().push("warn", tag, msg, detail),
  error: (tag: string, msg: string, detail?: string) =>
    useDebugLogStore.getState().push("error", tag, msg, detail),
};

/** Extract a short root-cause message (for toasts) */
export function rootCause(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  let current: unknown = e;
  while (current instanceof Error && current.cause) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
}

/**
 * Redact the "params:" line in DrizzleQueryError messages to prevent
 * content (novel text, Codex entries, etc.) from leaking into logs.
 */
function redactParams(message: string): string {
  return message.replace(
    /^(params:\s*)(.*)$/m,
    (_match, prefix: string, paramStr: string) => {
      const params = paramStr.split(",");
      const redacted = params.map((p) => {
        const trimmed = p.trim();
        return trimmed.length > 60
          ? trimmed.slice(0, 40) + "…[redacted]"
          : trimmed;
      });
      return prefix + redacted.join(", ");
    },
  );
}

/** Extract a useful message from an unknown thrown value, including cause chain */
export function errorDetail(e: unknown): string {
  if (!(e instanceof Error)) return redactParams(String(e));

  const parts: string[] = [`${redactParams(e.message)}\n${e.stack ?? ""}`];

  let current: unknown = e.cause;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error) {
      parts.push(
        `Caused by: ${redactParams(current.message)}\n${current.stack ?? ""}`,
      );
      current = current.cause;
    } else {
      parts.push(`Caused by: ${redactParams(String(current))}`);
      break;
    }
    depth++;
  }

  return parts.join("\n");
}
