/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  canonicalizeBinding,
  detectConflicts,
  getMergedBindings,
  keyEventToString,
  matchesBinding,
  parseStoredOverrides,
} from "./keybindings";
import { useSettingsStore } from "./settingsStore";

function setStoredBindings(json: string) {
  useSettingsStore.setState((s) => ({
    cache: { ...s.cache, "keys.bindings": json },
  }));
}

interface EvtOpts {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  key?: string;
  code?: string;
}
const ev = (o: EvtOpts) => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  key: "",
  code: "",
  ...o,
});

describe("matchesBinding — primary modifier (Mod)", () => {
  it("non-macOS: Mod = Ctrl", () => {
    expect(
      matchesBinding(
        ev({ ctrlKey: true, code: "KeyF", key: "f" }),
        "Mod+F",
        false,
      ),
    ).toBe(true);
    // ⌘ (meta) must NOT satisfy Mod on Windows/Linux
    expect(
      matchesBinding(
        ev({ metaKey: true, code: "KeyF", key: "f" }),
        "Mod+F",
        false,
      ),
    ).toBe(false);
  });
  it("macOS: Mod = ⌘ (meta), not Control", () => {
    expect(
      matchesBinding(
        ev({ metaKey: true, code: "KeyF", key: "f" }),
        "Mod+F",
        true,
      ),
    ).toBe(true);
    // literal Control must NOT satisfy Mod on macOS
    expect(
      matchesBinding(
        ev({ ctrlKey: true, code: "KeyF", key: "f" }),
        "Mod+F",
        true,
      ),
    ).toBe(false);
  });
});

describe("matchesBinding — literal Control (the asymmetric case)", () => {
  it("macOS: Control = ⌃ (ctrlKey), and ⌘ does NOT match", () => {
    expect(
      matchesBinding(
        ev({ ctrlKey: true, code: "Tab", key: "Tab" }),
        "Control+Tab",
        true,
      ),
    ).toBe(true);
    expect(
      matchesBinding(
        ev({ metaKey: true, code: "Tab", key: "Tab" }),
        "Control+Tab",
        true,
      ),
    ).toBe(false);
  });
  it("non-macOS: Control = Ctrl", () => {
    expect(
      matchesBinding(
        ev({ ctrlKey: true, code: "Tab", key: "Tab" }),
        "Control+Tab",
        false,
      ),
    ).toBe(true);
  });
});

describe("matchesBinding — exact modifier match (no superset firing)", () => {
  it("Ctrl+Shift+S does not trigger Mod+S", () => {
    expect(
      matchesBinding(
        ev({ ctrlKey: true, shiftKey: true, code: "KeyS", key: "S" }),
        "Mod+S",
        false,
      ),
    ).toBe(false);
  });
  it("Alt presence is matched exactly", () => {
    expect(
      matchesBinding(
        ev({ ctrlKey: true, code: "KeyS", key: "s" }),
        "Mod+Alt+S",
        false,
      ),
    ).toBe(false);
    expect(
      matchesBinding(
        ev({ ctrlKey: true, altKey: true, code: "KeyS", key: "s" }),
        "Mod+Alt+S",
        false,
      ),
    ).toBe(true);
  });
});

describe("matchesBinding — key via e.code (macOS ⌥ glyph composition)", () => {
  it("⌥⌘S composes 'ß' into e.key but still matches via code", () => {
    expect(
      matchesBinding(
        ev({ metaKey: true, altKey: true, code: "KeyS", key: "ß" }),
        "Mod+Alt+S",
        true,
      ),
    ).toBe(true);
  });
  it("Space matches the named token", () => {
    expect(
      matchesBinding(
        ev({ metaKey: true, shiftKey: true, code: "Space", key: " " }),
        "Mod+Shift+Space",
        true,
      ),
    ).toBe(true);
  });
});

