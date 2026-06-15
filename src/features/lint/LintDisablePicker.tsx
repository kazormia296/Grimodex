import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/core";

import { useLintConfigStore } from "./lintConfigStore";
import type { MultiBlockDisablePolicy } from "./lintConfigStore";

interface SelectionInfo {
  from: number;
  to: number;
  /** True when the selection crosses one or more block boundaries. */
  multiBlock: boolean;
}

export interface LintDisablePickerProps {
  editor: Editor;
  selection: SelectionInfo;
  /**
   * Prefill the rule-ID multi-select — typically one rule ID when the
   * picker is launched from a Diagnostic context menu ("無効化 this
   * rule for this span").
   */
  initialRules?: string[];
  onClose: () => void;
}

type MultiBlockPolicy = "block" | "span";

/**
 * Apply a disable directive produced by the picker. Falls into one of
 * three paths:
 *   - single-block Span: just set the `lintDisable` Mark over the range
 *   - multi-block with `block` policy: set `lintDisabled` attr on
 *     every block the selection touches
 *   - multi-block with `span` policy: set the `lintDisable` Mark on
 *     each block's slice of the selection (TipTap handles the per-
 *     block splits automatically when the Mark is applied across a
 *     multi-block range because marks don't cross block boundaries)
 */
function applyDisable(
  editor: Editor,
  selection: SelectionInfo,
  rules: string[],
  policy: MultiBlockPolicy,
): void {
  if (!selection.multiBlock || policy === "span") {
    // Span path — TipTap only applies marks to inline text, so even if
    // the selection spans blocks, setMark is per-inline-range and
    // silently no-ops at block boundaries.
    editor
      .chain()
      .setTextSelection({ from: selection.from, to: selection.to })
      .setMark("lintDisable", { rules })
      .run();
    return;
  }

  // Block path — walk the doc between `from` and `to`, update each
  // block's `lintDisabled` attr. Reuse the `updateAttributes` command
  // scoped to each block node.
  const { state } = editor;
  const tr = state.tr;
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!node.isBlock) return undefined;
    // Only the block kinds that carry the `lintDisabled` attribute —
    // keep this in sync with `LintDisableBlockAttrs.types`.
    const kind = node.type.name;
    if (
      kind !== "paragraph" &&
      kind !== "heading" &&
      kind !== "blockquote" &&
      kind !== "listItem" &&
      kind !== "tableCell"
    ) {
      return undefined;
    }
    const attrs = { ...node.attrs, lintDisabled: rules };
    tr.setNodeMarkup(pos, undefined, attrs, node.marks);
    return undefined;
  });
  editor.view.dispatch(tr);
}

