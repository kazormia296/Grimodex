// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const policy = vi.hoisted(() => ({ chatOff: false }));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: (feature: string) =>
    feature === "chat" ? policy.chatOff : false,
  isAiFeatureBlockedByPolicy: (feature: string) =>
    feature === "chat" ? policy.chatOff : false,
}));
const fonts = vi.hoisted(() => ({ system: ["Yu Mincho"] as string[] }));
vi.mock("@/features/settings/hooks/useSystemFonts", () => ({
  fetchSystemFonts: async () => fonts.system,
}));
vi.mock("../contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
  countTokens: (s: string) => (s ? s.length : 0),
}));
// 永続化の到達先（この試験は renderer の状態だけを見る）。
vi.mock("@/features/settings/api", () => ({
  getSettingsByPrefix: vi.fn(async () => ({})),
  getAllProjectSettings: vi.fn(async () => ({})),
  setProjectSetting: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
}));
vi.mock("@/lib/globalSettings/repository", () => ({
  globalSettingsRepository: {
    read: vi.fn(async () => ({ userPreferences: {} })),
    write: vi.fn(async () => {}),
    updateUserPreference: vi.fn(async () => {}),
  },
}));

import { AGENT_SETTING_KEYS } from "@/../electron/shared/agentSettingCatalog";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import {
  AGENT_TOOL_MANIFEST,
  HERMES_ALLOWED_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
} from "./toolManifest";
import { AGENT_TOOLS } from "./toolDefinitions";
import {
  MAX_SETTING_REASON_LENGTH,
  proposeSettingChangeTool,
} from "./settingProposalTools";

function snapshotRuntime() {
  return JSON.stringify({
    cache: useSettingsStore.getState().cache,
    layers: useSettingsStore.getState().layers,
    pending: [...useSettingsStore.getState()._pending.keys()],
    cursor: {
      focus: useCursorSettingsStore.getState().focusMode,
      type: useCursorSettingsStore.getState().typewriterMode,
    },
    codex: useCodexHighlightStore.getState().enabled,
  });
}

beforeEach(() => {
  policy.chatOff = false;
  fonts.system = ["Yu Mincho"];
  useSettingsStore.setState({
    cache: { ...DEFAULT_SETTINGS },
    layers: { legacy: {}, project: {}, global: {} },
  });
  useSettingsStore.getState()._pending.clear();
  useCursorSettingsStore.setState({ focusMode: false, typewriterMode: false });
  useCodexHighlightStore.setState({ enabled: true });
});

