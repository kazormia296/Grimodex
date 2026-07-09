/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import {
  eventKeyToken,
  formatShortcut,
  isWebKitUA,
  matchesMod,
  shortcutKey,
} from "./platform";

describe("matchesMod", () => {
  it("uses Ctrl on non-macOS", () => {
    expect(matchesMod({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(matchesMod({ ctrlKey: false, metaKey: true }, false)).toBe(false);
  });

  it("uses Meta (⌘) on macOS", () => {
    expect(matchesMod({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    // Plain Control must NOT trigger the primary modifier on macOS.
    expect(matchesMod({ ctrlKey: true, metaKey: false }, true)).toBe(false);
  });
});

describe("shortcutKey", () => {
  it("derives the physical letter from e.code, ignoring composed glyphs", () => {
    // macOS ⌥+S composes "ß" into e.key — e.code stays "KeyS".
    expect(shortcutKey({ code: "KeyS", key: "ß" })).toBe("s");
    expect(shortcutKey({ code: "KeyX", key: "≈" })).toBe("x");
  });

  it("maps punctuation codes", () => {
    expect(shortcutKey({ code: "Comma", key: "≤" })).toBe(",");
    expect(shortcutKey({ code: "Period", key: "≥" })).toBe(".");
  });

  it("falls back to e.key when code is non-letter/empty", () => {
    expect(shortcutKey({ code: "", key: "S" })).toBe("s");
    expect(shortcutKey({ code: "Space", key: " " })).toBe(" ");
    expect(shortcutKey({ key: "F" })).toBe("f");
  });
});

describe("eventKeyToken", () => {
  it("returns uppercase letters from e.code, ignoring composed glyphs", () => {
    expect(eventKeyToken({ code: "KeyS", key: "ß" })).toBe("S");
    expect(eventKeyToken({ code: "KeyF", key: "f" })).toBe("F");
  });
  it("returns digits from e.code", () => {
    expect(eventKeyToken({ code: "Digit1", key: "1" })).toBe("1");
  });
  it("maps named/punctuation codes to canonical tokens", () => {
    expect(eventKeyToken({ code: "Space", key: " " })).toBe("Space");
    expect(eventKeyToken({ code: "Tab", key: "Tab" })).toBe("Tab");
    expect(eventKeyToken({ code: "Comma", key: "," })).toBe(",");
    expect(eventKeyToken({ code: "Backslash", key: "\\" })).toBe("\\");
  });
  it("falls back to e.key for unenumerated codes", () => {
    expect(eventKeyToken({ code: "ArrowUp", key: "ArrowUp" })).toBe("ArrowUp");
  });
});

describe("formatShortcut — non-macOS returns the Windows/Linux form", () => {
  for (const binding of [
    "Ctrl+Alt+S",
    "Ctrl+Shift+F",
    "Ctrl+Shift+Space",
    "Ctrl+Z",
    "Ctrl+Enter",
    "Ctrl+1",
  ]) {
    it(`${binding} unchanged`, () => {
      expect(formatShortcut(binding, false)).toBe(binding);
    });
  }

  it("collapses the Mod and literal Control tokens back to Ctrl", () => {
    expect(formatShortcut("Control+Tab", false)).toBe("Ctrl+Tab");
    expect(formatShortcut("Control+Shift+Tab", false)).toBe("Ctrl+Shift+Tab");
    expect(formatShortcut("Mod+Alt+S", false)).toBe("Ctrl+Alt+S");
    expect(formatShortcut("Mod+F", false)).toBe("Ctrl+F");
  });
});

describe("formatShortcut — macOS canonical order ⌃⌥⇧⌘ + key, no separators", () => {
  const cases: Array<[string, string]> = [
    ["Ctrl+Alt+S", "⌥⌘S"], // Command rendered LAST, after Option
    ["Ctrl+Shift+F", "⇧⌘F"],
    ["Ctrl+Shift+Space", "⇧⌘Space"],
    ["Ctrl+Z", "⌘Z"],
    ["Ctrl+Shift+Z", "⇧⌘Z"],
    ["Ctrl+Enter", "⌘Enter"],
    ["Ctrl+1", "⌘1"],
    ["Ctrl+Alt+,", "⌥⌘,"],
    // Input order must not affect output order.
    ["Shift+Alt+Ctrl+S", "⌥⇧⌘S"],
    // Explicit "Control" stays ⌃ (Tab cycling keeps literal Control on macOS
    // because ⌘Tab is the OS app switcher); "Meta" is also primary ⌘.
    ["Control+Shift+D", "⌃⇧D"],
    ["Control+Tab", "⌃Tab"],
    ["Control+Shift+Tab", "⌃⇧Tab"],
    ["Meta+K", "⌘K"],
    // "Mod" is the primary-modifier token used by the binding registry.
    ["Mod+Alt+S", "⌥⌘S"],
    ["Mod+Shift+Space", "⇧⌘Space"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(formatShortcut(input, true)).toBe(expected);
    });
  }
});

describe("isWebKitUA — WebKit (non-Blink) engine detection", () => {
  // Real WebKit UAs (no "Chrome/" token) → the packaged Tauri webviews we must
  // apply vertical-rl / native-control workarounds to.
  const webkit: Array<[string, string]> = [
    [
      "macOS WKWebView (Tauri)",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    ],
    [
      "Linux WebKitGTK (Tauri)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
    ],
    [
      "iOS Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ],
  ];
  for (const [name, ua] of webkit) {
    it(`${name} → true`, () => expect(isWebKitUA(ua)).toBe(true));
  }

  // Blink engines all carry a Chrome/Chromium/Edg/CriOS token → NOT WebKit.
  const blink: Array<[string, string]> = [
    [
      "Windows WebView2 (Tauri)",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    ],
    [
      "Desktop Chrome (dev / Vitest browser)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ],
    [
      "iOS Chrome (CriOS)",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1",
    ],
  ];
  for (const [name, ua] of blink) {
    it(`${name} → false`, () => expect(isWebKitUA(ua)).toBe(false));
  }
});
