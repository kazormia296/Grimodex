/**
 * Shared type definitions for the Grimodex Linter.
 *
 * These mirror the Rust types exposed by the `grimodex-lint` crate. The
 * Rust side emits snake_case JSON (serde default), so we match that here.
 */

export type Severity = "error" | "warning" | "info";

export type LintLanguage = "ja" | "en";

/**
 * Resolve the current project's language into a Lint-supported language
 * code. Reads `document.documentElement.lang` (populated by the app
 * bootstrap from `project.language`). Anything not recognised defaults
 * to Japanese — the app's primary target language.
 */
export function resolveLintLanguage(): LintLanguage {
  if (typeof document === "undefined") return "ja";
  const raw = document.documentElement.lang.toLowerCase();
  if (raw.startsWith("en")) return "en";
  return "ja";
}

export interface Utf16Range {
  start: number;
  end: number;
}

export interface Fix {
  label: string;
  replacement: string;
  range: Utf16Range;
}

export interface Diagnostic {
  rule_id: string;
  severity: Severity;
  message: string;
  range: Utf16Range;
  fix?: Fix;
}

export type WarningKind = "skipped" | "invalidOption" | "initFailed";

export interface RuleWarning {
  rule_id: string;
  kind: WarningKind;
  message: string;
}

export interface LintResponse {
  diagnostics: Diagnostic[];
  warnings: RuleWarning[];
  computed_at: number;
}

export type LintErrorKind =
  | "TextTooLarge"
  | "InvalidLanguage"
  | "InvalidConfig"
  | "Internal";

export interface LintError {
  type: LintErrorKind;
  data?: unknown;
}

export type BlockKind =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "listItem"
  | "tableCell";

/** Wire shape for a single block sent to `lint_text`. */
export interface WireLintBlock {
  id: number;
  kind: BlockKind;
  text: string;
  str_offset_start: number;
}

export type LintScope =
  | { kind: "scene"; scene_id: string }
  | { kind: "chapter"; chapter_id: string }
  | { kind: "project" };

/**
 * Rule selector on the wire. Valid values:
 *   - `["*"]` → disable every rule
 *   - Non-empty array of rule IDs, not containing `"*"`
 *
 * Empty arrays and `"*"` mixed with other IDs are rejected by Rust with
 * a `core/disables` InvalidOption warning; the directive itself is
 * ignored. Keep the client honest by constructing only valid selectors
 * — the sentinel `["*"]` vs. explicit rule IDs is how authors reason
 * about scope at the UI layer.
 */
export type RuleSelector = string[];

/**
 * One inline disable directive sent to Rust as part of `lint_text`.
 *
 * Block vs Span distinction is a UI concern — the wire carries only a
 * (range, rules) tuple. The range is always scene-wide UTF-16, same
 * convention as every other range in this module.
 */
export interface DisableDirective {
  rules: RuleSelector;
  range: Utf16Range;
}

export interface RuleConfig {
  enabled?: boolean;
  severity?: Severity;
  options?: Record<string, unknown>;
}

/**
 * Codex entry subset passed to the Linter for F-group rules (codex/*).
 * Sent on every lint request alongside the rules config.
 */
export interface LintCodexEntry {
  entry_id: string;
  canonical: string;
  aliases: string[];
}

/**
 * One row of the project term dictionary on the wire. Mirrors the
 * Rust `TermEntry` struct exactly (snake_case serde defaults).
 */
export interface LintTermEntry {
  id: string;
  preferred: string;
  variants: string[];
  severity: Severity;
  note?: string | null;
  enabled: boolean;
}

export interface LintConfig {
  rules?: Record<string, RuleConfig>;
  codex_entries?: LintCodexEntry[];
  term_dictionary?: LintTermEntry[];
}

/**
 * Stable revisions for large project-level inputs attached to LintConfig.
 * The engine still receives the concrete arrays; these keys let the renderer
 * invalidate its block cache without serialising those arrays on every pass.
 */
export interface LintInputRevisions {
  codex?: number;
}
