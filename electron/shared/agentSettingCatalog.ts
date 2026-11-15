/**
 * agent（アプリ内 Chat）が「変更を提案できる」設定の目録と、値の検証（設計書 §4.2・§6）。
 *
 * - 目録に載るのは、利用者が承認した個人の表示・エディタ設定 16 件だけ（すべて global scope）。
 *   API key・endpoint・provider・送信先・保存範囲・データの削除・export などは載せない。
 * - 検証は丸めない。範囲外・step 外・選択肢外・型違いは拒否し、受け入れた値だけを
 *   設定の保存形式（`settingsStore` の文字列）へ正規化して返す。
 * - 範囲・step は設定画面（EditorCategory／DisplayCategory／LayersPopover）が同じ定数を使う。
 *   食い違いは `agentSettingCatalog.test.ts` が落とす。
 * - renderer（提案の検証・適用時の再検証）と main（`save_global_settings` の再検証）の両方が
 *   読めるよう、Node／Electron／DOM に依存しない純粋モジュールに保つ。
 */

export type AgentSettingType = "boolean" | "number" | "font";

export interface AgentSettingRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** 数値の表示形式（カードの前後の値）。保存値の意味は変えない。 */
export type AgentSettingDisplay = "plain" | "px" | "percentTimes10";

export interface AgentSettingEntry {
  /** settingsStore のキー。 */
  readonly key: string;
  readonly type: AgentSettingType;
  /** number のときの範囲。 */
  readonly range?: AgentSettingRange;
  /** type が font のときの注記。選択肢は実行時（同梱＋システムのフォント）に決まる。 */
  readonly options?: "font-family-select";
  readonly categoryId: "editor" | "display";
  /** 設定画面の既存の label（locale key）。 */
  readonly labelKey: string;
  /** 設定画面の既存の説明（locale key）。無い設定は省く。 */
  readonly descriptionKey?: string;
  readonly scope: "global";
  readonly display?: AgentSettingDisplay;
}

const RANGES = {
  "editor.fontSize": { min: 14, max: 24, step: 1 },
  "editor.lineHeight": { min: 1.2, max: 3.0, step: 0.1 },
  "editor.maxContentWidth": { min: 480, max: 960, step: 40 },
  "editor.paragraphSpacing": { min: 0, max: 24, step: 2 },
  "display.codexHighlightOpacity": { min: 5, max: 25, step: 1 },
} as const satisfies Record<string, AgentSettingRange>;

export type AgentSettingRangeKey = keyof typeof RANGES;

/**
 * 設定画面のスライダーが使う範囲。目録の検証と同じ値を 1 か所に置く。
 * 数値の範囲を持つキーだけを型で受ける。
 */
export function agentSettingRange(
  key: AgentSettingRangeKey,
): AgentSettingRange {
  return RANGES[key];
}

