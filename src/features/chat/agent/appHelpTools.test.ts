// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import {
  getAppHelpIndexTool,
  getAppHelpTool,
  getUiStateTool,
} from "./appHelpTools";

const SENTINEL = "SENTINEL-HELP-TOOL-5b21";

beforeEach(() => {
  useSettingsStore.setState({ cache: { ...DEFAULT_SETTINGS } });
});

describe("get_app_help_index", () => {
  it("索引を 1 項目 1 行（id・title・kind）で返す", async () => {
    const result = await getAppHelpIndexTool({});
    expect(result.error).toBeUndefined();
    const content = result.content as {
      total: number;
      items: Array<{ id: string; title: string; kind: string }>;
    };
    expect(content.total).toBe(content.items.length);
    expect(content.items.length).toBeGreaterThan(40);
    expect(Object.keys(content.items[0]!).sort()).toEqual([
      "id",
      "kind",
      "title",
    ]);
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it("query と kind で絞り込める", async () => {
    const result = await getAppHelpIndexTool({
      query: "分割",
      kind: "command",
    });
    const ids = (result.content as { items: Array<{ id: string }> }).items.map(
      (item) => item.id,
    );
    expect(ids).toContain("command:splitVertical");
    expect(ids.every((id) => id.startsWith("command:"))).toBe(true);
  });

  it("載っていない機能は 0 件と「無いと答える」案内を返す", async () => {
    const result = await getAppHelpIndexTool({
      query: "ブロックチェーン",
    });
    const content = result.content as { total: number; hint?: string };
    expect(content.total).toBe(0);
    expect(content.hint).toContain("not documented");
  });

  it("未知の kind は error", async () => {
    const result = await getAppHelpIndexTool({ kind: "setting" });
    expect(result.error).toContain("Unknown kind");
  });
});

describe("get_app_help", () => {
  it("コマンドの実際のキー割当と OS での可否を返す", async () => {
    const result = await getAppHelpTool({ id: "command:focusChat" });
    expect(result.error).toBeUndefined();
    expect(result.content).toMatchObject({
      kind: "command",
      keys: "Ctrl+Alt+C",
      availableOnThisOS: true,
    });
  });

  it("文書は参照を展開した本文を返す", async () => {
    const result = await getAppHelpTool({ id: "topic:settings.open" });
    const body = (result.content as { body: string }).body;
    expect(body).toContain("Ctrl+Alt+,");
    expect(body).not.toContain("{{");
  });

  it("設定カテゴリは名前と案内だけで、設定の値を返さない", async () => {
    useSettingsStore.setState({
      cache: {
        ...DEFAULT_SETTINGS,
        "ai.apiKey": SENTINEL,
        "ai.endpoint": SENTINEL,
        "editor.fontSize": SENTINEL,
      },
    });
    const result = await getAppHelpTool({ id: "settings:ai" });
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain(SENTINEL);
    expect(result.content).toMatchObject({ kind: "settingsCategory" });
  });

  it("存在しない id は error・近い項目の案内を返す（作られた id は実行しない）", async () => {
    const result = await getAppHelpTool({ id: "command:focusChatt" });
    expect(result.error).toContain("Unknown help id");
    const suggestions = (
      result.content as { suggestions: Array<{ id: string }> }
    ).suggestions;
    expect(suggestions.map((s) => s.id)).toContain("command:focusChat");
    expect((await getAppHelpTool({})).error).toContain("Unknown help id");
    expect((await getAppHelpTool({ id: 42 })).error).toBeTruthy();
  });
});

describe("get_ui_state", () => {
  it("allowlist の項目だけを返し、設定・秘密を含めない", async () => {
    useSettingsStore.setState({
      cache: { ...DEFAULT_SETTINGS, "ai.apiKey": SENTINEL },
    });
    const result = await getUiStateTool();
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.content as object).sort()).toEqual([
      "activeScene",
      "focusedPanel",
      "isPanelWindow",
      "isPhoneWidth",
      "layoutLocked",
      "layoutPreset",
      "maximizedPanel",
      "openOverlay",
      "openPanels",
      "phoneSurface",
      "settings",
      "viewportProfile",
    ]);
    expect(JSON.stringify(result.content)).not.toContain(SENTINEL);
  });
});
