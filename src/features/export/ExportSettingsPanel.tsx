import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
        setPreview(t("export.settings.previewError"));
      }
    }, 200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [nodes, contentMap, checkedIds, settings, t]);

  return (
    <div className="mt-1 max-h-[160px] overflow-y-auto rounded border border-border bg-muted/30 p-2">
      <pre className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground">
        {preview || t("export.settings.noScenesSelected")}
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
  const { t } = useTranslation();

  function update<K extends keyof ExportSettings>(
    key: K,
    value: ExportSettings[K],
  ) {
    onChange({ ...settings, [key]: value });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-2 text-xs">
      {/* 出力形式 */}
      <SectionTitle>{t("export.settings.outputFormat")}</SectionTitle>
      <div className="space-y-1">
        {(
          [
            { value: "plaintext", label: t("export.settings.plaintext") },
            { value: "markdown", label: t("export.settings.markdown") },
            { value: "html", label: t("export.settings.html") },
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
      <SectionTitle>{t("export.settings.folderHeading")}</SectionTitle>
      <div className="space-y-1.5">
        <Checkbox
          checked={settings.folderHeading}
          onChange={(v) => update("folderHeading", v)}
          label={t("export.settings.folderHeadingEnable")}
        />
        {settings.folderHeading && settings.format === "plaintext" && (
          <Row label={t("export.settings.headingSymbol")}>
            <Select
              value={settings.folderHeadingStyle}
              onChange={(v) => update("folderHeadingStyle", v)}
              options={[
                { value: "squares", label: "■□◇" },
                { value: "brackets", label: "【】〈〉「」" },
                {
                  value: "numbers",
                  label: t("export.settings.headingNoSymbol"),
                },
              ]}
            />
          </Row>
        )}
      </div>

      {/* シーン区切り */}
      <SectionTitle>{t("export.settings.sceneDivider")}</SectionTitle>
      <div className="space-y-1.5">
        <Row label={t("export.settings.betweenScenes")}>
          <Select
            value={settings.sceneDivider}
            onChange={(v) => update("sceneDivider", v)}
            options={[
              { value: "blank", label: t("export.settings.blank") },
              { value: "blank2", label: t("export.settings.blank2") },
              { value: "asterisks", label: "* * *" },
              { value: "hr", label: "---" },
              { value: "rule", label: t("export.settings.rule") },
              { value: "none", label: t("export.settings.none") },
              { value: "custom", label: t("export.settings.custom") },
            ]}
          />
        </Row>
        {settings.sceneDivider === "custom" && (
          <input
            type="text"
            value={settings.sceneDividerCustom}
            onChange={(e) => update("sceneDividerCustom", e.target.value)}
            placeholder={t("export.settings.dividerPlaceholder")}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
          />
        )}
        <Row label={t("export.settings.sceneTitle")}>
          <Select
            value={settings.sceneTitle}
            onChange={(v) => update("sceneTitle", v)}
            options={[
              { value: "none", label: t("export.settings.dontInclude") },
              { value: "heading", label: t("export.settings.asHeading") },
              { value: "bold", label: t("export.settings.asBold") },
              { value: "plain", label: t("export.settings.asIs") },
            ]}
          />
        </Row>
      </div>

      {/* 特殊表現 */}
      <SectionTitle>{t("export.settings.specialExpressions")}</SectionTitle>
      <div className="space-y-1.5">
        <Row label={t("export.settings.ruby")}>
          <Select
            value={settings.rubyStyle ?? "auto"}
            onChange={(v) =>
              update(
                "rubyStyle",
                v === "auto" ? null : (v as ExportSettings["rubyStyle"]),
              )
            }
            options={[
              { value: "auto", label: t("export.settings.auto") },
              { value: "html", label: t("export.settings.htmlRuby") },
              { value: "parentheses", label: t("export.settings.parentheses") },
              { value: "aozora", label: t("export.settings.aozora") },
              { value: "aozora-auto", label: t("export.settings.aozoraAuto") },
              {
                value: "narou-parens",
                label: t("export.settings.narouParens"),
              },
              {
                value: "hash-underscore",
                label: t("export.settings.hashUnderscore"),
              },
              { value: "rb-bracket", label: t("export.settings.rbBracket") },
              { value: "mediawiki", label: t("export.settings.mediawiki") },
              { value: "wikiwiki", label: t("export.settings.wikiwiki") },
              { value: "denden", label: t("export.settings.denden") },
              {
                value: "denden-chars",
                label: t("export.settings.dendenChars"),
              },
              { value: "renpy", label: t("export.settings.renpy") },
              {
                value: "game-engine",
                label: t("export.settings.gameEngine"),
              },
              { value: "base", label: t("export.settings.baseOnly") },
            ]}
          />
        </Row>
        <Row label={t("export.settings.emphasisDots")}>
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
              { value: "auto", label: t("export.settings.auto") },
              { value: "html", label: t("export.settings.htmlTag") },
              { value: "aozora", label: t("export.settings.aozora") },
              { value: "double-angle", label: "《《》》" },
              { value: "plain", label: t("export.settings.plain") },
            ]}
          />
        </Row>
        <Row label={t("export.settings.sceneBreak")}>
          <Select
            value={settings.sceneBreakStyle}
            onChange={(v) => update("sceneBreakStyle", v)}
            options={[
              { value: "asterisks", label: "* * *" },
              { value: "hr", label: "---" },
              { value: "blank", label: t("export.settings.blank") },
              { value: "custom", label: t("export.settings.custom") },
            ]}
          />
        </Row>
        {settings.sceneBreakStyle === "custom" && (
          <input
            type="text"
            value={settings.sceneBreakCustom}
            onChange={(e) => update("sceneBreakCustom", e.target.value)}
            placeholder={t("export.settings.breakPlaceholder")}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
          />
        )}
      </div>

      {/* ゴミ箱の中身 (設計書 §3.5) */}
      <SectionTitle>{t("export.settings.trashBin", "ゴミ箱")}</SectionTitle>
      <div className="space-y-3 pl-2">
        <Checkbox
          checked={settings.includeTrashBin}
          onChange={(v) => update("includeTrashBin", v)}
          label={t("trashBin.includeInExport", "ゴミ箱の内容を含める")}
        />
      </div>

      {/* プレビュー */}
      <SectionTitle>{t("export.settings.preview")}</SectionTitle>
      <ExportPreview
        nodes={nodes}
        contentMap={contentMap}
        checkedIds={checkedIds}
        settings={settings}
      />
    </div>
  );
}
