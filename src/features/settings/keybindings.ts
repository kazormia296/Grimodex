import { useMemo } from "react";
import i18next from "i18next";
import type { PanelId } from "@/features/layout/panelIds";
import { eventKeyToken, isMac } from "@/lib/platform";
import { useSettingsStore } from "./settingsStore";

/**
 * Bindings use a canonical token vocabulary shared with `platform.ts`:
 *   "Mod"     — primary modifier (⌘ on macOS, Ctrl on Windows/Linux)
 *   "Control" — literal Control (⌃ on macOS; same physical key as Mod elsewhere)
 *   "Alt" / "Shift" — literal
 *   key segment — canonical key token from {@link eventKeyToken} ("S","1","Tab",",")
 *
 * Capture ({@link keyEventToString}), matching ({@link matchesBinding}) and the
 * default bindings all speak this vocabulary, so a captured combo string is
 * directly comparable to a default and round-trips on every platform.
 */
export interface CommandDef {
  id: string;
  label: string;
  defaultBinding: string;
  /** Focus-toggle commands carry the panel they toggle. */
  panel?: PanelId;
  /**
   * Commands intentionally unavailable on macOS. `findReplace`'s Ctrl+H maps to
   * ⌘H = the system "Hide Application" shortcut, so it is Windows/Linux only.
   */
  macUnavailable?: boolean;
}

export function getCommands(): CommandDef[] {
  return [
    // ── Panel focus / toggle ──
    {
      id: "focusScenes",
      label: i18next.t("keys.focusScenes"),
      defaultBinding: "Mod+Alt+S",
      panel: "scenes",
    },
    {
      id: "focusCodex",
      label: i18next.t("keys.focusCodex"),
      defaultBinding: "Mod+Alt+X",
      panel: "codex",
    },
    {
      id: "focusChatHistory",
      label: i18next.t("keys.focusChatHistory"),
      defaultBinding: "Mod+Alt+H",
      panel: "chat-history",
    },
    {
      id: "focusChat",
      label: i18next.t("keys.focusChat"),
      defaultBinding: "Mod+Alt+C",
      panel: "chat",
    },
    {
      id: "focusSnippets",
      label: i18next.t("keys.focusSnippets"),
      defaultBinding: "Mod+Alt+N",
      panel: "snippets",
    },
    {
      id: "focusAttribution",
      label: i18next.t("keys.focusAttribution"),
      defaultBinding: "Mod+Alt+A",
      panel: "attribution",
    },
    {
      id: "focusCodexQuick",
      label: i18next.t("keys.focusCodexQuick"),
      defaultBinding: "Mod+Alt+Q",
      panel: "codex-quick",
    },
    {
      id: "focusTimeline",
      label: i18next.t("keys.focusTimeline"),
      defaultBinding: "Mod+Alt+L",
      panel: "timeline",
    },
    {
      id: "focusMap",
      label: i18next.t("keys.focusMap"),
      defaultBinding: "Mod+Alt+M",
      panel: "map",
    },
    {
      id: "focusKouetsu",
      label: i18next.t("keys.focusKouetsu"),
      defaultBinding: "Mod+Alt+T",
      panel: "kouetsu",
    },
    {
      id: "focusForeshadow",
      label: i18next.t("keys.focusForeshadow"),
      defaultBinding: "Mod+Alt+F",
      panel: "foreshadow",
    },
    {
      id: "focusTrashBin",
      label: i18next.t("keys.focusTrashBin"),
      defaultBinding: "Mod+Alt+B",
      panel: "trash-bin",
    },
    {
      id: "focusGrid",
      label: i18next.t("keys.focusGrid"),
      defaultBinding: "Mod+Alt+G",
      panel: "grid",
    },
    {
      id: "focusMatrix",
      label: i18next.t("keys.focusMatrix"),
      defaultBinding: "Mod+Alt+R",
      panel: "matrix",
    },
    // ── Global ──
    {
      id: "openSettings",
      label: i18next.t("keys.openSettings"),
      defaultBinding: "Mod+Alt+,",
    },
    {
      id: "splitVertical",
      label: i18next.t("keys.splitVertical"),
      defaultBinding: "Mod+\\",
    },
    {
      id: "splitHorizontal",
      label: i18next.t("keys.splitHorizontal"),
      defaultBinding: "Mod+Shift+\\",
    },
    {
      // Tab cycling stays literal Control on macOS (⌘Tab is the OS app switcher).
      id: "nextTab",
      label: i18next.t("keys.nextTab"),
      defaultBinding: "Control+Tab",
    },
    {
      id: "prevTab",
      label: i18next.t("keys.prevTab"),
      defaultBinding: "Control+Shift+Tab",
    },
    // ── Editor (pane-scoped) ──
    { id: "find", label: i18next.t("keys.find"), defaultBinding: "Mod+F" },
    {
      id: "findReplace",
      label: i18next.t("keys.findReplace"),
      defaultBinding: "Mod+H",
      macUnavailable: true,
    },
    { id: "save", label: i18next.t("keys.save"), defaultBinding: "Mod+S" },
    {
      id: "inlineAiPalette",
      label: i18next.t("keys.inlineAiPalette"),
      defaultBinding: "Mod+Shift+Space",
    },
  ];
}

export const DEFAULT_KEYBINDINGS: Record<string, string> = Object.fromEntries(
  getCommands().map((c) => [c.id, c.defaultBinding]),
);

/** panel id → command id, for resolving a panel's current binding for display. */
export const PANEL_COMMAND_ID: Partial<Record<PanelId, string>> =
  Object.fromEntries(
    getCommands().flatMap((c) => (c.panel ? [[c.panel, c.id]] : [])),
  );

