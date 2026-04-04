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

/** Extract a useful message from an unknown thrown value */
export function errorDetail(e: unknown): string {
  if (e instanceof Error) return `${e.message}\n${e.stack ?? ""}`;
  return String(e);
}