/** 並びは設計書の承認済み一覧（editor 11 件、display 5 件）に合わせる。 */
export const AGENT_SETTING_CATALOG: readonly AgentSettingEntry[] =
  Object.freeze([
    {
      key: "editor.fontSize",
      type: "number",
      range: RANGES["editor.fontSize"],
      categoryId: "editor",
      labelKey: "settings.editor.fontSize",
      scope: "global",
      display: "px",
    },
    {
      key: "editor.lineHeight",
      type: "number",
      range: RANGES["editor.lineHeight"],
      categoryId: "editor",
      labelKey: "settings.editor.lineHeight",
      scope: "global",
    },
    {
      key: "editor.maxContentWidth",
      type: "number",
      range: RANGES["editor.maxContentWidth"],
      categoryId: "editor",
      labelKey: "settings.editor.maxWidth",
      scope: "global",
      display: "px",
    },
    {
      key: "editor.paragraphSpacing",
      type: "number",
      range: RANGES["editor.paragraphSpacing"],
      categoryId: "editor",
      labelKey: "settings.editor.paragraphSpacing",
      scope: "global",
      display: "px",
    },
    {
      key: "editor.fontFamily",
      type: "font",
      options: "font-family-select",
      categoryId: "editor",
      labelKey: "settings.editor.font",
      scope: "global",
    },
    {
      key: "editor.typewriterMode",
      type: "boolean",
      categoryId: "editor",
      labelKey: "settings.editor.typewriterMode",
      descriptionKey: "settings.editor.typewriterModeDesc",
      scope: "global",
    },
    {
      key: "editor.focusMode",
      type: "boolean",
      categoryId: "editor",
      // 設定画面に行は無く、エディタのツールバーのトグル名を使う。
      labelKey: "editor.toolbar.focusMode",
      scope: "global",
    },
    {
      key: "editor.showInvisibles",
      type: "boolean",
      categoryId: "editor",
      labelKey: "settings.editor.showInvisibles",
      descriptionKey: "settings.editor.showInvisiblesDesc",
      scope: "global",
    },
    {
      key: "editor.showStickies",
      type: "boolean",
      categoryId: "editor",
      labelKey: "settings.editor.showStickies",
      descriptionKey: "settings.editor.showStickiesDesc",
      scope: "global",
    },
    {
      key: "editor.bubbleMenu",
      type: "boolean",
      categoryId: "editor",
      labelKey: "settings.editor.bubbleMenu",
      scope: "global",
    },
    {
      key: "editor.autoPairBrackets",
      type: "boolean",
      categoryId: "editor",
      labelKey: "settings.editor.autoPairBrackets",
      descriptionKey: "settings.editor.autoPairBracketsDesc",
      scope: "global",
    },
    {
      key: "editor.smartQuotes",
      type: "boolean",
      categoryId: "editor",
      labelKey: "settings.editor.smartQuotes",
      descriptionKey: "settings.editor.smartQuotesDesc",
      scope: "global",
    },
    {
      key: "display.showWordCount",
      type: "boolean",
      categoryId: "display",
      labelKey: "settings.display.showWordCount",
      scope: "global",
    },
    {
      key: "display.reduceMotion",
      type: "boolean",
      categoryId: "display",
      labelKey: "settings.display.reduceMotion",
      descriptionKey: "settings.display.reduceMotionDesc",
      scope: "global",
    },
    {
      key: "display.codexHighlight",
      type: "boolean",
      categoryId: "display",
      labelKey: "settings.display.enableHighlight",
      scope: "global",
    },
    {
      key: "display.codexHighlightOpacity",
      type: "number",
      range: RANGES["display.codexHighlightOpacity"],
      categoryId: "display",
      labelKey: "settings.display.codexOpacity",
      descriptionKey: "settings.display.codexOpacityDesc",
      scope: "global",
      display: "percentTimes10",
    },
  ] satisfies AgentSettingEntry[]);

export const AGENT_SETTING_KEYS: readonly string[] = Object.freeze(
  AGENT_SETTING_CATALOG.map((entry) => entry.key),
);

const ENTRY_BY_KEY: ReadonlyMap<string, AgentSettingEntry> = new Map(
  AGENT_SETTING_CATALOG.map((entry) => [entry.key, entry]),
);

/** 目録の項目。`__proto__` などの継承キーや目録外のキーは undefined。 */
export function getAgentSettingEntry(
  key: unknown,
): AgentSettingEntry | undefined {
  return typeof key === "string" ? ENTRY_BY_KEY.get(key) : undefined;
}

export type AgentSettingRejectCode =
  | "unknown-key"
  | "wrong-type"
  | "out-of-range"
  | "off-step"
  | "not-an-option";

export type AgentSettingValidation =
  | { readonly ok: true; readonly key: string; readonly value: string }
  | {
      readonly ok: false;
      readonly code: AgentSettingRejectCode;
      readonly message: string;
    };

export interface AgentSettingValidationOptions {
  /**
   * font の許可値（FontFamilySelect の選択肢の value。`"Noto Serif JP"`、`serif` など）。
   * `"shape-only"` は選択肢を列挙できない main 用で、CSS font-family として安全な文字列かだけを見る。
   * 省略した font の検証は拒否する（選択肢が分からないまま通さない）。
   */
  readonly fontFamilies?: readonly string[] | "shape-only";
}

/** 数値の誤差（1.2 + 0.1 × n など）を step の格子点と見なす許容。 */
const STEP_TOLERANCE = 1e-9;
const NUMERIC_TEXT = /^\d+(?:\.\d+)?$/;
const MAX_FONT_VALUE_LENGTH = 200;
// 制御文字・CSS の区切り・タグを含む値は font-family として保存しない。
// eslint-disable-next-line no-control-regex
const UNSAFE_FONT_CHARS = /[\u0000-\u001f\u007f;{}<>\\]/;

function stepDecimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function reject(
  code: AgentSettingRejectCode,
  message: string,
): AgentSettingValidation {
  return { ok: false, code, message };
}

