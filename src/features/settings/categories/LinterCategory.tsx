import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";

import {
  useLintConfigStore,
  BUILTIN_DEFAULT_CONFIG,
} from "@/features/lint/lintConfigStore";
import { LinterIgnoreListTab } from "@/features/lint/LinterIgnoreListTab";
import { TermDictionaryTab } from "@/features/lint/TermDictionaryTab";
import { cn } from "@/lib/utils";
import type { Severity } from "@/features/lint/types";

type Tab = "rules" | "terms" | "ignores";

export function LinterCategory() {
  const [activeTab, setActiveTab] = useState<Tab>("rules");

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-0 border-b border-border px-4 pt-3">
        {(
          [
            { id: "rules", label: "ルール設定" },
            { id: "terms", label: "用語辞書" },
            { id: "ignores", label: "無視リスト" },
          ] as const
        ).map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={cn(
              "px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors",
              activeTab === id
                ? "border-foreground text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {activeTab === "rules" && <LinterRulesTab />}
      {activeTab === "terms" && <TermDictionaryTab />}
      {activeTab === "ignores" && <LinterIgnoreListTab />}
    </div>
  );
}

function LinterRulesTab() {
  const effective = useLintConfigStore((s) => s.getEffective());
  const setLinterEnabled = useLintConfigStore((s) => s.setLinterEnabled);
  const setLanguageEnabled = useLintConfigStore((s) => s.setLanguageEnabled);
  const setRule = useLintConfigStore((s) => s.setRule);
  const resetRule = useLintConfigStore((s) => s.resetRule);
  const resetLanguage = useLintConfigStore((s) => s.resetLanguage);
  const resetAll = useLintConfigStore((s) => s.resetAll);

  const groupedRules = useMemo(() => {
    // `project/` and `codex/` are language-neutral but Settings groups
    // them with Japanese rules by default — same as the Rust engine's
    // rules/mod.rs registration order.
    const groups: Record<"ja" | "en" | "project" | "codex", string[]> = {
      ja: [],
      en: [],
      project: [],
      codex: [],
    };
    for (const id of Object.keys(effective.rules).sort()) {
      if (id.startsWith("ja/")) groups.ja.push(id);
      else if (id.startsWith("en/")) groups.en.push(id);
      else if (id.startsWith("project/")) groups.project.push(id);
      else if (id.startsWith("codex/")) groups.codex.push(id);
    }
    return groups;
  }, [effective.rules]);

  return (
    <div className="flex flex-col gap-6 p-6 text-sm">
      <section>
        <h3 className="mb-3 text-base font-semibold">校正</h3>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={effective.enabled}
            onChange={(e) => setLinterEnabled(e.target.checked)}
          />
          校正 を有効にする
        </label>
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm(
                "校正 設定をすべてデフォルトに戻します。よろしいですか？",
              )
            ) {
              resetAll();
            }
          }}
          className="mt-2 flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
        >
          <RotateCcw className="h-3.5 w-3.5" /> 全ルールをデフォルトに戻す
        </button>
      </section>

      {(["ja", "en"] as const).map((lang) => (
        <section key={lang} className="flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-border pb-1">
            <h4 className="font-semibold">
              {lang === "ja" ? "日本語ルール" : "英語ルール"}
            </h4>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={effective.languages[lang].enabled}
                  onChange={(e) => setLanguageEnabled(lang, e.target.checked)}
                />
                言語全体を有効
              </label>
              <button
                type="button"
                onClick={() => resetLanguage(lang)}
                className="rounded border border-border px-1.5 py-0.5 text-xs hover:bg-accent"
                title={`${lang === "ja" ? "日本語" : "英語"}のルールをデフォルトに戻す`}
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div className="flex flex-col divide-y divide-border rounded border border-border">
            {groupedRules[lang].map((ruleId) => (
              <RuleRow
                key={ruleId}
                ruleId={ruleId}
                disabledByLanguage={!effective.languages[lang].enabled}
                onSetRule={setRule}
                onResetRule={resetRule}
              />
            ))}
          </div>
        </section>
      ))}

      {(["project", "codex"] as const).map((group) => {
        const rules = groupedRules[group];
        if (rules.length === 0) return null;
        return (
          <section key={group} className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-border pb-1">
              <h4 className="font-semibold">
                {group === "project" ? "プロジェクト連動" : "Codex 連動"}
              </h4>
            </div>
            <div className="flex flex-col divide-y divide-border rounded border border-border">
              {rules.map((ruleId) => (
                <RuleRow
                  key={ruleId}
                  ruleId={ruleId}
                  disabledByLanguage={false}
                  onSetRule={setRule}
                  onResetRule={resetRule}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const SEVERITY_OPTIONS: Array<{ value: Severity | "default"; label: string }> =
  [
    { value: "default", label: "既定" },
    { value: "error", label: "Error" },
    { value: "warning", label: "Warning" },
    { value: "info", label: "Info" },
  ];

function RuleRow({
  ruleId,
  disabledByLanguage,
  onSetRule,
  onResetRule,
}: {
  ruleId: string;
  disabledByLanguage: boolean;
  onSetRule: (ruleId: string, patch: Record<string, unknown>) => void;
  onResetRule: (ruleId: string) => void;
}) {
  const rule = useLintConfigStore((s) => s.getEffective().rules[ruleId]);
  if (!rule) return null;

  const enabled = rule.enabled ?? true;
  const severity = rule.severity ?? "default";
  const builtinDefault = BUILTIN_DEFAULT_CONFIG.rules[ruleId];
  // `project/term-consistency` uses per-entry severity; rule-level
  // severity would be meaningless and could drift from what the
  // dictionary surfaces, so we lock the dropdown.
  const severityDisabled = ruleId === "project/term-consistency";

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2">
        <label className="flex flex-1 items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabledByLanguage}
            onChange={(e) => onSetRule(ruleId, { enabled: e.target.checked })}
          />
          <code className="text-xs">{ruleId}</code>
          {builtinDefault?.enabled === false && (
            <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
              default off
            </span>
          )}
        </label>
        <select
          value={severity}
          disabled={disabledByLanguage || !enabled || severityDisabled}
          title={severityDisabled ? "エントリごとに設定" : undefined}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "default") onSetRule(ruleId, { severity: undefined });
            else onSetRule(ruleId, { severity: v as Severity });
          }}
          className="h-6 rounded border border-border bg-background px-1 text-xs disabled:opacity-50"
        >
          {SEVERITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onResetRule(ruleId)}
          className="rounded border border-border p-1 text-xs hover:bg-accent"
          title="このルールをデフォルトに戻す"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
      <RuleOptions ruleId={ruleId} rule={rule} onSetRule={onSetRule} />
    </div>
  );
}

function RuleOptions({
  ruleId,
  rule,
  onSetRule,
}: {
  ruleId: string;
  rule: { options?: Record<string, unknown> };
  onSetRule: (ruleId: string, patch: Record<string, unknown>) => void;
}) {
  const options = rule.options ?? {};

  if (ruleId === "ja/sentence-length") {
    const warnAt = Number(options.warnAt ?? 80);
    const errorAt = Number(options.errorAt ?? 120);
    return (
      <div className="flex items-center gap-3 pl-6 text-xs text-muted-foreground">
        <label className="flex items-center gap-1">
          Warn
          <input
            type="number"
            min={1}
            max={999}
            value={warnAt}
            onChange={(e) =>
              onSetRule(ruleId, { options: { warnAt: Number(e.target.value) } })
            }
            className="h-6 w-14 rounded border border-border bg-background px-1 text-right"
          />
          文字
        </label>
        <label className="flex items-center gap-1">
          Error
          <input
            type="number"
            min={1}
            max={999}
            value={errorAt}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { errorAt: Number(e.target.value) },
              })
            }
            className="h-6 w-14 rounded border border-border bg-background px-1 text-right"
          />
          文字
        </label>
      </div>
    );
  }

  if (ruleId === "ja/quote-period") {
    const policy = (options.policy as string) ?? "strip";
    return (
      <div className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
        方針
        <select
          value={policy}
          onChange={(e) =>
            onSetRule(ruleId, { options: { policy: e.target.value } })
          }
          className="h-6 rounded border border-border bg-background px-1"
        >
          <option value="strip">strip（句点を削除）</option>
          <option value="require">require（句点を付与）</option>
          <option value="preserve">preserve（検出しない）</option>
        </select>
      </div>
    );
  }

  if (ruleId === "ja/halfwidth-fullwidth-mix") {
    const policy = (options.policy as string) ?? "all-halfwidth";
    return (
      <div className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
        方針
        <select
          value={policy}
          onChange={(e) =>
            onSetRule(ruleId, { options: { policy: e.target.value } })
          }
          className="h-6 rounded border border-border bg-background px-1"
        >
          <option value="all-halfwidth">all-halfwidth（英数字は半角）</option>
          <option value="all-fullwidth">all-fullwidth（英数字は全角）</option>
          <option value="ja-halfwidth-with-exceptions">
            ja-halfwidth-with-exceptions（日本語文中は半角、1桁数字は全角）
          </option>
          <option value="off">off</option>
        </select>
      </div>
    );
  }

  if (ruleId === "ja/particle-no-chain") {
    const threshold = Number(options.threshold ?? 3);
    return (
      <div className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
        <label className="flex items-center gap-1">
          連続「の」が
          <input
            type="number"
            min={2}
            max={10}
            value={threshold}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { threshold: Number(e.target.value) },
              })
            }
            className="h-6 w-12 rounded border border-border bg-background px-1 text-right"
          />
          個以上で検出
        </label>
      </div>
    );
  }

  if (ruleId === "ja/word-repetition") {
    const distanceChars = Number(options.distance_chars ?? 50);
    const minLength = Number(options.min_length ?? 2);
    return (
      <div className="flex items-center gap-3 pl-6 text-xs text-muted-foreground flex-wrap">
        <label className="flex items-center gap-1">
          検出ウィンドウ
          <input
            type="number"
            min={10}
            max={500}
            value={distanceChars}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { distance_chars: Number(e.target.value) },
              })
            }
            className="h-6 w-16 rounded border border-border bg-background px-1 text-right"
          />
          文字
        </label>
        <label className="flex items-center gap-1">
          最小語長
          <input
            type="number"
            min={1}
            max={20}
            value={minLength}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { min_length: Number(e.target.value) },
              })
            }
            className="h-6 w-12 rounded border border-border bg-background px-1 text-right"
          />
          文字
        </label>
      </div>
    );
  }

  if (ruleId === "ja/kanji-hiragana-chain") {
    const kanjiThreshold = Number(options.kanji_threshold ?? 6);
    const hiraganaThreshold = Number(options.hiragana_threshold ?? 20);
    return (
      <div className="flex items-center gap-3 pl-6 text-xs text-muted-foreground flex-wrap">
        <label className="flex items-center gap-1">
          漢字連続
          <input
            type="number"
            min={2}
            max={30}
            value={kanjiThreshold}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { kanji_threshold: Number(e.target.value) },
              })
            }
            className="h-6 w-12 rounded border border-border bg-background px-1 text-right"
          />
          文字以上
        </label>
        <label className="flex items-center gap-1">
          ひらがな連続
          <input
            type="number"
            min={5}
            max={100}
            value={hiraganaThreshold}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { hiragana_threshold: Number(e.target.value) },
              })
            }
            className="h-6 w-12 rounded border border-border bg-background px-1 text-right"
          />
          文字以上
        </label>
      </div>
    );
  }

  if (ruleId === "en/sentence-length") {
    const warnAtWords = Number(options.warnAtWords ?? 35);
    const errorAtWords = Number(options.errorAtWords ?? 60);
    return (
      <div className="flex items-center gap-3 pl-6 text-xs text-muted-foreground">
        <label className="flex items-center gap-1">
          Warn
          <input
            type="number"
            min={1}
            max={300}
            value={warnAtWords}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { warnAtWords: Number(e.target.value) },
              })
            }
            className="h-6 w-14 rounded border border-border bg-background px-1 text-right"
          />
          words
        </label>
        <label className="flex items-center gap-1">
          Error
          <input
            type="number"
            min={1}
            max={300}
            value={errorAtWords}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { errorAtWords: Number(e.target.value) },
              })
            }
            className="h-6 w-14 rounded border border-border bg-background px-1 text-right"
          />
          words
        </label>
      </div>
    );
  }

  if (ruleId === "en/word-repetition") {
    const distanceWords = Number(options.distance_words ?? 30);
    const minLength = Number(options.min_length ?? 4);
    return (
      <div className="flex items-center gap-3 pl-6 text-xs text-muted-foreground flex-wrap">
        <label className="flex items-center gap-1">
          Window
          <input
            type="number"
            min={2}
            max={200}
            value={distanceWords}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { distance_words: Number(e.target.value) },
              })
            }
            className="h-6 w-16 rounded border border-border bg-background px-1 text-right"
          />
          words
        </label>
        <label className="flex items-center gap-1">
          Min length
          <input
            type="number"
            min={1}
            max={20}
            value={minLength}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { min_length: Number(e.target.value) },
              })
            }
            className="h-6 w-12 rounded border border-border bg-background px-1 text-right"
          />
          chars
        </label>
      </div>
    );
  }

  if (ruleId === "en/sentence-starters") {
    const threshold = Number(options.threshold ?? 3);
    return (
      <div className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
        <label className="flex items-center gap-1">
          Flag after
          <input
            type="number"
            min={2}
            max={10}
            value={threshold}
            onChange={(e) =>
              onSetRule(ruleId, {
                options: { threshold: Number(e.target.value) },
              })
            }
            className="h-6 w-12 rounded border border-border bg-background px-1 text-right"
          />
          repeats
        </label>
      </div>
    );
  }

  return null;
}
