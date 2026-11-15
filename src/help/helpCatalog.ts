/**
 * 実行中のコードが持つ「事実」（コマンド・パネル・設定カテゴリ・プリセット）の読み取り口。
 * 正本は各 feature にあり、ここは読むだけで二重に持たない。
 * 設定の値は読まない（読むのはキー割当の上書き `keys.bindings` だけ。getMergedBindings 経由）。
 */
import i18next from "@/lib/i18n";
import {
  DEFAULT_KEYBINDINGS,
  PANEL_COMMAND_ID,
  getCommands,
  getMergedBindings,
} from "@/features/settings/keybindings";
import { SETTINGS_CATEGORIES } from "@/features/settings/types";
import { TOOL_WINDOW_PANEL_IDS } from "@/features/layout/toolWindowDefaults";
import type { PanelId } from "@/features/layout/panelIds";
import { getBuiltinPresets } from "@/features/layout/layoutPresets";
import { useLicenseStore } from "@/features/license/store";
import { formatShortcut, isMac } from "@/lib/platform";

export interface HelpCommandFacts {
  id: string;
  label: string;
  /** locales の help.commands.<id>。無ければ null（試験で欠けを落とす） */
  description: string | null;
  defaultBinding: string;
  /** 既定の割当の、今の OS の表記 */
  defaultDisplay: string | null;
  /** ユーザーの上書きを反映した現在の割当。未割当は null */
  binding: string | null;
  /** 今の OS の表記（Windows/Linux は Ctrl+…、macOS は ⌥⌘S のような記号） */
  display: string | null;
  customized: boolean;
  macUnavailable: boolean;
  /** 今の OS でこのコマンドが使えるか */
  availableOnThisOS: boolean;
  panel: PanelId | null;
}

export function currentOs(): "macOS" | "Windows/Linux" {
  return isMac() ? "macOS" : "Windows/Linux";
}

export function commandFacts(id: string): HelpCommandFacts | null {
  const command = getCommands().find((candidate) => candidate.id === id);
  if (!command) return null;
  const merged = getMergedBindings();
  const mac = isMac();
  const binding = merged[command.id] ? merged[command.id]! : null;
  const descriptionKey = `help.commands.${command.id}`;
  return {
    id: command.id,
    label: command.label,
    description: i18next.exists(descriptionKey)
      ? i18next.t(descriptionKey)
      : null,
    defaultBinding: command.defaultBinding,
    defaultDisplay: command.defaultBinding
      ? formatShortcut(command.defaultBinding, mac)
      : null,
    binding,
    display: binding ? formatShortcut(binding, mac) : null,
    customized: binding !== (DEFAULT_KEYBINDINGS[command.id] ?? null),
    macUnavailable: command.macUnavailable === true,
    availableOnThisOS: !(command.macUnavailable === true && mac),
    panel: command.panel ?? null,
  };
}

export function allCommandIds(): string[] {
  return getCommands().map((command) => command.id);
}

/** 実行時のパネル一覧。PanelId は型だけなので、登録済みの tool window と editor から作る。 */
export function allPanelIds(): PanelId[] {
  return ["editor", ...TOOL_WINDOW_PANEL_IDS];
}

export function panelTitle(id: PanelId): string {
  return i18next.t(`layout.panel.${id}`);
}

export function focusCommandOfPanel(id: PanelId): string | null {
  return PANEL_COMMAND_ID[id] ?? null;
}

export interface HelpSettingsCategory {
  id: string;
  label: string;
}

/** 設定画面に出るカテゴリ。License は CategoryNav と同じく licensing 有効のときだけ。 */
export function settingsCategoryList(): HelpSettingsCategory[] {
  const licensingEnabled = useLicenseStore.getState().licensingEnabled;
  return SETTINGS_CATEGORIES.filter(
    ({ id }) => id !== "license" || licensingEnabled,
  ).map(({ id, label }) => ({ id, label }));
}

export function builtinPresetName(id: string): string | null {
  return getBuiltinPresets().find((preset) => preset.id === id)?.name ?? null;
}
