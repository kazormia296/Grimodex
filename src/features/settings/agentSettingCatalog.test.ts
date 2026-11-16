import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_SETTING_CATALOG,
  AGENT_SETTING_KEYS,
  agentSettingRange,
  agentSettingValuesEqual,
  containsAgentSettingKey,
  findInvalidAgentSettingChanges,
  getAgentSettingEntry,
  validateAgentSettingValue,
} from "@/../electron/shared/agentSettingCatalog";
import { BUNDLED_FONTS } from "./bundledFonts";
import { DEFAULT_SETTINGS, KEY_SCOPE, SETTINGS_CATEGORIES } from "./types";
import ja from "@/locales/ja.json";
import en from "@/locales/en.json";

/** ユーザーが承認した 15 件（2026-11-16。showWordCount は読み手が無く効かないので外した）。これ以外は一切受け付けない。 */
const APPROVED_KEYS = [
  "editor.fontSize",
  "editor.lineHeight",
  "editor.maxContentWidth",
  "editor.paragraphSpacing",
  "editor.fontFamily",
  "editor.typewriterMode",
  "editor.focusMode",
  "editor.showInvisibles",
  "editor.showStickies",
  "editor.bubbleMenu",
  "editor.autoPairBrackets",
  "editor.smartQuotes",
  "display.reduceMotion",
  "display.codexHighlight",
  "display.codexHighlightOpacity",
];

function lookup(tree: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      tree,
    );
}