describe("capture → match round-trip", () => {
  const cases: Array<{
    name: string;
    e: EvtOpts;
    mac: boolean;
    expected: string;
  }> = [
    {
      name: "Win Ctrl+Alt+S",
      e: { ctrlKey: true, altKey: true, code: "KeyS", key: "s" },
      mac: false,
      expected: "Mod+Alt+S",
    },
    {
      name: "mac ⌥⌘S (glyph)",
      e: { metaKey: true, altKey: true, code: "KeyS", key: "ß" },
      mac: true,
      expected: "Mod+Alt+S",
    },
    {
      name: "mac ⌘F",
      e: { metaKey: true, code: "KeyF", key: "f" },
      mac: true,
      expected: "Mod+F",
    },
    {
      name: "mac ⌃Tab (literal Control)",
      e: { ctrlKey: true, code: "Tab", key: "Tab" },
      mac: true,
      expected: "Control+Tab",
    },
    {
      name: "Win Ctrl+Shift+Space",
      e: { ctrlKey: true, shiftKey: true, code: "Space", key: " " },
      mac: false,
      expected: "Mod+Shift+Space",
    },
    {
      name: "mac ⌘\\",
      e: { metaKey: true, code: "Backslash", key: "\\" },
      mac: true,
      expected: "Mod+\\",
    },
  ];
  for (const c of cases) {
    it(`${c.name} → ${c.expected} → matches`, () => {
      const captured = keyEventToString(ev(c.e), c.mac);
      expect(captured).toBe(c.expected);
      expect(matchesBinding(ev(c.e), captured, c.mac)).toBe(true);
    });
  }
});

describe("canonicalizeBinding / detectConflicts", () => {
  it("treats Ctrl/Mod/Cmd/Meta as the same primary modifier", () => {
    expect(canonicalizeBinding("Ctrl+Alt+S")).toBe("Mod+Alt+S");
    expect(canonicalizeBinding("Cmd+Alt+S")).toBe("Mod+Alt+S");
    expect(canonicalizeBinding("Alt+Mod+s")).toBe("Mod+Alt+S");
  });
  it("keeps literal Control distinct from Mod", () => {
    expect(canonicalizeBinding("Control+Tab")).toBe("Control+Tab");
    expect(canonicalizeBinding("Control+Tab")).not.toBe(
      canonicalizeBinding("Mod+Tab"),
    );
  });
  it("flags conflicts across token spellings", () => {
    const bindings = { a: "Mod+Alt+S", b: "Ctrl+Alt+S", c: "Mod+F" };
    const conflicts = detectConflicts(bindings, "a");
    expect(conflicts.map((c) => c.commandId)).toEqual(["b"]);
  });
});

describe("getMergedBindings — store override round-trip (the live wiring)", () => {
  afterEach(() => setStoredBindings("{}"));

  it("defaults apply when no override is stored", () => {
    setStoredBindings("{}");
    expect(getMergedBindings().find).toBe("Mod+F");
  });

  it("a stored override replaces the default and the new combo matches", () => {
    // Simulates: user captures a rebind in KeysCategory → settings store →
    // runtime handler reads getMergedBindings() and matches the event.
    setStoredBindings(JSON.stringify({ find: "Mod+J" }));
    const merged = getMergedBindings();
    expect(merged.find).toBe("Mod+J");
    expect(
      matchesBinding(
        ev({ ctrlKey: true, code: "KeyJ", key: "j" }),
        merged.find ?? "",
        false,
      ),
    ).toBe(true);
    // The old default must no longer fire.
    expect(
      matchesBinding(
        ev({ ctrlKey: true, code: "KeyF", key: "f" }),
        merged.find ?? "",
        false,
      ),
    ).toBe(false);
  });

  it("malformed stored JSON falls back to defaults", () => {
    setStoredBindings("not json");
    expect(getMergedBindings().focusScenes).toBe("Mod+Alt+S");
  });

  // perf 契約: keydown 毎に呼ばれるホットパスなので、rebind が無い限り
  // JSON.parse + spread を再実行しない（同一オブジェクトを返す）。
  // rebind 時は新オブジェクトに切り替わり、即座に実効化する。
  it("memoizes the merged object until keys.bindings changes", () => {
    setStoredBindings(JSON.stringify({ find: "Mod+J" }));
    const a = getMergedBindings();
    const b = getMergedBindings();
    expect(b).toBe(a);

    setStoredBindings(JSON.stringify({ find: "Mod+G" }));
    const c = getMergedBindings();
    expect(c).not.toBe(a);
    expect(c.find).toBe("Mod+G");
  });
});

describe("DEFAULT_KEYBINDINGS", () => {
  it("has no two commands sharing a binding (canonical collision guard)", () => {
    const canon = Object.values(DEFAULT_KEYBINDINGS).map(canonicalizeBinding);
    expect(new Set(canon).size).toBe(canon.length);
  });
});

describe("parseStoredOverrides", () => {
  it("parses a delta object", () => {
    expect(parseStoredOverrides('{"find":"Mod+J"}')).toEqual({ find: "Mod+J" });
  });
  it("falls back to {} on malformed, null, or array JSON", () => {
    expect(parseStoredOverrides("not json")).toEqual({});
    expect(parseStoredOverrides("null")).toEqual({});
    expect(parseStoredOverrides("[1,2]")).toEqual({});
  });
});
