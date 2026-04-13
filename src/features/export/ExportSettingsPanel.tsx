import { useEffect, useRef, useState } from "react";
import type { ExportSettings } from "./types";
import { generateExport } from "./exportEngine";
import type { TreeNodeData } from "@/features/tree/treeStore";

// ────────────────────────────────────────────────────────────────────
// 汎用 UI パーツ
// ────────────────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 mb-2 border-b border-border pb-1 text-xs font-semibold text-foreground">
      {children}
    </p>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground hover:bg-accent"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border"
      />
      {label}
    </label>
  );
}

// ────────────────────────────────────────────────────────────────────
// プレビュー
// ────────────────────────────────────────────────────────────────────

function ExportPreview({
  nodes,
  contentMap,
  checkedIds,
  settings,
}: {
  nodes: TreeNodeData[];
  contentMap: Record<string, string>;
  checkedIds: Set<string>;
  settings: ExportSettings;
}) {
  const [preview, setPreview] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        const full = generateExport({
          nodes,
          contentMap,
          checkedIds,
          settings,
        });
        setPreview(full.slice(0, 400));
      } catch {
        setPreview("(プレビュー生成エラー)");
      }
    }, 200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [nodes, contentMap, checkedIds, settings]);

  return (
    <div className="mt-1 max-h-[160px] overflow-y-auto rounded border border-border bg-muted/30 p-2">
      <pre className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground">
        {preview || "(シーンが選択されていません)"}
      </pre>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// ExportSettingsPanel
// ────────────────────────────────────────────────────────────────────

interface Props {
  settings: ExportSettings;
  onChange: (next: ExportSettings) => void;
  nodes: TreeNodeData[];
  contentMap: Record<string, string>;
  checkedIds: Set<string>;
}

export function ExportSettingsPanel({
  settings,
  onChange,
  nodes,
  contentMap,
  checkedIds,
}: Props) {
  function update<K extends keyof ExportSettings>(
    key: K,
    value: ExportSettings[K],
  ) {
    onChange({ ...settings, [key]: value });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-2 text-xs">
      {/* 出力形式 */}
      <SectionTitle>出力形式</SectionTitle>
      <div className="space-y-1">
        {(
          [
            { value: "plaintext", label: "プレーンテキスト (.txt)" },
            { value: "markdown", label: "Markdown (.md)" },
            { value: "html", label: "HTML (.html)" },
          ] as const
        ).map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer items-center gap-2"
          >
            <input
              type="radio"
              name="export-format"
              value={opt.value}
              checked={settings.format === opt.value}
              onChange={() => update("format", opt.value)}
              className="h-3.5 w-3.5"
            />
            <span className="text-foreground">{opt.label}</span>
          </label>
        ))}
      </div>

      {/* フォルダー見出し */}
      <SectionTitle>フォルダー見出し</SectionTitle>
      <div className="space-y-1.5">
        <Checkbox
          checked={settings.folderHeading}
          onChange={(v) => update("folderHeading", v)}
          label="フォルダー名を見出しにする"
        />
        {settings.folderHeading && settings.format === "plaintext" && (
          <Row label="見出し記号">
            <Select
              value={settings.folderHeadingStyle}
              onChange={(v) => update("folderHeadingStyle", v)}
              options={[
                { value: "squares", label: "■□◇" },
                { value: "brackets", label: "【】〈〉「」" },
                { value: "numbers", label: "記号なし" },
              ]}
            />
          </Row>
        )}
      </div>

      {/* シーン区切り */}
      <SectionTitle>シーン区切り</SectionTitle>
      <div className="space-y-1.5">
        <Row label="シーン間">
          <Select
            value={settings.sceneDivider}
            onChange={(v) => update("sceneDivider", v)}
            options={[
              { value: "blank", label: "空行" },
              { value: "blank2", label: "空行×2" },
              { value: "asterisks", label: "* * *" },
              { value: "hr", label: "---" },
              { value: "rule", label: "罫線" },
              { value: "none", label: "なし" },
              { value: "custom", label: "カスタム" },
            ]}
          />
        </Row>
        {settings.sceneDivider === "custom" && (
          <input
            type="text"
            value={settings.sceneDividerCustom}
            onChange={(e) => update("sceneDividerCustom", e.target.value)}
            placeholder="区切り文字を入力"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
          />
        )}
        <Row label="シーンタイトル">
          <Select
            value={settings.sceneTitle}
            onChange={(v) => update("sceneTitle", v)}
            options={[
              { value: "none", label: "含めない" },
              { value: "heading", label: "見出しとして" },
              { value: "bold", label: "太字として" },
              { value: "plain", label: "そのまま" },
            ]}
          />
        </Row>
      </div>

      {/* 特殊表現 */}
      <SectionTitle>特殊表現</SectionTitle>
      <div className="space-y-1.5">
        <Row label="ルビ">
          <Select
            value={settings.rubyStyle ?? "auto"}
            onChange={(v) =>
              update(
                "rubyStyle",
                v === "auto" ? null : (v as ExportSettings["rubyStyle"]),
              )
            }
            options={[
              { value: "auto", label: "自動" },
              { value: "html", label: "HTML rubyタグ" },
              { value: "parentheses", label: "括弧表記" },
              { value: "aozora", label: "青空文庫形式" },
              { value: "base", label: "ベースのみ" },
            ]}
          />
        </Row>
        <Row label="傍点">
          <Select
            value={settings.emphasisDotsStyle ?? "auto"}
            onChange={(v) =>
              update(
                "emphasisDotsStyle",
                v === "auto"
                  ? null
                  : (v as ExportSettings["emphasisDotsStyle"]),
              )
            }
            options={[
              { value: "auto", label: "自動" },
              { value: "html", label: "HTMLタグ" },
              { value: "aozora", label: "青空文庫形式" },
              { value: "double-angle", label: "《《》》" },
              { value: "plain", label: "そのまま" },
            ]}
          />
        </Row>
        <Row label="シーンブレイク">
          <Select
            value={settings.sceneBreakStyle}
            onChange={(v) => update("sceneBreakStyle", v)}
            options={[
              { value: "asterisks", label: "* * *" },
              { value: "hr", label: "---" },
              { value: "blank", label: "空行" },
              { value: "custom", label: "カスタム" },
            ]}
          />
        </Row>
        {settings.sceneBreakStyle === "custom" && (
          <input
            type="text"
            value={settings.sceneBreakCustom}
            onChange={(e) => update("sceneBreakCustom", e.target.value)}
            placeholder="ブレイク文字を入力"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
          />
        )}
      </div>

      {/* プレビュー */}
      <SectionTitle>プレビュー</SectionTitle>
      <ExportPreview
        nodes={nodes}
        contentMap={contentMap}
        checkedIds={checkedIds}
        settings={settings}
      />
    </div>
  );
}
