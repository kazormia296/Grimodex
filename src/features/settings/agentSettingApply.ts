/**
 * agent が提案した設定変更を、利用者の「適用」「元に戻す」のクリックで反映する。
 *
 * 書込みは既存の `settingsStore.set`（`writeRuntimeSetting`）だけを使い、新しい IPC・保存先は作らない。
 * 適用の直前に renderer で目録の検証をやり直す（提案の時点の検証結果は信用しない）。
 * `editor.focusMode`／`editor.typewriterMode`／`display.codexHighlight` は、設定値とは別に
 * 実行時 store（cursorSettingsStore／codexHighlightStore）が画面の状態を持つので、該当 field だけ合わせる
 * （`initFromSettings` は他のレイヤ状態も巻き戻すので使わない）。
 */
import {
  agentSettingValuesEqual,
  getAgentSettingEntry,
  validateAgentSettingValue,
  type AgentSettingValidation,
} from "@/../electron/shared/agentSettingCatalog";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { BUNDLED_FONTS } from "./bundledFonts";
import { fetchSystemFonts } from "./hooks/useSystemFonts";
import {
  clearRuntimeSetting,
  hasExplicitRuntimeSetting,
  readRuntimeSetting,
  writeRuntimeSetting,
} from "./runtimeSettings";

/** FontFamilySelect の選択肢と同じ値（basic ＋ 同梱 ＋ システム）。移行注入の current は数えない。 */
export async function listFontFamilyChoices(): Promise<string[]> {
  const systemFonts = await fetchSystemFonts();
  return [
    "serif",
    "monospace",
    ...BUNDLED_FONTS.map((font) => `"${font.family}"`),
    ...systemFonts.map((family) => `"${family}"`),
  ];
}

/**
 * 提案の時点の検証。font は形だけ（制御文字・200 字超の拒否）で、端末に入っている
 * フォントとは照合しない。モデルへの成功・失敗が端末のフォントで変わらず、provider へ漏れないようにする。
 */
export function validateSettingProposal(
  key: unknown,
  value: unknown,
): AgentSettingValidation {
  return validateAgentSettingValue(key, value, { fontFamilies: "shape-only" });
}

/** 適用の直前の検証。font は今の選択肢（FontFamilySelect と同じ）と完全一致するものだけ。 */
async function validateSettingForApply(
  key: unknown,
  value: unknown,
): Promise<AgentSettingValidation> {
  const entry = getAgentSettingEntry(key);
  if (entry?.type === "font") {
    return validateAgentSettingValue(key, value, {
      fontFamilies: await listFontFamilyChoices(),
    });
  }
  return validateAgentSettingValue(key, value);
}

/** 今の設定値（保存形式の文字列。未設定なら既定値）。 */
export function readAgentSettingValue(key: string): string {
  return readRuntimeSetting(key);
}

function writeThroughMirrors(key: string, value: string): void {
  if (key === "editor.focusMode") {
    useCursorSettingsStore.setState({ focusMode: value === "true" });
  } else if (key === "editor.typewriterMode") {
    useCursorSettingsStore.setState({ typewriterMode: value === "true" });
  } else if (key === "display.codexHighlight") {
    useCodexHighlightStore
      .getState()
      .setEnabled(value === "true", { persist: false });
  }
}

/** 書いて読み戻す。`settingsStore.set` は静止中などに黙って何もしないことがあるため。 */
function writeVerified(key: string, value: string): boolean {
  writeRuntimeSetting(key, value);
  if (!agentSettingValuesEqual(key, readRuntimeSetting(key), value)) {
    return false;
  }
  writeThroughMirrors(key, value);
  return true;
}

export type AgentSettingApplyResult =
  | {
      readonly ok: true;
      readonly previous: string;
      /**
       * 適用の前に、保存先の層へ明示値として有ったか。false なら `previous` は既定値（言語別の上書きを
       * 含む実効値）で、「元に戻す」は値を書かず明示値を消す（既定値を明示値として固定しない）。
       */
      readonly previousExplicit: boolean;
      readonly applied: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** カードの失敗表示の出し分け。font がこの端末の選択肢に無い場合は "font-unavailable"。 */
      readonly reason: "font-unavailable" | "invalid" | "write-failed";
    };

/**
 * 利用者の「適用」。目録で再検証し、通った値だけを既存の経路で書く。
 * 返す `previous`／`previousExplicit` は書く前の実効値と明示値の有無で、「元に戻す」に使う。
 */
export async function applyAgentSettingChange(
  key: string,
  value: string,
): Promise<AgentSettingApplyResult> {
  const verdict = await validateSettingForApply(key, value);
  if (!verdict.ok) {
    return {
      ok: false,
      message: verdict.message,
      reason: verdict.code === "not-an-option" ? "font-unavailable" : "invalid",
    };
  }
  const previous = readAgentSettingValue(key);
  const previousExplicit = hasExplicitRuntimeSetting(key);
  if (!writeVerified(key, verdict.value)) {
    return {
      ok: false,
      message: "the setting could not be written right now",
      reason: "write-failed",
    };
  }
  return { ok: true, previous, previousExplicit, applied: verdict.value };
}

export type AgentSettingRevertResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "changed" | "failed" };

/**
 * 利用者の「元に戻す」。今の値が適用した値のままのときだけ戻す
 * （その後に利用者が変えた値を上書きしない）。適用前に明示値が無かった（`previousExplicit` が false）
 * ときは、前の実効値を書かずに明示値を消し、既定値・言語別の上書きが再び効くようにする。
 */
export function revertAgentSettingChange(
  key: string,
  applied: string,
  previous: string,
  previousExplicit = true,
): AgentSettingRevertResult {
  if (!getAgentSettingEntry(key)) return { ok: false, reason: "failed" };
  if (!agentSettingValuesEqual(key, readRuntimeSetting(key), applied)) {
    return { ok: false, reason: "changed" };
  }
  // 明示値が目録の検証（main の save_global_settings と同じ規則）を通らないとき（手で壊した値など）は、
  // 書き戻すと main が保存を拒否して pending が残り続けるので、書かずに消して既定に戻す。
  if (
    !previousExplicit ||
    !validateAgentSettingValue(key, previous, { fontFamilies: "shape-only" }).ok
  ) {
    return clearThroughMirrors(key);
  }
  return writeVerified(key, previous)
    ? { ok: true }
    : { ok: false, reason: "failed" };
}

/** 明示値を消す。消えたこと（層に無いこと）を読み戻して確かめてから、実行時 store を実効値に合わせる。 */
function clearThroughMirrors(key: string): AgentSettingRevertResult {
  clearRuntimeSetting(key);
  if (hasExplicitRuntimeSetting(key)) return { ok: false, reason: "failed" };
  writeThroughMirrors(key, readRuntimeSetting(key));
  return { ok: true };
}
