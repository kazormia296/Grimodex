import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "./settingsStore";
import {
  bundledFontFamilyFromCssValue,
  installSelectedBundledFontLoading,
} from "./bundledFontLoader";

const initialState = useSettingsStore.getState();

afterEach(() => {
  useSettingsStore.setState(initialState, true);
});

describe("bundledFontFamilyFromCssValue", () => {
  it.each([
    ['"Noto Serif JP", serif', "Noto Serif JP"],
    ['"M PLUS 1"', "M PLUS 1"],
    ['"LINE Seed JP", sans-serif', "LINE Seed JP"],
    ['"Gen Interface JP"', "Gen Interface JP"],
    ['"Literata", serif', "Literata"],
  ] as const)("resolves %s", (value, expected) => {
    expect(bundledFontFamilyFromCssValue(value)).toBe(expected);
  });

  it("ignores system-only font stacks", () => {
    expect(bundledFontFamilyFromCssValue("system-ui, sans-serif")).toBeNull();
  });
});

describe("installSelectedBundledFontLoading", () => {
  it("loads the UI, editor, and explicitly selected Codex title families when already hydrated", () => {
    useSettingsStore.setState((state) => ({
      ...state,
      isLoaded: true,
      cache: {
        ...state.cache,
        "display.uiFontFamily": '"M PLUS 1"',
        "editor.fontFamily": '"Noto Serif JP"',
        "codex.entryTitleFont": '"LINE Seed JP"',
      },
    }));
    const loadFont = vi.fn((_cssValue: string) => null);

    const unsubscribe = installSelectedBundledFontLoading(loadFont);

    expect(loadFont).toHaveBeenCalledWith('"M PLUS 1"');
    expect(loadFont).toHaveBeenCalledWith('"Noto Serif JP"');
    expect(loadFont).toHaveBeenCalledWith('"LINE Seed JP"');
    unsubscribe();
  });

  it("waits for hydration instead of loading defaults before persisted custom families", () => {
    const loadFont = vi.fn((_cssValue: string) => null);
    const unsubscribe = installSelectedBundledFontLoading(loadFont);

    expect(loadFont).not.toHaveBeenCalled();

    useSettingsStore.setState((state) => ({
      ...state,
      isLoaded: true,
      cache: {
        ...state.cache,
        "display.uiFontFamily": '"LINE Seed JP"',
        "editor.fontFamily": '"Literata"',
        "codex.entryTitleFont": '"Gen Interface JP"',
      },
    }));

    expect(loadFont.mock.calls.map(([value]) => value)).toEqual([
      '"LINE Seed JP"',
      '"Literata"',
      '"Gen Interface JP"',
    ]);
    expect(loadFont).not.toHaveBeenCalledWith('"M PLUS 1"');
    expect(loadFont).not.toHaveBeenCalledWith('"Noto Serif JP"');
    unsubscribe();
  });

  it("observes later Codex title font changes without re-requesting unchanged families", () => {
    useSettingsStore.setState((state) => ({
      ...state,
      isLoaded: true,
      cache: {
        ...state.cache,
        "display.uiFontFamily": '"LINE Seed JP"',
        "editor.fontFamily": '"Literata"',
        "codex.entryTitleFont": "",
      },
    }));
    const loadFont = vi.fn((_cssValue: string) => null);
    const unsubscribe = installSelectedBundledFontLoading(loadFont);
    loadFont.mockClear();

    useSettingsStore.setState((state) => ({
      ...state,
      cache: {
        ...state.cache,
        "codex.entryTitleFont": '"Gen Interface JP"',
      },
    }));

    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(loadFont).toHaveBeenCalledWith('"Gen Interface JP"');
    unsubscribe();
  });
});
