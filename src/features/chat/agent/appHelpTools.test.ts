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

  it("載っていない語は 0 件で、機能が存在しないとは断定しない案内を返す", async () => {
    const result = await getAppHelpIndexTool({
      query: "ブロックチェーン",
    });
    const content = result.content as { total: number; hint?: string };
    expect(content.total).toBe(0);
    expect(content.hint).toContain("help does not cover it");
    expect(content.hint).toContain("do not claim the feature does not exist");
    expect(content.hint).not.toMatch(/tell the user it does not exist/i);
  });

  it("「スナップショット」は無関係な項目を返さず、0 件の案内も断定しない", async () => {
    const result = await getAppHelpIndexTool({ query: "スナップショット" });
    const content = result.content as {
      total: number;
      items: unknown[];
      hint?: string;
    };
    expect(content.total).toBe(0);
    expect(content.items).toEqual([]);
    expect(content.hint).toContain("do not claim the feature does not exist");
  });

  it("長すぎる query は error（索引を引かない）", async () => {
    const result = await getAppHelpIndexTool({ query: "あ".repeat(201) });
    expect(result.error).toContain("too long");
    expect(
      (await getAppHelpIndexTool({ query: "あ".repeat(200) })).error,
    ).toBeUndefined();
  });

  it("未知の kind を summary に写すときは切り詰める", async () => {
    const result = await getAppHelpIndexTool({ kind: "x".repeat(5000) });
    expect(result.error).toContain("Unknown kind");
    expect(result.summary.length).toBeLessThan(120);
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
    const long = await getAppHelpTool({ id: `command:${"a".repeat(5000)}` });
    expect(long.error).toContain("too long");
    expect(long.summary.length).toBeLessThan(120);
    const unknown = await getAppHelpTool({ id: `command:${"b".repeat(150)}` });
    expect(unknown.error).toContain("Unknown help id");
    expect(unknown.error!.length).toBeLessThan(120);
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