function read(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

describe("目録の内容", () => {
  it("承認済みの 15 キーだけで、すべて global scope", () => {
    expect([...AGENT_SETTING_KEYS].sort()).toEqual([...APPROVED_KEYS].sort());
    expect(new Set(AGENT_SETTING_KEYS).size).toBe(15);
    for (const entry of AGENT_SETTING_CATALOG) {
      expect(entry.scope).toBe("global");
      expect(KEY_SCOPE[entry.key], entry.key).toBe(entry.scope);
      expect(DEFAULT_SETTINGS[entry.key], entry.key).toBeDefined();
    }
  });

  it("カテゴリは設定画面に実在し、label／説明は ja・en の locale にある", () => {
    const categories = SETTINGS_CATEGORIES.map((category) => category.id);
    for (const entry of AGENT_SETTING_CATALOG) {
      expect(categories, entry.key).toContain(entry.categoryId);
      for (const key of [entry.labelKey, entry.descriptionKey]) {
        if (!key) continue;
        expect(typeof lookup(ja, key), `ja ${key}`).toBe("string");
        expect(typeof lookup(en, key), `en ${key}`).toBe("string");
      }
    }
  });

  it("既定値は目録の検証を通る（font は同梱フォント）", () => {
    for (const entry of AGENT_SETTING_CATALOG) {
      const verdict = validateAgentSettingValue(
        entry.key,
        DEFAULT_SETTINGS[entry.key],
        {
          fontFamilies: [
            "serif",
            "monospace",
            ...BUNDLED_FONTS.map((font) => `"${font.family}"`),
          ],
        },
      );
      expect(verdict.ok, `${entry.key}=${DEFAULT_SETTINGS[entry.key]}`).toBe(
        true,
      );
    }
  });

  it("読み手が無く適用しても効かない display.showWordCount は載せない", () => {
    expect(AGENT_SETTING_KEYS).not.toContain("display.showWordCount");
    expect(
      validateAgentSettingValue("display.showWordCount", "true"),
    ).toMatchObject({ ok: false, code: "unknown-key" });
  });

  it("秘密・送信先・provider に関わるキーは載せない", () => {
    for (const key of AGENT_SETTING_KEYS) {
      expect(key).not.toMatch(
        /api|key$|secret|token|endpoint|provider|export/i,
      );
      expect(key).toMatch(/^(editor|display)\./);
    }
  });
});

describe("設定画面の範囲との一致", () => {
  const RANGE_KEYS = [
    "editor.fontSize",
    "editor.lineHeight",
    "editor.maxContentWidth",
    "editor.paragraphSpacing",
    "display.codexHighlightOpacity",
  ] as const;

  it("スライダーは目録と同じ定数から min/max/step を取り、値の直書きが残らない", () => {
    const sources = {
      "categories/EditorCategory.tsx": read(
        "src/features/settings/categories/EditorCategory.tsx",
      ),
      "categories/DisplayCategory.tsx": read(
        "src/features/settings/categories/DisplayCategory.tsx",
      ),
    };
    for (const key of RANGE_KEYS) {
      const source = Object.values(sources).find((text) =>
        text.includes(`settingKey="${key}"`),
      );
      expect(source, key).toBeDefined();
      const block = source!.slice(source!.indexOf(`settingKey="${key}"`));
      const props = block.slice(0, block.indexOf("/>"));
      expect(props, key).toContain(`{...agentSettingRange("${key}")}`);
      expect(props, key).not.toMatch(/\b(min|max|step)=\{/);
    }
    // Layers ポップオーバーの Codex 濃度スライダーも同じ範囲を使う。
    const layers = read("src/features/editor/LayersPopover.tsx");
    expect(layers).toContain(
      '{...agentSettingRange("display.codexHighlightOpacity")}',
    );
  });

  it("スライダーの defaultValue は DEFAULT_SETTINGS と同じ", () => {
    const sources = [
      read("src/features/settings/categories/EditorCategory.tsx"),
      read("src/features/settings/categories/DisplayCategory.tsx"),
    ].join("\n");
    for (const key of RANGE_KEYS) {
      const block = sources.slice(sources.indexOf(`settingKey="${key}"`));
      const match = /defaultValue=\{([\d.]+)\}/.exec(block.slice(0, 400));
      expect(match, key).not.toBeNull();
      expect(Number(match![1]), key).toBe(Number(DEFAULT_SETTINGS[key]));
    }
  });

  it("UI が書き得る全 step の値（<input type=range> の value の parseFloat）を受け入れる", () => {
    for (const key of RANGE_KEYS) {
      const { min, max, step } = agentSettingRange(key);
      const decimals = (String(step).split(".")[1] ?? "").length;
      const count = Math.round((max - min) / step);
      for (let i = 0; i <= count; i++) {
        const uiString = (min + i * step).toFixed(decimals);
        const written = String(parseFloat(uiString)); // SettingSlider → settingsStore.set
        const verdict = validateAgentSettingValue(key, written);
        expect(verdict, `${key}=${written}`).toMatchObject({
          ok: true,
          value: written,
        });
      }
    }
  });

  it("UI の真偽トグルが書く値（String(boolean)）を受け入れる", () => {
    for (const entry of AGENT_SETTING_CATALOG.filter(
      (candidate) => candidate.type === "boolean",
    )) {
      for (const written of ["true", "false"]) {
        expect(validateAgentSettingValue(entry.key, written)).toMatchObject({
          ok: true,
          value: written,
        });
      }
    }
  });
});

describe("validateAgentSettingValue（丸めずに拒否）", () => {
  it("目録に無いキー・継承キー・型違いのキーは拒否", () => {
    for (const key of [
      "ai.apiKey",
      "ai.endpoint",
      "ai.autoAcceptBodyProposals",
      "editor.zenMode",
      "editor.focusModeHideBeats",
      "display.uiScale",
      "__proto__",
      "constructor",
      "toString",
      "",
      "editor.fontSize ",
      " editor.fontSize",
      "EDITOR.FONTSIZE",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(validateAgentSettingValue(key, "1"), String(key)).toMatchObject({
        ok: false,
        code: "unknown-key",
      });
    }
    expect(getAgentSettingEntry("__proto__")).toBeUndefined();
  });

  it("範囲外を拒否（境界は受け入れる）", () => {
    expect(validateAgentSettingValue("editor.fontSize", 14).ok).toBe(true);
    expect(validateAgentSettingValue("editor.fontSize", 24).ok).toBe(true);
    for (const value of [13, 25, 0, -1, 100000]) {
      expect(validateAgentSettingValue("editor.fontSize", value)).toMatchObject(
        { ok: false, code: "out-of-range" },
      );
    }
    expect(validateAgentSettingValue("editor.lineHeight", 1.1)).toMatchObject({
      ok: false,
      code: "out-of-range",
    });
    expect(validateAgentSettingValue("editor.lineHeight", 3.1)).toMatchObject({
      ok: false,
      code: "out-of-range",
    });
    expect(
      validateAgentSettingValue("display.codexHighlightOpacity", 26),
    ).toMatchObject({ ok: false, code: "out-of-range" });
  });

  it("step 外を拒否（丸めない）", () => {
    expect(validateAgentSettingValue("editor.fontSize", 18.5)).toMatchObject({
      ok: false,
      code: "off-step",
    });
    expect(validateAgentSettingValue("editor.lineHeight", 1.25)).toMatchObject({
      ok: false,
      code: "off-step",
    });
    expect(
      validateAgentSettingValue("editor.lineHeight", "2.05"),
    ).toMatchObject({ ok: false, code: "off-step" });
    expect(
      validateAgentSettingValue("editor.maxContentWidth", 700),
    ).toMatchObject({ ok: false, code: "off-step" });
    expect(
      validateAgentSettingValue("editor.paragraphSpacing", 7),
    ).toMatchObject({ ok: false, code: "off-step" });
  });

  it("数値の型違いを拒否（数値か、素直な 10 進の文字列だけ）", () => {
    for (const value of [
      "",
      " 18",
      "18 ",
      "18px",
      "1e1",
      "0x12",
      "+18",
      "-18",
      "NaN",
      "Infinity",
      NaN,
      Infinity,
      -Infinity,
      true,
      null,
      undefined,
      [],
      [18],
      {},
    ]) {
      const verdict = validateAgentSettingValue("editor.fontSize", value);
      expect(verdict.ok, JSON.stringify(value)).toBe(false);
    }
    expect(validateAgentSettingValue("editor.fontSize", "20")).toMatchObject({
      ok: true,
      value: "20",
    });
  });

  it("数値は保存形式（String(number)）へ正規化する", () => {
    expect(validateAgentSettingValue("editor.lineHeight", 1.8)).toMatchObject({
      ok: true,
      value: "1.8",
    });
    expect(validateAgentSettingValue("editor.lineHeight", "2.0")).toMatchObject(
      {
        ok: true,
        value: "2",
      },
    );
    expect(
      validateAgentSettingValue("editor.lineHeight", 1.2 + 0.1 * 3),
    ).toMatchObject({ ok: true, value: "1.5" });
  });

  it('真偽は true／false と "true"／"false" だけ', () => {
    expect(validateAgentSettingValue("editor.bubbleMenu", true)).toMatchObject({
      ok: true,
      value: "true",
    });
    expect(
      validateAgentSettingValue("editor.bubbleMenu", "false"),
    ).toMatchObject({ ok: true, value: "false" });
    for (const value of [
      "TRUE",
      "True",
      "1",
      "0",
      1,
      0,
      "on",
      "yes",
      "",
      " true",
      null,
      undefined,
      [],
    ]) {
      expect(
        validateAgentSettingValue("editor.bubbleMenu", value),
        JSON.stringify(value),
      ).toMatchObject({ ok: false, code: "wrong-type" });
    }
  });

  it("font は選択肢の値と完全一致だけ（選択肢が無ければ拒否）", () => {
    const fontFamilies = ["serif", "monospace", '"Noto Serif JP"'];
    expect(
      validateAgentSettingValue("editor.fontFamily", '"Noto Serif JP"', {
        fontFamilies,
      }),
    ).toMatchObject({ ok: true, value: '"Noto Serif JP"' });
    for (const value of [
      "Noto Serif JP",
      '"noto serif jp"',
      ' "Noto Serif JP"',
      '"Noto Serif JP", serif',
      '"Missing Font"',
      "sans-serif",
      "",
      42,
      null,
    ]) {
      expect(
        validateAgentSettingValue("editor.fontFamily", value, { fontFamilies }),
        JSON.stringify(value),
      ).toMatchObject({ ok: false });
    }
    expect(
      validateAgentSettingValue("editor.fontFamily", "serif"),
    ).toMatchObject({ ok: false, code: "not-an-option" });
  });
});

describe("main の save_global_settings 用の差分検証", () => {
  it("保存済みの値から変わった目録のキーだけを見る", () => {
    // 旧版の範囲外の値（700 は 40 刻みの外）が残っていても、他の値の保存は妨げない。
    const current = {
      "editor.maxContentWidth": "700",
      "editor.fontFamily": '"Noto Serif JP", serif',
      "ai.apiKey": "x",
    };
    expect(
      findInvalidAgentSettingChanges(
        { ...current, "editor.fontSize": "20", theme: "dark" },
        current,
      ),
    ).toEqual([]);
    expect(
      findInvalidAgentSettingChanges(
        { ...current, "editor.fontSize": "99" },
        current,
      ),
    ).toEqual([expect.objectContaining({ key: "editor.fontSize" })]);
    expect(
      findInvalidAgentSettingChanges(
        { ...current, "editor.maxContentWidth": "701" },
        current,
      ).map((entry) => entry.key),
    ).toEqual(["editor.maxContentWidth"]);
    expect(
      findInvalidAgentSettingChanges({ "editor.bubbleMenu": "yes" }, {}).map(
        (entry) => entry.key,
      ),
    ).toEqual(["editor.bubbleMenu"]);
  });

  it("目録外のキーは見ない（他の設定の保存を妨げない）", () => {
    expect(
      findInvalidAgentSettingChanges({ "ai.anything": "???" }, {}),
    ).toEqual([]);
    expect(findInvalidAgentSettingChanges(undefined, undefined)).toEqual([]);
    expect(containsAgentSettingKey({ "ai.anything": "1" })).toBe(false);
    expect(containsAgentSettingKey({ "editor.fontSize": "1" })).toBe(true);
    expect(containsAgentSettingKey(null)).toBe(false);
  });

  it("font は main では形だけを見る（制御文字・区切りを含む値を拒否）", () => {
    for (const value of [
      '"A";color:red',
      "a{b}",
      "a\nb",
      "x".repeat(201),
      "",
    ]) {
      expect(
        findInvalidAgentSettingChanges({ "editor.fontFamily": value }, {}),
        JSON.stringify(value),
      ).toHaveLength(1);
    }
    expect(
      findInvalidAgentSettingChanges(
        { "editor.fontFamily": '"Yu Mincho", "游明朝", serif' },
        {},
      ),
    ).toEqual([]);
  });

  it('数値の同値判定（"2" と "2.0"）', () => {
    expect(agentSettingValuesEqual("editor.lineHeight", "2.0", "2")).toBe(true);
    expect(agentSettingValuesEqual("editor.lineHeight", "2.1", "2")).toBe(
      false,
    );
    expect(agentSettingValuesEqual("editor.bubbleMenu", "true", "true")).toBe(
      true,
    );
  });
});