function validateNumber(
  entry: AgentSettingEntry,
  raw: unknown,
): AgentSettingValidation {
  const range = entry.range;
  if (!range) return reject("wrong-type", `${entry.key} has no numeric range`);
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && NUMERIC_TEXT.test(raw)) {
    value = Number(raw);
  } else {
    return reject(
      "wrong-type",
      `${entry.key} must be a number (a plain decimal number or numeric string)`,
    );
  }
  if (!Number.isFinite(value)) {
    return reject("wrong-type", `${entry.key} must be a finite number`);
  }
  if (
    value < range.min - STEP_TOLERANCE ||
    value > range.max + STEP_TOLERANCE
  ) {
    return reject(
      "out-of-range",
      `${entry.key} must be between ${range.min} and ${range.max}`,
    );
  }
  const steps = Math.round((value - range.min) / range.step);
  const snapped = range.min + steps * range.step;
  if (Math.abs(snapped - value) > STEP_TOLERANCE) {
    return reject(
      "off-step",
      `${entry.key} must be ${range.min} plus a multiple of ${range.step} (up to ${range.max})`,
    );
  }
  const canonical = Number(snapped.toFixed(stepDecimals(range.step)));
  return { ok: true, key: entry.key, value: String(canonical) };
}

function validateBoolean(
  entry: AgentSettingEntry,
  raw: unknown,
): AgentSettingValidation {
  if (raw === true || raw === "true") {
    return { ok: true, key: entry.key, value: "true" };
  }
  if (raw === false || raw === "false") {
    return { ok: true, key: entry.key, value: "false" };
  }
  return reject("wrong-type", `${entry.key} must be a boolean (true or false)`);
}

function validateFont(
  entry: AgentSettingEntry,
  raw: unknown,
  options: AgentSettingValidationOptions,
): AgentSettingValidation {
  if (typeof raw !== "string" || raw.length === 0) {
    return reject("wrong-type", `${entry.key} must be a non-empty string`);
  }
  const families = options.fontFamilies;
  if (families === "shape-only") {
    if (raw.length > MAX_FONT_VALUE_LENGTH || UNSAFE_FONT_CHARS.test(raw)) {
      return reject("not-an-option", `${entry.key} is not a valid font family`);
    }
    return { ok: true, key: entry.key, value: raw };
  }
  if (!families || !families.includes(raw)) {
    return reject(
      "not-an-option",
      `${entry.key} must be exactly one of the font choices in the settings screen's font picker`,
    );
  }
  return { ok: true, key: entry.key, value: raw };
}

/**
 * 目録のキーと値を検証する。受け入れた値は保存形式（文字列）に正規化して返す。
 * 目録に無いキー、範囲外・step 外・選択肢外・型違いは丸めずに拒否する。
 */
export function validateAgentSettingValue(
  key: unknown,
  raw: unknown,
  options: AgentSettingValidationOptions = {},
): AgentSettingValidation {
  const entry = getAgentSettingEntry(key);
  if (!entry) {
    return reject("unknown-key", "this setting is not available for proposals");
  }
  switch (entry.type) {
    case "number":
      return validateNumber(entry, raw);
    case "boolean":
      return validateBoolean(entry, raw);
    case "font":
      return validateFont(entry, raw, options);
  }
}

/** 同じ設定値か（"2" と "2.0"、"true" と true の違いを同一視する）。 */
export function agentSettingValuesEqual(
  key: string,
  a: string,
  b: string,
): boolean {
  const entry = getAgentSettingEntry(key);
  if (entry?.type === "number") {
    const x = Number(a);
    const y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && x === y;
  }
  return a === b;
}

/**
 * main の `save_global_settings` 用。保存しようとする userPreferences のうち、
 * 保存済みの値から**変わった**目録のキーだけを検証し、拒否された key と理由を返す。
 * 変わっていない値は見ない（旧版の範囲外の値・移行値が 1 つあっても、他の設定の保存を妨げない）。
 */
export function findInvalidAgentSettingChanges(
  incoming: unknown,
  current: unknown,
): { key: string; message: string }[] {
  if (!isStringRecord(incoming)) return [];
  const before = isStringRecord(current) ? current : {};
  const invalid: { key: string; message: string }[] = [];
  for (const entry of AGENT_SETTING_CATALOG) {
    if (!Object.hasOwn(incoming, entry.key)) continue;
    const next = incoming[entry.key];
    if (next === before[entry.key]) continue;
    const verdict = validateAgentSettingValue(entry.key, next, {
      fontFamilies: "shape-only",
    });
    if (!verdict.ok) invalid.push({ key: entry.key, message: verdict.message });
  }
  return invalid;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** incoming の userPreferences に目録のキーが 1 つでもあるか（保存済みの値を読む要否の判定）。 */
export function containsAgentSettingKey(prefs: unknown): boolean {
  if (!isStringRecord(prefs)) return false;
  return AGENT_SETTING_CATALOG.some((entry) => Object.hasOwn(prefs, entry.key));
}
