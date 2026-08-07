import { describe, it, expect } from "vitest";
import {
  parseUserPresets,
  serializeUserPresets,
  addUserPreset,
  removeUserPreset,
  findUserPreset,
  type UserExportPreset,
} from "./exportUserPresets";
import { DEFAULT_EXPORT_SETTINGS } from "./types";

describe("parseUserPresets / serializeUserPresets", () => {
  it("空文字 → 空配列", () => {
    expect(parseUserPresets("")).toEqual([]);
  });

  it("不正な JSON → 空配列（クラッシュしない）", () => {
    expect(parseUserPresets("INVALID")).toEqual([]);
  });

  it("配列でない JSON → 空配列", () => {
    expect(parseUserPresets('{"foo": "bar"}')).toEqual([]);
  });

  it("有効な配列 → そのまま返す", () => {
    const presets: UserExportPreset[] = [
      {
        id: "user-1",
        name: "私のカクヨム",
        settings: { ...DEFAULT_EXPORT_SETTINGS, exportPresetId: "custom" },
      },
    ];
    const json = serializeUserPresets(presets);
    expect(parseUserPresets(json)).toEqual(presets);
  });

  it("ラウンドトリップで設定値が保持される", () => {
    const settings = {
      ...DEFAULT_EXPORT_SETTINGS,
      format: "markdown" as const,
      rubyStyle: "parentheses" as const,
    };
    const presets: UserExportPreset[] = [{ id: "u1", name: "P1", settings }];
    expect(parseUserPresets(serializeUserPresets(presets))).toEqual(presets);
  });
});

describe("addUserPreset", () => {
  it("新規追加 → 末尾に append、ID は重複しない", () => {
    const existing: UserExportPreset[] = [
      { id: "u1", name: "既存", settings: DEFAULT_EXPORT_SETTINGS },
    ];
    const next = addUserPreset(existing, "新規", DEFAULT_EXPORT_SETTINGS);
    expect(next).toHaveLength(2);
    expect(next[1].name).toBe("新規");
    expect(next[1].id).not.toBe("u1");
  });

  it("名前の前後空白は trim される", () => {
    const next = addUserPreset([], "  Trim me  ", DEFAULT_EXPORT_SETTINGS);
    expect(next[0].name).toBe("Trim me");
  });

  it("保存される settings の exportPresetId は 'custom' に正規化される", () => {
    // ユーザーがビルトイン適用直後の設定をそのまま保存しようとした場合でも、
    // 再選択時に「ユーザープリセット」として識別できるよう custom 化する。
    const fromNarou = {
      ...DEFAULT_EXPORT_SETTINGS,
      exportPresetId: "narou" as const,
    };
    const next = addUserPreset([], "Narou tweaked", fromNarou);
    expect(next[0].settings.exportPresetId).toBe("custom");
  });
});

describe("removeUserPreset", () => {
  it("該当 ID を除去", () => {
    const list: UserExportPreset[] = [
      { id: "u1", name: "A", settings: DEFAULT_EXPORT_SETTINGS },
      { id: "u2", name: "B", settings: DEFAULT_EXPORT_SETTINGS },
    ];
    expect(removeUserPreset(list, "u1")).toEqual([list[1]]);
  });

  it("存在しない ID → そのまま", () => {
    const list: UserExportPreset[] = [
      { id: "u1", name: "A", settings: DEFAULT_EXPORT_SETTINGS },
    ];
    expect(removeUserPreset(list, "non-existent")).toEqual(list);
  });
});

describe("findUserPreset", () => {
  it("ID 一致で返す", () => {
    const list: UserExportPreset[] = [
      { id: "u1", name: "A", settings: DEFAULT_EXPORT_SETTINGS },
    ];
    expect(findUserPreset(list, "u1")?.name).toBe("A");
  });

  it("見つからない → undefined", () => {
    expect(findUserPreset([], "u1")).toBeUndefined();
  });
});

describe("legacy user preset migration", () => {
  it("fills a missing paragraphIndent with the backwards-compatible default", () => {
    const json = JSON.stringify([
      {
        id: "legacy",
        name: "旧プリセット",
        settings: {
          ...DEFAULT_EXPORT_SETTINGS,
          format: "markdown",
          exportPresetId: "custom",
          paragraphIndent: undefined,
        },
      },
    ]);
    const [preset] = parseUserPresets(json);
    expect(preset.settings.format).toBe("markdown");
    expect(preset.settings.paragraphIndent).toBe("none");
  });
});