describe("propose_setting_change", () => {
  it("正しい提案は検証済みの提案を返し、設定は一切変えない", async () => {
    const before = snapshotRuntime();
    const result = await proposeSettingChangeTool({
      key: "editor.fontSize",
      value: "20",
      reason: "読みやすくするため",
    });
    expect(result.error).toBeUndefined();
    expect(result.settingProposal).toMatchObject({
      key: "editor.fontSize",
      value: "20",
      reason: "読みやすくするため",
    });
    expect(result.settingProposal!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshotRuntime()).toBe(before);
    expect(useSettingsStore.getState().get("editor.fontSize")).toBe("18");
  });

  it("自動適用の設定があっても自動で適用しない", async () => {
    useSettingsStore.setState({
      cache: {
        ...DEFAULT_SETTINGS,
        "ai.autoAcceptBodyProposals": "true",
        "ai.autoAcceptKnowledgeProposals": "true",
      },
    });
    const before = snapshotRuntime();
    const result = await proposeSettingChangeTool({
      key: "editor.typewriterMode",
      value: "true",
    });
    expect(result.settingProposal).toBeDefined();
    expect(snapshotRuntime()).toBe(before);
    expect(useCursorSettingsStore.getState().typewriterMode).toBe(false);
  });

  it("モデルに返す内容は、設定は変わっていないことを伝え、現在値と提案の id を含まない", async () => {
    useSettingsStore.setState({
      cache: { ...DEFAULT_SETTINGS, "editor.fontSize": "SENTINEL-CURRENT-91" },
    });
    const result = await proposeSettingChangeTool({
      key: "editor.fontSize",
      value: 20,
    });
    const content = JSON.stringify(result.content);
    expect(content).toContain("NOT been changed");
    expect(content).not.toContain("SENTINEL-CURRENT-91");
    expect(content).not.toContain(result.settingProposal!.id);
  });

  it('number／"true" の文字列を保存形式へ正規化して提案する', async () => {
    const result = await proposeSettingChangeTool({
      key: "editor.lineHeight",
      value: 1.8,
    });
    expect(result.settingProposal!.value).toBe("1.8");
    const toggle = await proposeSettingChangeTool({
      key: "display.reduceMotion",
      value: true,
    });
    expect(toggle.settingProposal!.value).toBe("true");
  });

  it("目録に無いキーは error（提案なし）。許可キーの一覧と案内を返す", async () => {
    for (const key of [
      "ai.apiKey",
      "ai.endpoint",
      "ai.autoAcceptBodyProposals",
      "editor.zenMode",
      "keys.bindings",
      "display.uiScale",
      "__proto__",
      undefined,
    ]) {
      const result = await proposeSettingChangeTool({ key, value: "true" });
      expect(result.error, String(key)).toBeTruthy();
      expect(result.settingProposal).toBeUndefined();
      expect((result.content as { allowedKeys: string[] }).allowedKeys).toEqual(
        [...AGENT_SETTING_KEYS],
      );
    }
  });

  it("範囲外・step 外・選択肢外・型違いは error（丸めない・提案なし）", async () => {
    const cases: Array<[string, unknown]> = [
      ["editor.fontSize", 99],
      ["editor.fontSize", 18.5],
      ["editor.fontSize", "big"],
      ["editor.lineHeight", 1.25],
      ["editor.maxContentWidth", 700],
      ["editor.paragraphSpacing", 5],
      ["display.codexHighlightOpacity", 30],
      ["editor.bubbleMenu", "yes"],
      ["editor.bubbleMenu", 1],
      ["editor.fontFamily", "Comic Sans MS"],
      ["editor.fontFamily", '"Not Installed"'],
      ["editor.fontFamily", ""],
      ["editor.fontSize", undefined],
    ];
    for (const [key, value] of cases) {
      const before = snapshotRuntime();
      const result = await proposeSettingChangeTool({ key, value });
      expect(result.error, `${key}=${String(value)}`).toBeTruthy();
      expect(result.settingProposal).toBeUndefined();
      expect(snapshotRuntime()).toBe(before);
    }
  });

  it("editor.fontFamily は FontFamilySelect の選択肢だけ（同梱・基本・システム）", async () => {
    for (const value of [
      "serif",
      "monospace",
      '"Literata"',
      '"Noto Serif JP"',
      '"Yu Mincho"',
    ]) {
      const result = await proposeSettingChangeTool({
        key: "editor.fontFamily",
        value,
      });
      expect(result.error, value).toBeUndefined();
      expect(result.settingProposal!.value).toBe(value);
    }
    fonts.system = [];
    expect(
      (
        await proposeSettingChangeTool({
          key: "editor.fontFamily",
          value: '"Yu Mincho"',
        })
      ).error,
    ).toBeTruthy();
  });

  it("エラー文にシステムフォントの一覧を載せない", async () => {
    fonts.system = ["SENTINEL-FONT-A", "SENTINEL-FONT-B"];
    const result = await proposeSettingChangeTool({
      key: "editor.fontFamily",
      value: '"Nope"',
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL-FONT");
  });

  it("理由は文字列だけ受け、長すぎれば切る", async () => {
    const long = await proposeSettingChangeTool({
      key: "editor.fontSize",
      value: "20",
      reason: "あ".repeat(500),
    });
    expect(long.settingProposal!.reason).toHaveLength(
      MAX_SETTING_REASON_LENGTH,
    );
    const nonString = await proposeSettingChangeTool({
      key: "editor.fontSize",
      value: "20",
      reason: { text: "x" },
    });
    expect(nonString.settingProposal!.reason).toBeUndefined();
  });

  it("AI ポリシーの chat が off なら拒否する（提案なし・設定は不変）", async () => {
    policy.chatOff = true;
    const before = snapshotRuntime();
    const result = await proposeSettingChangeTool({
      key: "editor.fontSize",
      value: "20",
    });
    expect(result.error).toContain("policy is off");
    expect(result.settingProposal).toBeUndefined();
    expect(snapshotRuntime()).toBe(before);
  });
});

describe("propose_setting_change の manifest・定義", () => {
  const entry = AGENT_TOOL_MANIFEST.find(
    (tool) => tool.name === "propose_setting_change",
  );

  it("write・policy chat・agent と native だけ（hermes なし）・確認あり", () => {
    expect(entry).toEqual({
      name: "propose_setting_change",
      capability: "write",
      requiredPolicy: "chat",
      allowedChannels: ["agent", "native"],
      requiresUserConfirmation: true,
    });
    expect(entry!.allowedChannels).not.toContain("hermes");
    expect(MUTATING_TOOL_NAMES.has("propose_setting_change")).toBe(true);
    expect(HERMES_ALLOWED_TOOL_NAMES).not.toContain("propose_setting_change");
  });

  it("入力 schema は key（目録の enum）・value・reason で、key と value が必須", () => {
    const tool = AGENT_TOOLS.find(
      (candidate) => candidate.name === "propose_setting_change",
    )!;
    expect(tool.inputSchema.required).toEqual(["key", "value"]);
    expect(tool.inputSchema.properties.key!.enum).toEqual([
      ...AGENT_SETTING_KEYS,
    ]);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      "key",
      "reason",
      "value",
    ]);
    // 設定は変えず、適用は利用者だと説明している。秘密・送信先は出さない。
    expect(tool.description).toContain("does NOT change anything");
    expect(tool.description).toContain("only the user's click applies it");
    expect(tool.description).not.toMatch(/api key.*can be proposed/i);
  });
});
