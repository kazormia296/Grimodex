/**
 * Naïve pure-JS linter used by the browser mock (`pnpm dev` mode).
 *
 * This implements a subset of the Rust `grimodex-lint` rules — enough to
 * give a plausible preview when the Tauri backend is unavailable. The
 * shape of the returned response matches the Rust `LintResponse` type so
 * the frontend stays oblivious to which linter produced it.
 *
 * Differences from the Rust implementation:
 * - Half-width kana dakuten/handakuten composition is simplified.
 * - `ja/sentence-ending-repeat` and `ja/halfwidth-fullwidth-mix` are
 *   not implemented here (off-by-default and policy-heavy respectively).
 */

interface WireLintBlock {
  id: number;
  kind: "paragraph" | "heading" | "blockquote" | "listItem" | "tableCell";
  text: string;
  str_offset_start: number;
}

interface RuleConfig {
  enabled?: boolean;
  severity?: "error" | "warning" | "info";
  options?: Record<string, unknown>;
}

interface WireConfig {
  rules?: Record<string, RuleConfig>;
}

interface Utf16Range {
  start: number;
  end: number;
}

interface Fix {
  label: string;
  replacement: string;
  range: Utf16Range;
}

interface Diagnostic {
  rule_id: string;
  severity: "error" | "warning" | "info";
  message: string;
  range: Utf16Range;
  fix?: Fix;
}

interface RuleWarning {
  rule_id: string;
  kind: "skipped" | "invalidOption" | "initFailed";
  message: string;
}

interface DisableDirective {
  rules: string[];
  range: Utf16Range;
}

interface LintResponse {
  diagnostics: Diagnostic[];
  warnings: RuleWarning[];
  computed_at: number;
}

type SelectorKind = { type: "all" } | { type: "ids"; ids: string[] };

/**
 * Mirror the Rust-side validation so the browser mock filters
 * disabled diagnostics with identical semantics.
 */
function validateSelector(rules: string[]): SelectorKind | string {
  if (rules.length === 0) {
    return 'rules must not be empty (use ["*"] for all)';
  }
  const hasWildcard = rules.includes("*");
  if (hasWildcard && rules.length > 1) {
    return '"*" must not be mixed with other rule IDs';
  }
  if (hasWildcard) return { type: "all" };
  return { type: "ids", ids: rules };
}

function isDisabled(
  d: Diagnostic,
  resolved: Array<{ kind: SelectorKind; range: Utf16Range }>,
): boolean {
  return resolved.some((r) => {
    // Mirror Rust's `Utf16Range::contains` directly — identical
    // semantics to the engine filter path.
    const contained =
      r.range.start <= d.range.start && d.range.end <= r.range.end;
    if (!contained) return false;
    if (r.kind.type === "all") return true;
    return r.kind.ids.some((id) => id === d.rule_id);
  });
}

