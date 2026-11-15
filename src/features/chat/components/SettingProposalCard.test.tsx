// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}${JSON.stringify(options)}` : key,
  }),
}));
const fonts = vi.hoisted(() => ({ system: ["Yu Mincho"] as string[] }));
vi.mock("@/features/settings/hooks/useSystemFonts", () => ({
  fetchSystemFonts: async () => fonts.system,
}));
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

import { AGENT_SETTING_CATALOG } from "@/../electron/shared/agentSettingCatalog";
import { acquireQuiescenceLease } from "@/application/lifecycle/quiescenceLease";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import ja from "@/locales/ja.json";
import en from "@/locales/en.json";
import type { SettingProposal } from "../agent/agentTypes";
import { useSettingProposalStore } from "../agent/settingProposalStore";
import { SettingProposalCard } from "./SettingProposalCard";

function setting(key: string): string {
  return useSettingsStore.getState().get(key);
}

function proposalOf(
  key: string,
  value: string,
  extra: Partial<SettingProposal> = {},
): SettingProposal {
  return { id: `p-${key}-${value}`, key, value, ...extra };
}

beforeEach(() => {
  fonts.system = ["Yu Mincho"];
  useSettingsStore.setState({
    cache: { ...DEFAULT_SETTINGS },
    layers: { legacy: {}, project: {}, global: {} },
  });
  useSettingsStore.getState()._pending.clear();
  useSettingProposalStore.setState({ outcomes: {} });
  useCursorSettingsStore.setState({ focusMode: false, typewriterMode: false });
  useCodexHighlightStore.setState({ enabled: true });
});

afterEach(() => {
  cleanup();
  // 保存の debounce timer を残さない。
  for (const timer of useSettingsStore.getState()._timers.values()) {
    clearTimeout(timer);
  }
  useSettingsStore.getState()._timers.clear();
});

