/**
 * Platform helpers for keyboard-shortcut display and matching.
 *
 * Grimodex shortcuts are authored in Windows/Linux canonical form
 * ("Ctrl+Alt+S"). On macOS the *primary* modifier is ⌘ (Command), not
 * Control, so both the runtime matcher and the on-screen label must adapt.
 * These helpers are the single source of truth for that adaptation:
 *
 * - {@link matchesMod} — primary-modifier test for keydown handlers.
 * - {@link shortcutKey} — layout-independent key lookup for handlers.
 * - {@link formatShortcut} — renders a binding string for the current OS.
 *
 * Invariant: on non-macOS the behaviour is identical to before this module
 * existed — `matchesMod` is just `e.ctrlKey`, and `formatShortcut` returns
 * the input string unchanged.
 */

/** True when running on macOS (navigator-based; safe outside the browser). */
let isMacCache: boolean | null = null;
export function isMac(): boolean {
  // keydown ハンドラの毎打鍵パスから呼ばれる。プロセス生存中に OS は
  // 変わらないので初回評価をキャッシュする（テストは mac 引数を明示注入
  // するためこのキャッシュを踏まない）。
  if (isMacCache !== null) return isMacCache;
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  isMacCache = /mac/i.test(platform);
  return isMacCache;
}

/**
 * Primary-modifier test: ⌘ on macOS, Ctrl elsewhere.
 *
 * Use this in place of a bare `e.ctrlKey` check so a shortcut authored as
 * "Ctrl+…" fires with Command on macOS. `mac` is injectable for testing.
 */
export function matchesMod(
  e: { ctrlKey: boolean; metaKey: boolean },
  mac = isMac(),
): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

/**
 * Layout-independent shortcut key for an event.
 *
 * On macOS, holding Option (⌥) composes a glyph into `e.key` (e.g. ⌥S → "ß"),
 * which would make a `keyMap[e.key]` lookup silently miss. `e.code` is the
 * physical key position, so derive letter/comma keys from it and fall back to
 * `e.key` for everything else. Returns a lowercase single char where possible.
 */
export function shortcutKey(e: { code?: string; key: string }): string {
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  return e.key.toLowerCase();
}

// Punctuation/whitespace KeyboardEvent.code → canonical key token. Letters and
// digits are handled by regex in eventKeyToken; this covers the rest used by
// bindings (and a few common extras).
const CODE_KEY_TOKEN: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
};

/**
 * Canonical, layout-independent key token for an event — the value that appears
 * as the last segment of a binding string ("S", "1", "Tab", "Space", ",").
 *
 * Like {@link shortcutKey} it reads `e.code` to dodge macOS ⌥ glyph composition,
 * but returns the canonical token form (uppercase letters, named special keys)
 * used by {@link matchesBinding} and the default bindings, rather than a
 * lowercased char. Falls back to `e.key` for anything not enumerated.
 */
export function eventKeyToken(e: { code?: string; key: string }): string {
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_KEY_TOKEN[code] ?? e.key;
}

// Apple's canonical modifier order is ⌃ ⌥ ⇧ ⌘, then the key, with no
// separators. We render flags in this order regardless of input order.
// "Ctrl"/"Mod"/"Cmd"/"Meta" all mean the primary modifier (⌘); only the
// explicit "Control" token maps to ⌃.
const MAC_ORDER: ReadonlyArray<{ symbol: string; tokens: string[] }> = [
  { symbol: "⌃", tokens: ["control"] }, // ⌃
  { symbol: "⌥", tokens: ["alt", "option"] }, // ⌥
  { symbol: "⇧", tokens: ["shift"] }, // ⇧
  { symbol: "⌘", tokens: ["mod", "ctrl", "cmd", "command", "meta"] }, // ⌘
];

/**
 * Render a binding string for the current platform.
 *
 * - Non-macOS: returned unchanged ("Ctrl+Alt+S" stays "Ctrl+Alt+S").
 * - macOS: symbols in canonical order with no separators ("Ctrl+Alt+S" →
 *   "⌥⌘S", "Ctrl+Shift+F" → "⇧⌘F", "Ctrl+Z" → "⌘Z").
 *
 * `mac` is injectable for testing.
 */
export function formatShortcut(binding: string, mac = isMac()): string {
  // Non-macOS: render the Windows/Linux form. The primary-modifier tokens
  // "Mod" (and the literal "Control" used where a shortcut stays Control on
  // macOS, e.g. Tab cycling) both collapse to "Ctrl" here, so Windows/Linux
  // reads "Ctrl+Tab". Bindings already authored as "Ctrl+…" pass through.
  if (!mac) return binding.replace(/\b(?:Mod|Control)\b/g, "Ctrl");

  const parts = binding
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return binding;

  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));

  let out = "";
  for (const entry of MAC_ORDER) {
    if (entry.tokens.some((t) => mods.has(t))) out += entry.symbol;
  }

  // Single alpha keys read better uppercased (⌘S); leave named keys
  // ("Enter", "Space", "Tab") and symbols as-is.
  out += key.length === 1 ? key.toUpperCase() : key;
  return out;
}