export function LintDisablePicker({
  editor,
  selection,
  initialRules,
  onClose,
}: LintDisablePickerProps) {
  const { t } = useTranslation();
  const effective = useLintConfigStore((s) => s.getEffective());
  const setMultiBlockPolicy = useLintConfigStore((s) => s.setMultiBlockPolicy);
  const persistedPolicy: MultiBlockDisablePolicy =
    effective.inlineDisable.multiBlockPolicy;

  const availableRules = useMemo(() => {
    return Object.keys(effective.rules)
      .filter((id) => effective.rules[id]?.enabled !== false)
      .sort();
  }, [effective.rules]);

  const [isAll, setIsAll] = useState(
    () => initialRules?.length === 1 && initialRules[0] === "*",
  );
  const [picked, setPicked] = useState<Set<string>>(() => {
    const initial =
      initialRules && !(initialRules.length === 1 && initialRules[0] === "*")
        ? initialRules
        : [];
    return new Set(initial);
  });
  // When the user has persisted "always block" / "always span", honour
  // it as the dialog default (still editable for one-off overrides).
  const [policy, setPolicy] = useState<MultiBlockPolicy>(() =>
    persistedPolicy === "span" ? "span" : "block",
  );
  const [rememberPolicy, setRememberPolicy] = useState(false);

  // ESC closes without applying.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onApply = () => {
    const rules = isAll ? ["*"] : Array.from(picked);
    if (rules.length === 0) return;
    if (selection.multiBlock && rememberPolicy) {
      // Persist the chosen path so future multi-block selections skip
      // this question (the dialog itself stays open for rule selection
      // — only the A/B sub-section disappears next time).
      setMultiBlockPolicy(policy);
    }
    applyDisable(editor, selection, rules, policy);
    onClose();
  };

  const canApply = isAll || picked.size > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[420px] max-h-[80vh] overflow-hidden rounded-md border border-border bg-background shadow-xl flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-2">
          <h3 className="text-sm font-semibold">
            {t("lint.disable.title", "ルールを無効化")}
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            {t(
              "lint.disable.description",
              "選択範囲で指定した Lint ルールを silence します。",
            )}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={isAll}
              onChange={(e) => setIsAll(e.target.checked)}
            />
            {t("lint.disable.allRules", "すべてのルール（全ルール無効化）")}
          </label>

          {!isAll && (
            <div className="flex flex-col gap-1 border-t border-border pt-2">
              <div className="text-xs text-muted-foreground mb-1">
                {t("lint.disable.selectSpecific", "特定のルールを選択:")}
              </div>
              {availableRules.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">
                  {t("lint.disable.noRules", "有効なルールがありません")}
                </div>
              ) : (
                availableRules.map((id) => (
                  <label
                    key={id}
                    className="flex items-center gap-2 text-xs hover:bg-accent/30 px-1 py-0.5 rounded"
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(id)}
                      onChange={(e) => {
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(id);
                          else next.delete(id);
                          return next;
                        });
                      }}
                    />
                    <code>{id}</code>
                  </label>
                ))
              )}
            </div>
          )}

          {selection.multiBlock && persistedPolicy === "ask" && (
            <div className="border-t border-border pt-2 flex flex-col gap-2">
              <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
                {t(
                  "lint.disable.multiBlock",
                  "選択範囲が複数のブロックをまたいでいます",
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {t(
                  "lint.disable.multiBlockExplanation",
                  "TipTap Mark は 1 ブロック内に閉じる仕様のため、以下のいずれかを選んでください:",
                )}
              </div>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  name="multi-block-policy"
                  checked={policy === "block"}
                  onChange={() => setPolicy("block")}
                />
                <span>
                  <strong>
                    {t("lint.disable.blockWide", "ブロック単位で無効化")}
                  </strong>
                  <span className="block text-muted-foreground">
                    {t(
                      "lint.disable.blockWideDesc",
                      "含まれる各ブロック全体に適用",
                    )}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  name="multi-block-policy"
                  checked={policy === "span"}
                  onChange={() => setPolicy("span")}
                />
                <span>
                  <strong>
                    {t("lint.disable.spanPerBlock", "ブロックごとに Span")}
                  </strong>
                  <span className="block text-muted-foreground">
                    {t(
                      "lint.disable.spanPerBlockDesc",
                      "各ブロック内の該当範囲のみに適用",
                    )}
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-xs mt-1 pt-1 border-t border-border/40 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={rememberPolicy}
                  onChange={(e) => setRememberPolicy(e.target.checked)}
                />
                {t(
                  "lint.disable.rememberPolicy",
                  "今後は確認せず常にこの方式で適用",
                )}
              </label>
            </div>
          )}
          {selection.multiBlock && persistedPolicy !== "ask" && (
            <div className="border-t border-border pt-2 text-xs text-muted-foreground flex items-center justify-between gap-2">
              <span>
                {t("lint.disable.selectedPolicy", "複数ブロック選択時の方式: ")}
                <strong>
                  {persistedPolicy === "block"
                    ? t("lint.disable.blockPolicy", "ブロック単位")
                    : t("lint.disable.spanPolicy", "ブロックごとに Span")}
                </strong>
              </span>
              <button
                type="button"
                onClick={() => setMultiBlockPolicy("ask")}
                className="rounded border border-border px-1.5 py-0.5 text-xs hover:bg-accent"
                title={t(
                  "lint.disable.resetToAsk",
                  "次回から確認ダイアログを表示する",
                )}
              >
                {t("lint.disable.resetButton", "毎回確認に戻す")}
              </button>
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1 rounded border border-border hover:bg-accent"
          >
            {t("common.cancel", "キャンセル")}
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={!canApply}
            className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {t("lint.disable.apply", "適用")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Build a `SelectionInfo` from the current editor state. Returns null
 * when nothing is selected (collapsed cursor) — callers should fall
 * back to the enclosing block in that case, or disable the picker.
 */
export function selectionFromEditor(editor: Editor): SelectionInfo | null {
  const sel = editor.state.selection;
  if (sel.empty) return null;
  const { from, to } = sel;
  // Determine multi-block by counting block-kind ancestors between
  // from and to. If the selection's depth-zero blocks differ, it's
  // multi-block.
  const $from = editor.state.doc.resolve(from);
  const $to = editor.state.doc.resolve(to);
  const multiBlock = $from.before(1) !== $to.before(1);
  return { from, to, multiBlock };
}

/**
 * Alternative: derive a `SelectionInfo` from an explicit scene-wide
 * UTF-16 range (used by the Linter panel context menu when it wants
 * to disable a rule at a specific Diagnostic location, not at the
 * user's current selection).
 */
export function selectionFromPmPositions(
  editor: Editor,
  from: number,
  to: number,
): SelectionInfo {
  const $from = editor.state.doc.resolve(from);
  const $to = editor.state.doc.resolve(Math.max(from, to));
  const multiBlock = $from.before(1) !== $to.before(1);
  return { from, to: Math.max(from, to), multiBlock };
}