describe("SettingProposalCard", () => {
  it("設定名・今の値→提案の値・理由を出し、表示だけでは設定を変えない", () => {
    render(
      <SettingProposalCard
        proposal={proposalOf("editor.fontSize", "20", { reason: "読みやすく" })}
      />,
    );
    expect(screen.getByText("settings.editor.fontSize")).toBeInTheDocument();
    expect(screen.getByTestId("setting-proposal-before")).toHaveTextContent(
      "18px",
    );
    expect(screen.getByTestId("setting-proposal-after")).toHaveTextContent(
      "20px",
    );
    expect(screen.getByText(/読みやすく/)).toBeInTheDocument();
    expect(screen.getByText("chat.settingProposal.apply")).toBeInTheDocument();
    expect(setting("editor.fontSize")).toBe("18");
  });

  it("「適用」で変わり、「元に戻す」で前の値へ戻る", async () => {
    render(
      <SettingProposalCard proposal={proposalOf("editor.fontSize", "20")} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("chat.settingProposal.apply"));
    });
    expect(setting("editor.fontSize")).toBe("20");
    expect(
      screen.getByText("chat.settingProposal.applied"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("setting-proposal-before")).toHaveTextContent(
      "18px",
    );
    fireEvent.click(screen.getByText("chat.settingProposal.undo"));
    expect(setting("editor.fontSize")).toBe("18");
    expect(
      screen.getByText("chat.settingProposal.reverted"),
    ).toBeInTheDocument();
  });

  it("「却下」では設定を変えず、適用のボタンも消える", () => {
    render(
      <SettingProposalCard proposal={proposalOf("editor.fontSize", "20")} />,
    );
    fireEvent.click(screen.getByText("chat.settingProposal.dismiss"));
    expect(setting("editor.fontSize")).toBe("18");
    expect(screen.queryByText("chat.settingProposal.apply")).toBeNull();
    expect(
      screen.getByText("chat.settingProposal.dismissed"),
    ).toBeInTheDocument();
  });

  it("適用後に利用者が別の値へ変えたら、「元に戻す」は出ない（新しい値を上書きしない）", async () => {
    render(
      <SettingProposalCard proposal={proposalOf("editor.fontSize", "20")} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("chat.settingProposal.apply"));
    });
    act(() => {
      useSettingsStore.getState().set("editor.fontSize", "22");
    });
    expect(screen.queryByText("chat.settingProposal.undo")).toBeNull();
    expect(
      screen.getByText("chat.settingProposal.changedSince"),
    ).toBeInTheDocument();
    expect(setting("editor.fontSize")).toBe("22");
  });

  it('すでに同じ値なら適用のボタンを出さない（"2" と "2.0" も同じ）', () => {
    render(
      <SettingProposalCard proposal={proposalOf("editor.lineHeight", "2")} />,
    );
    expect(screen.queryByText("chat.settingProposal.apply")).toBeNull();
    expect(
      screen.getByText("chat.settingProposal.alreadySet"),
    ).toBeInTheDocument();
  });

  it("適用の直前に再検証し、壊れた提案（範囲外・目録外）は書かない", async () => {
    // 保存済みの履歴が改ざんされていても、目録外／範囲外ではカードを出さない。
    const { container, rerender } = render(
      <SettingProposalCard proposal={proposalOf("editor.fontSize", "999")} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<SettingProposalCard proposal={proposalOf("ai.apiKey", "x")} />);
    expect(container).toBeEmptyDOMElement();
    // font は形だけ通るカードを出しても、適用時に選択肢で再検証して拒否する。
    rerender(
      <SettingProposalCard
        proposal={proposalOf("editor.fontFamily", '"Not Installed"')}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("chat.settingProposal.apply"));
    });
    expect(setting("editor.fontFamily")).toBe(
      DEFAULT_SETTINGS["editor.fontFamily"],
    );
    expect(screen.getByRole("alert")).toHaveTextContent("applyFailed");
  });

  it("設定が書けない状態（静止中）では適用に失敗を表示し、適用済みにしない", async () => {
    render(
      <SettingProposalCard proposal={proposalOf("editor.fontSize", "20")} />,
    );
    const lease = acquireQuiescenceLease("project-load");
    try {
      await act(async () => {
        fireEvent.click(screen.getByText("chat.settingProposal.apply"));
      });
    } finally {
      lease.release();
    }
    expect(setting("editor.fontSize")).toBe("18");
    expect(screen.getByRole("alert")).toHaveTextContent("applyFailed");
    expect(screen.queryByText("chat.settingProposal.undo")).toBeNull();
    expect(screen.getByText("chat.settingProposal.apply")).toBeInTheDocument();
  });

  it("実行時 store が別に状態を持つ設定は、適用と元に戻すで画面の状態も合わせる", async () => {
    const { rerender } = render(
      <SettingProposalCard proposal={proposalOf("editor.focusMode", "true")} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("chat.settingProposal.apply"));
    });
    expect(useCursorSettingsStore.getState().focusMode).toBe(true);
    fireEvent.click(screen.getByText("chat.settingProposal.undo"));
    expect(useCursorSettingsStore.getState().focusMode).toBe(false);
    expect(setting("editor.focusMode")).toBe("false");

    rerender(
      <SettingProposalCard
        proposal={proposalOf("editor.typewriterMode", "true")}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("chat.settingProposal.apply"));
    });
    expect(useCursorSettingsStore.getState().typewriterMode).toBe(true);

    rerender(
      <SettingProposalCard
        proposal={proposalOf("display.codexHighlight", "false")}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("chat.settingProposal.apply"));
    });
    expect(useCodexHighlightStore.getState().enabled).toBe(false);
    fireEvent.click(screen.getByText("chat.settingProposal.undo"));
    expect(useCodexHighlightStore.getState().enabled).toBe(true);
  });

  it("目録の 16 件それぞれを適用で変更でき、元に戻せる（既存の書込み経路）", async () => {
    const proposals: Record<string, string> = {
      "editor.fontSize": "20",
      "editor.lineHeight": "1.8",
      "editor.maxContentWidth": "800",
      "editor.paragraphSpacing": "12",
      "editor.fontFamily": '"Yu Mincho"',
      "editor.typewriterMode": "true",
      "editor.focusMode": "true",
      "editor.showInvisibles": "true",
      "editor.showStickies": "false",
      "editor.bubbleMenu": "false",
      "editor.autoPairBrackets": "false",
      "editor.smartQuotes": "true",
      "display.showWordCount": "false",
      "display.reduceMotion": "true",
      "display.codexHighlight": "false",
      "display.codexHighlightOpacity": "15",
    };
    expect(Object.keys(proposals).sort()).toEqual(
      AGENT_SETTING_CATALOG.map((entry) => entry.key).sort(),
    );
    for (const [key, value] of Object.entries(proposals)) {
      const original = setting(key);
      cleanup();
      render(<SettingProposalCard proposal={proposalOf(key, value)} />);
      await act(async () => {
        fireEvent.click(screen.getByText("chat.settingProposal.apply"));
      });
      expect(setting(key), key).toBe(value);
      fireEvent.click(screen.getByText("chat.settingProposal.undo"));
      expect(setting(key), key).toBe(original);
    }
  });

  it("chat.settingProposal の文言が ja・en の両方にある", () => {
    const keys = [
      "title",
      "apply",
      "dismiss",
      "undo",
      "applied",
      "dismissed",
      "reverted",
      "alreadySet",
      "changedSince",
      "reason",
      "on",
      "off",
      "applyFailed",
      "undoFailed",
      "aria",
    ];
    for (const locale of [ja, en]) {
      const group = locale.chat.settingProposal as Record<string, string>;
      expect(Object.keys(group).sort()).toEqual([...keys].sort());
      for (const key of keys) expect(group[key]).toBeTruthy();
    }
  });
});
