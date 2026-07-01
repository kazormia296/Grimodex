/**
 * 執筆タイムラプス — live エディタの実テーマ/フォントを EditorRenderTheme に解決 (P1, §17)。
 *
 * 動画を「白いテキストダンプ」でなくユーザーの実環境(テーマ色・フォント・帰属表示)に
 * 一致させる。テーマ色は oklch/HEX/color-mix 混在で CSS 変数を直読しても解けないため、
 * **標準プロパティに var() を設定した probe を getComputedStyle で読む**ことでエンジンに
 * rgb まで解決させる(CharacterFadeOutPlugin と同じ手)。描画は同一エンジンで走るので、
 * その computed color 文字列はそのまま canvas fillStyle に渡せる。
 *
 * probe は document.body に挿す: テーマ変数(--content-* / --attribution-pct)は :root
 * 定義で全体に継承されるため body で解決でき、エディタが display:none/未マウントでも
 * 色は正しく取れる。フォントだけは live `.tiptap` の computed を best-effort で採用する。
 *
 * browser 専用。SSR/非 DOM や getComputedStyle が var() を解決しない環境では
 * DEFAULT_THEME にフォールバックする(描画は壊さない)。
 */

import {
  DEFAULT_THEME,
  type EditorRenderTheme,
} from "./renderers/editorRenderer";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { TateChuYokoPolicy } from "@/features/editor/tateChuYokoPolicy";

/**
 * Writing-mode + 縦中横 policy for the current project, read from the same
 * settings store the live editor reads (single source of truth — the video's
 * orientation always matches what the editor is showing). Safe in any env: the
 * zustand getter falls back to the defaults before `loadAll` populates it.
 */
function resolveWritingMode(): {
  vertical: boolean;
  tateChuYoko: TateChuYokoPolicy;
} {
  try {
    const s = useSettingsStore.getState();
    return {
      vertical: s.getBoolean("editor.verticalMode", false),
      tateChuYoko: s.get("editor.tateChuYoko", "2") as TateChuYokoPolicy,
    };
  } catch {
    return { vertical: false, tateChuYoko: "2" };
  }
}

function px(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** computed color が未解決(空 / 生の var()/oklch 文字列)なら fallback を返す。 */
function resolved(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  if (v === "" || v.startsWith("var(")) return fallback;
  return v;
}

export function resolveEditorTheme(): EditorRenderTheme {
  if (
    typeof document === "undefined" ||
    typeof getComputedStyle === "undefined" ||
    !document.body
  ) {
    return DEFAULT_THEME;
  }

  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;left:-99999px;top:-99999px;width:0;height:0;" +
    "pointer-events:none;visibility:hidden;";
  document.body.appendChild(probe);
  try {
    // 標準プロパティに var() を設定 → engine が rgb まで解決する。
    probe.style.color = "var(--content-foreground)";
    probe.style.backgroundColor = "var(--content-background)";
    let cs = getComputedStyle(probe);
    const text = resolved(cs.color, DEFAULT_THEME.text);
    const background = resolved(cs.backgroundColor, DEFAULT_THEME.background);

    // muted 文字色 / border 色 (blockquote 用, P2)。
    probe.style.color = "var(--content-foreground-muted)";
    cs = getComputedStyle(probe);
    const textMuted = resolved(cs.color, DEFAULT_THEME.textMuted);
    probe.style.color = "var(--content-border)";
    cs = getComputedStyle(probe);
    const border = resolved(cs.color, DEFAULT_THEME.border);

    // 帰属色は .attribution-* の color-mix(--attribution-pct, --content-background)。
    // inline 背景を消してからクラスを当てて解決させる。
    probe.style.color = "";
    probe.style.backgroundColor = "";
    probe.className = "attribution-ai";
    cs = getComputedStyle(probe);
    const attributionAi = resolved(
      cs.backgroundColor,
      DEFAULT_THEME.attributionAi,
    );
    probe.className = "attribution-unknown";
    cs = getComputedStyle(probe);
    const attributionUnknown = resolved(
      cs.backgroundColor,
      DEFAULT_THEME.attributionUnknown,
    );
    probe.className = "";

    // フォントは live エディタ面の computed を採用(serif/18px/lineHeight 2.0→px を解決済)。
    const editorNode = document.querySelector<HTMLElement>(
      ".tiptap, .ProseMirror",
    );
    const fontCs = editorNode ? getComputedStyle(editorNode) : null;
    const fontFamily = fontCs?.fontFamily?.trim() || DEFAULT_THEME.fontFamily;
    const fontSizePx = px(fontCs?.fontSize, DEFAULT_THEME.fontSizePx);
    const lineHeightPx = px(fontCs?.lineHeight, Math.round(fontSizePx * 1.6));

    return {
      ...DEFAULT_THEME,
      background,
      text,
      textMuted,
      border,
      showAttribution: useAttributionStore.getState().showAttribution,
      attributionAi,
      attributionUnknown,
      fontFamily,
      fontSizePx,
      lineHeightPx,
      ...resolveWritingMode(),
    };
  } catch {
    return DEFAULT_THEME;
  } finally {
    probe.remove();
  }
}
