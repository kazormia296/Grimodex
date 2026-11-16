import { describe, expect, it, vi } from "vitest";

import { dispatchInvoke } from "./ipcContract.js";
import type { NapiBackendLike } from "./ipcContract.js";
import {
  AGENT_SETTING_CATALOG,
  agentSettingRange,
} from "./agentSettingCatalog.js";

/**
 * `save_global_settings` は GlobalSettings 全体の read-modify-write で、設定画面の変更も agent の提案の
 * 適用も同じ経路を通る。agent に提案させてよい 15 キーは、保存済みの値から変わったものだけを main で
 * 再検証する（UI の範囲と同じ検証。UI を壊さない）。
 */
function setup(stored: Record<string, string> | undefined) {
  const getGlobalSettings = vi.fn(async () =>
    JSON.stringify(
      stored === undefined ? { uiScale: 100 } : { userPreferences: stored },
    ),
  );
  const saveGlobalSettings = vi.fn(async () => undefined);
  const backend = {
    getGlobalSettings,
    saveGlobalSettings,
  } as unknown as NapiBackendLike;
  const save = (userPreferences: Record<string, string>) =>
    dispatchInvoke(
      "save_global_settings",
      { settings: { uiScale: 100, userPreferences } },
      { backend, shell: {} },
    );
  return { save, getGlobalSettings, saveGlobalSettings };
}

describe("save_global_settings の目録キーの再検証", () => {
  it("UI が書き得る全 step の値と真偽を保存できる（UI を壊さない）", async () => {
    for (const entry of AGENT_SETTING_CATALOG) {
      if (entry.type === "number") {
        const { min, max, step } = agentSettingRange(
          entry.key as Parameters<typeof agentSettingRange>[0],
        );
        const decimals = (String(step).split(".")[1] ?? "").length;
        const count = Math.round((max - min) / step);
        for (let i = 0; i <= count; i++) {
          const written = String(
            parseFloat((min + i * step).toFixed(decimals)),
          );
          const { save, saveGlobalSettings } = setup({});
          expect(await save({ [entry.key]: written })).toMatchObject({
            ok: true,
          });
          expect(
            saveGlobalSettings,
            `${entry.key}=${written}`,
          ).toHaveBeenCalled();
        }
      } else if (entry.type === "boolean") {
        for (const written of ["true", "false"]) {
          const { save, saveGlobalSettings } = setup({});
          expect(await save({ [entry.key]: written })).toMatchObject({
            ok: true,
          });
          expect(saveGlobalSettings).toHaveBeenCalled();
        }
      }
    }
  });

  it("font は CSS font-family として安全な値（システムフォント・旧形式のスタックを含む）を保存できる", async () => {
    for (const value of [
      "serif",
      "monospace",
      '"Noto Serif JP"',
      '"Yu Mincho"',
      '"游明朝"',
      '"Noto Serif JP", serif',
      // システムフォント名にあり得る文字。UI からの保存を main が拒否しない。
      '"A;B"',
      '"Font {Pro}"',
      '"Font <1>"',
      '"Back\\slash"',
    ]) {
      const { save, saveGlobalSettings } = setup({});
      expect(await save({ "editor.fontFamily": value })).toMatchObject({
        ok: true,
      });
      expect(saveGlobalSettings).toHaveBeenCalled();
    }
  });

  it("目録のキーが範囲外・step 外・型違いなら保存せず、理由を返す", async () => {
    for (const [key, value] of [
      ["editor.fontSize", "99"],
      ["editor.fontSize", "18.5"],
      ["editor.fontSize", "abc"],
      ["editor.lineHeight", "1.25"],
      ["editor.maxContentWidth", "700"],
      ["display.codexHighlightOpacity", "30"],
      ["editor.bubbleMenu", "yes"],
      ["editor.fontFamily", "a\nb"],
      ["editor.fontFamily", "x".repeat(201)],
    ] as const) {
      const { save, saveGlobalSettings } = setup({});
      const result = await save({ [key]: value });
      expect(result, `${key}=${value}`).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).toContain(key);
      expect(saveGlobalSettings).not.toHaveBeenCalled();
    }
  });

  it("保存済みの値から変わっていない旧値は、他の設定の保存を妨げない", async () => {
    const { save, saveGlobalSettings } = setup({
      "editor.maxContentWidth": "700",
      "editor.lineHeight": "1.65",
    });
    const result = await save({
      "editor.maxContentWidth": "700",
      "editor.lineHeight": "1.65",
      "editor.fontSize": "20",
    });
    expect(result).toMatchObject({ ok: true });
    expect(saveGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it("目録外のキーと、userPreferences を持たない保存は検証も読み出しもしない（既存の経路は不変）", async () => {
    const outside = setup({});
    expect(
      await outside.save({ "ai.anything": "???", "keys.bindings": "{" }),
    ).toMatchObject({ ok: true });
    expect(outside.getGlobalSettings).not.toHaveBeenCalled();

    const getGlobalSettings = vi.fn();
    const saveGlobalSettings = vi.fn(async () => undefined);
    const result = await dispatchInvoke(
      "save_global_settings",
      { settings: { uiScale: 125 } },
      {
        backend: {
          getGlobalSettings,
          saveGlobalSettings,
        } as unknown as NapiBackendLike,
        shell: {},
      },
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(getGlobalSettings).not.toHaveBeenCalled();
    expect(saveGlobalSettings).toHaveBeenCalledWith({ uiScale: 125 });
  });
});