export function lintTextBrowser(args: {
  blocks: WireLintBlock[];
  language: "ja" | "en";
  config: WireConfig;
  disables?: DisableDirective[];
}): LintResponse {
  const diagnostics: Diagnostic[] = [];
  const rules = args.config.rules ?? {};
  const isEnabled = (id: string, defaultOn = true): boolean => {
    const r = rules[id];
    if (!r) return defaultOn;
    return r.enabled ?? defaultOn;
  };
  const sev = (id: string, fallback: Diagnostic["severity"]) =>
    rules[id]?.severity ?? fallback;

  for (const block of args.blocks) {
    if (args.language === "ja") {
      if (isEnabled("ja/consecutive-punct")) {
        collect(
          block,
          /、{2,}|。{2,}/g,
          (m) => ({
            rule_id: "ja/consecutive-punct",
            severity: sev("ja/consecutive-punct", "error"),
            message: `連続する「${m[0][0]}」は1つにまとめてください`,
            fix: {
              label: `「${m[0][0]}」に置き換える`,
              replacement: m[0][0],
            },
          }),
          diagnostics,
        );
      }
      if (isEnabled("ja/ellipsis-single")) {
        collect(
          block,
          /…+/g,
          (m) =>
            m[0].length === 1
              ? {
                  rule_id: "ja/ellipsis-single",
                  severity: sev("ja/ellipsis-single", "error"),
                  message: "三点リーダーは 2 つ組で使います",
                  fix: { label: "「……」に置き換える", replacement: "……" },
                }
              : null,
          diagnostics,
        );
      }
      if (isEnabled("ja/ellipsis-odd")) {
        collect(
          block,
          /…+/g,
          (m) => {
            const n = m[0].length;
            if (n < 3 || n % 2 === 0) return null;
            const replacement = "…".repeat(n - 1);
            return {
              rule_id: "ja/ellipsis-odd",
              severity: sev("ja/ellipsis-odd", "warning"),
              message: `三点リーダーが ${n} つです（偶数個にしてください）`,
              fix: {
                label: `「${replacement}」に置き換える`,
                replacement,
              },
            };
          },
          diagnostics,
        );
      }
      if (isEnabled("ja/dash-single")) {
        collect(
          block,
          /—+/g,
          (m) =>
            m[0].length === 1
              ? {
                  rule_id: "ja/dash-single",
                  severity: sev("ja/dash-single", "error"),
                  message: "ダッシュは 2 つ組で使います",
                  fix: { label: "「——」に置き換える", replacement: "——" },
                }
              : null,
          diagnostics,
        );
      }
      if (isEnabled("ja/halfwidth-kana")) {
        collect(
          block,
          /[･-ﾟ]+/g,
          (m) => ({
            rule_id: "ja/halfwidth-kana",
            severity: sev("ja/halfwidth-kana", "error"),
            message: "半角カナは全角にしてください",
            fix: {
              label: "全角に置き換える",
              replacement: m[0], // naive — browser mock does not compose
            },
          }),
          diagnostics,
        );
      }
      if (isEnabled("ja/sentence-length")) {
        const opts = rules["ja/sentence-length"]?.options ?? {};
        const warnAt = Number(opts.warnAt ?? 80);
        const errorAt = Number(opts.errorAt ?? 120);
        if (block.kind === "paragraph" || block.kind === "blockquote") {
          walkSentences(block, warnAt, errorAt, (range, len, severity) =>
            diagnostics.push({
              rule_id: "ja/sentence-length",
              severity,
              message: `一文が ${severity === "error" ? errorAt : warnAt} 文字を超えています（${len} 文字）`,
              range,
            }),
          );
        }
      }
    } else if (args.language === "en") {
      if (isEnabled("en/straight-quotes")) {
        collect(
          block,
          /"([^"\n]*)"/g,
          (m) => ({
            rule_id: "en/straight-quotes",
            severity: sev("en/straight-quotes", "warning"),
            message: "Use curly quotes “…” in prose",
            fix: {
              label: "Replace with curly quotes",
              replacement: `“${m[1] ?? ""}”`,
            },
          }),
          diagnostics,
        );
      }
      if (isEnabled("en/ellipsis")) {
        collect(
          block,
          /\.{3,}/g,
          () => ({
            rule_id: "en/ellipsis",
            severity: sev("en/ellipsis", "info"),
            message: "Use the ellipsis character (…)",
            fix: { label: "Replace with …", replacement: "…" },
          }),
          diagnostics,
        );
      }
      if (isEnabled("en/double-space")) {
        collect(
          block,
          /\. {2,}/g,
          () => ({
            rule_id: "en/double-space",
            severity: sev("en/double-space", "warning"),
            message: "Use a single space after a period",
            fix: { label: "Collapse to single space", replacement: ". " },
          }),
          diagnostics,
        );
      }
      if (isEnabled("en/em-dash")) {
        collect(
          block,
          /(\w) - (\w)/g,
          (m) => ({
            rule_id: "en/em-dash",
            severity: sev("en/em-dash", "info"),
            message: "Consider an em dash (—) instead of a spaced hyphen",
            fix: {
              label: "Replace with em dash",
              replacement: `${m[1]}—${m[2]}`,
            },
          }),
          diagnostics,
        );
      }
    }
  }

  // Resolve incoming disable directives (mock the Rust engine's
  // pre-emit filter). Invalid selectors are skipped with a warning so
  // the UI surfaces the same `core/disables` InvalidOption it would
  // see against real Rust.
  const warnings: RuleWarning[] = [];
  const resolved: Array<{ kind: SelectorKind; range: Utf16Range }> = [];
  for (const d of args.disables ?? []) {
    const kind = validateSelector(d.rules);
    if (typeof kind === "string") {
      warnings.push({
        rule_id: "core/disables",
        kind: "invalidOption",
        message: kind,
      });
      continue;
    }
    resolved.push({ kind, range: d.range });
  }

  const filtered = diagnostics.filter((d) => !isDisabled(d, resolved));

  filtered.sort((a, b) => {
    if (a.range.start !== b.range.start) return a.range.start - b.range.start;
    if (a.range.end !== b.range.end) return a.range.end - b.range.end;
    return a.rule_id.localeCompare(b.rule_id);
  });

  return {
    diagnostics: filtered,
    warnings,
    computed_at: Date.now(),
  };
}

interface DiagnosticTemplate {
  rule_id: string;
  severity: Diagnostic["severity"];
  message: string;
  fix?: { label: string; replacement: string };
}

function collect(
  block: WireLintBlock,
  regex: RegExp,
  build: (m: RegExpExecArray) => DiagnosticTemplate | null,
  out: Diagnostic[],
) {
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(block.text)) !== null) {
    const built = build(m);
    if (!built) continue;
    const range: Utf16Range = {
      start: block.str_offset_start + m.index,
      end: block.str_offset_start + m.index + m[0].length,
    };
    const fix: Fix | undefined = built.fix
      ? { ...built.fix, range }
      : undefined;
    out.push({
      rule_id: built.rule_id,
      severity: built.severity,
      message: built.message,
      range,
      fix,
    });
  }
}

function walkSentences(
  block: WireLintBlock,
  warnAt: number,
  errorAt: number,
  emit: (range: Utf16Range, len: number, severity: "warning" | "error") => void,
) {
  const TERMINATORS = new Set(["。", "！", "？", ".", "!", "?"]);
  let cursor = block.str_offset_start;
  let sentenceStart = cursor;
  let hasContent = false;

  const push = () => {
    const len = cursor - sentenceStart;
    if (!hasContent || len < warnAt) return;
    const severity = len >= errorAt ? "error" : "warning";
    emit({ start: sentenceStart, end: cursor }, len, severity);
  };

  for (const ch of block.text) {
    const units = ch.length; // JS strings are UTF-16; `.length` is code units
    cursor += units;
    if (!/\s/.test(ch)) hasContent = true;
    if (TERMINATORS.has(ch)) {
      push();
      sentenceStart = cursor;
      hasContent = false;
    }
  }
  if (hasContent) push();
}