/**
 * Focus-toggle commands as { panel, id } pairs. Built once at module load (no
 * per-call i18n), so the global keydown handler can iterate it on the hot
 * typing path without re-running getCommands()'s label lookups every keystroke.
 */
export const PANEL_COMMANDS: { panel: PanelId; id: string }[] =
  getCommands().flatMap((c) => (c.panel ? [{ panel: c.panel, id: c.id }] : []));

interface KeyboardLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
}

interface ParsedBinding {
  /** primary modifier (Mod/Ctrl/Cmd/Command/Meta tokens) */
  mod: boolean;
  /** literal Control token */
  control: boolean;
  alt: boolean;
  shift: boolean;
  /** canonical key token (not lowercased) */
  key: string;
}

const MOD_TOKENS = ["mod", "ctrl", "cmd", "command", "meta"];

export function parseBinding(binding: string): ParsedBinding {
  const parts = binding
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  return {
    mod: MOD_TOKENS.some((t) => mods.has(t)),
    control: mods.has("control"),
    alt: mods.has("alt") || mods.has("option"),
    shift: mods.has("shift"),
    key,
  };
}

/**
 * matchesBinding 用の parse 結果キャッシュ。グローバル keydown ハンドラが
 * 素のタイピング中も registry 全件 (~20 バインディング) を照合するため、
 * split+Set 構築を文字列毎に一度きりへ抑える。キーは merged bindings 由来の
 * 文字列（defaults + ユーザー上書き）で有界。
 */
const parsedBindingCache = new Map<string, ParsedBinding>();
function parseBindingCached(binding: string): ParsedBinding {
  let p = parsedBindingCache.get(binding);
  if (p === undefined) {
    p = parseBinding(binding);
    parsedBindingCache.set(binding, p);
  }
  return p;
}

/** Re-emit a binding in canonical token order, for stable equality comparison. */
export function canonicalizeBinding(binding: string): string {
  const p = parseBinding(binding);
  const out: string[] = [];
  if (p.mod) out.push("Mod");
  if (p.control) out.push("Control");
  if (p.alt) out.push("Alt");
  if (p.shift) out.push("Shift");
  out.push(p.key.length === 1 ? p.key.toUpperCase() : p.key);
  return out.join("+");
}

/**
 * Does a keydown event satisfy a binding string? Modifier flags are matched
 * exactly (so Ctrl+Shift+S does not trigger a Ctrl+S binding). On macOS the
 * primary modifier is ⌘ (metaKey) and "Control" is the distinct ⌃ (ctrlKey);
 * on Windows/Linux both map to ctrlKey. `mac` is injectable for testing.
 */
export function matchesBinding(
  e: KeyboardLike,
  binding: string,
  mac = isMac(),
): boolean {
  const p = parseBindingCached(binding);
  if (!p.key) return false;
  const needMeta = mac ? p.mod : false;
  const needCtrl = mac ? p.control : p.mod || p.control;
  if (e.metaKey !== needMeta) return false;
  if (e.ctrlKey !== needCtrl) return false;
  if (e.altKey !== p.alt) return false;
  if (e.shiftKey !== p.shift) return false;
  return eventKeyToken(e).toLowerCase() === p.key.toLowerCase();
}

/**
 * Capture a keydown as a canonical binding string. The primary modifier is
 * recorded as "Mod" (portable across platforms), a distinct ⌃ on macOS as
 * "Control", and the key via {@link eventKeyToken} (so ⌥-composed glyphs and
 * Space round-trip). `mac` is injectable for testing.
 */
export function keyEventToString(e: KeyboardLike, mac = isMac()): string {
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (mac && e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(eventKeyToken(e));
  return parts.join("+");
}

/** Parse the stored override delta JSON, tolerating malformed values. */
export function parseStoredOverrides(stored: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Merged bindings (defaults + stored overrides), read synchronously.
 *
 * グローバル/ペインの keydown ハンドラ計3箇所から素のタイピング中も毎打鍵
 * 呼ばれるため、stored 文字列をキーにメモ化する（settingsStore.cache の値は
 * set されるまで同一参照なので比較は実質ポインタ比較）。JSON.parse + 全キー
 * spread は rebind 時のみ。戻り値は共有されるので呼び出し側で変更しないこと。
 */
let mergedBindingsStoredKey: string | null = null;
let mergedBindingsCache: Record<string, string> | null = null;
export function getMergedBindings(): Record<string, string> {
  const stored = useSettingsStore.getState().get("keys.bindings", "{}");
  if (mergedBindingsCache === null || stored !== mergedBindingsStoredKey) {
    mergedBindingsStoredKey = stored;
    mergedBindingsCache = {
      ...DEFAULT_KEYBINDINGS,
      ...parseStoredOverrides(stored),
    };
  }
  return mergedBindingsCache;
}

/** Reactive merged bindings for display in React components. */
export function useMergedBindings(): Record<string, string> {
  const stored = useSettingsStore((s) => s.cache["keys.bindings"] ?? "{}");
  return useMemo(
    () => ({ ...DEFAULT_KEYBINDINGS, ...parseStoredOverrides(stored) }),
    [stored],
  );
}

export interface ConflictInfo {
  commandId: string;
  binding: string;
}

export function detectConflicts(
  bindings: Record<string, string>,
  excludeId: string,
): ConflictInfo[] {
  const target = bindings[excludeId];
  if (!target) return [];
  const targetCanon = canonicalizeBinding(target);
  return Object.entries(bindings)
    .filter(
      ([id, b]) => id !== excludeId && canonicalizeBinding(b) === targetCanon,
    )
    .map(([id, b]) => ({ commandId: id, binding: b }));
}
