import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CodexQuickSection } from "./CodexQuickSection";
import { RelatedScenesSection } from "@/features/related-scenes/RelatedScenesSection";
import { CollapsibleSection } from "@/features/layout/CollapsibleSection";
import {
  useCodexStore,
  type CodexSortOrder,
} from "@/features/codex/codexStore";
import { CODEX_SORT_OPTIONS } from "@/features/codex/codexSort";
import { PanelHeader } from "@/features/layout/PanelHeader";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { recordMark } from "@/lib/perfLog";

/**
 * SceneContextPanel — 現在シーンの文脈を 1 パネルにまとめる統合パネル。
 * 旧 CodexQuick (自動検出+ピン留め Codex) と旧「関連する過去シーン」を
 * 縦積みの折りたたみセクションとして吸収したもの。
 *
 * 内部 panel id は `codex-quick` のまま (= CodexQuick 側に吸収)。表示名のみ
 * i18n `layout.panel.codex-quick` 経由で "Scene Context" に解決する。
 */
export function SceneContextPanel({ isActive = true }: SlotPanelProps = {}) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const sortOrder = useCodexStore((s) => s.sortOrder);
  const setSort = useCodexStore((s) => s.setSort);
  const [codexOpen, setCodexOpen] = useState(true);

  // Exclude "most-referenced" — CodexQuick has no ref-count data
  const sortOptions = CODEX_SORT_OPTIONS.filter(
    (opt) => opt.value !== "most-referenced",
  ).map((opt) => ({ ...opt, label: t(opt.key) }));

  const sortSelect = (
    <select
      value={sortOrder === "most-referenced" ? "category" : sortOrder}
      onChange={(e) => setSort(e.target.value as CodexSortOrder)}
      className="rounded border border-input bg-background px-1 py-0.5 text-[10px]"
      title={t("codex.sortOrderTitle")}
    >
      {sortOptions.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );

  const __renderResult = (
    <div className="flex h-full flex-col">
      <PanelHeader panelId="codex-quick" />
      <div className="flex-1 overflow-y-auto">
        <CollapsibleSection
          title={t("sceneContext.codexSection")}
          open={codexOpen}
          onToggle={() => setCodexOpen((v) => !v)}
          actions={sortSelect}
        >
          <CodexQuickSection />
        </CollapsibleSection>
        <RelatedScenesSection enabled={isActive} />
      </div>
    </div>
  );
  recordMark(
    "sceneContextPanel.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
