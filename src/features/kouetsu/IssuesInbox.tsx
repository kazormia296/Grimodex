import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useLintStore } from "@/features/lint/lintStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useKouetsuStore } from "./kouetsuStore";
import { deriveIssueCounts, type IssueCounts } from "./issueCounts";
import { KouetsuScopeBar } from "./KouetsuScopeBar";
import { SectionHeader } from "./SectionHeader";
import { LinterSection } from "./sections/LinterSection";
import { TypoSection } from "./sections/TypoSection";
import { ConsistencySection } from "./sections/ConsistencySection";
import { ImpactReviewSection } from "./sections/ImpactReviewSection";
import { ReviewSection } from "./sections/ReviewSection";
import { IntentDriftSection } from "./sections/IntentDriftSection";
import { MetaStructureSection } from "./sections/MetaStructureSection";
import { TimelineConsistencySection } from "./sections/TimelineConsistencySection";

/** ヘッダ件数バッジに使う IssueCounts の数値キー。 */
type CountKey =
  | "linterCount"
  | "typoCount"
  | "consistencyCount"
  | "impactCount"
  | "reviewCount"
  | "intentCount";

interface SectionDef {
  key: string;
  titleKey: string;
  defaultExpanded: boolean;
  countKey: CountKey | null;
  Body: () => ReactElement;
  /** ヘッダ右端の補助表示（校正=自動検出ラベルのみ）。 */
  actionKey?: string;
}

// 機械系 → 批評系の固定順。「指摘/批評」はタブではなく並び順に降格する。
const SECTIONS: SectionDef[] = [
  {
    key: "linter",
    titleKey: "settings.linter.proofreading",
    defaultExpanded: true,
    countKey: "linterCount",
    Body: LinterSection,
    actionKey: "settings.ai.autoDetect",
  },
  {
    key: "typo",
    titleKey: "kouetsu.issues.typo",
    defaultExpanded: true,
    countKey: "typoCount",
    Body: TypoSection,
  },
  {
    key: "consistency",
    titleKey: "codex.tab.consistency",
    defaultExpanded: true,
    countKey: "consistencyCount",
    Body: ConsistencySection,
  },
  {
    key: "impact",
    titleKey: "kouetsu.impactReview.title",
    defaultExpanded: false,
    countKey: "impactCount",
    Body: ImpactReviewSection,
  },
  {
    key: "review",
    titleKey: "kouetsu.editorial.review",
    defaultExpanded: false,
    countKey: "reviewCount",
    Body: ReviewSection,
  },
  {
    key: "intent",
    titleKey: "kouetsu.editorial.intentDrift",
    defaultExpanded: false,
    countKey: "intentCount",
    Body: IntentDriftSection,
  },
  {
    key: "meta",
    titleKey: "kouetsu.editorial.metaStructure",
    defaultExpanded: false,
    countKey: null,
    Body: MetaStructureSection,
  },
  {
    key: "timeline",
    titleKey: "kouetsu.editorial.timeline",
    defaultExpanded: false,
    countKey: null,
    Body: TimelineConsistencySection,
  },
];

/**
 * 指摘/批評タブを 1 つに統合した受信箱。8 観点グループを機械系→批評系の固定順で
 * 縦に並べ、KouetsuScopeBar のスコープ/ステータスフィルタを全グループで共有する。
 * 折りたたみ中のグループは Body を mount しない（project フェッチの束を避ける）。
 */
export function IssuesInbox() {
  const scope = useKouetsuStore((s) => s.scope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const diagnostics = useLintStore((s) => s.diagnostics);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);

  const counts = useMemo(
    () =>
      deriveIssueCounts({
        diagnostics,
        annotationsByScene,
        scope,
        statusFilter,
        activeSceneId,
      }),
    [diagnostics, annotationsByScene, scope, statusFilter, activeSceneId],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <KouetsuScopeBar />
      <ResizablePanelGroup
        orientation="vertical"
        className="flex-1 overflow-hidden"
      >
        {SECTIONS.map((def, i) => (
          <InboxSection
            key={def.key}
            def={def}
            count={countFor(counts, def.countKey)}
            withHandle={i > 0}
          />
        ))}
      </ResizablePanelGroup>
    </div>
  );
}

function countFor(counts: IssueCounts, key: CountKey | null): number | null {
  return key ? counts[key] : null;
}

function InboxSection({
  def,
  count,
  withHandle,
}: {
  def: SectionDef;
  count: number | null;
  withHandle: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(def.defaultExpanded);
  const ref = usePanelRef();

  // react-resizable-panels v4 に defaultCollapsed 相当が無いため、既定折りたたみの
  // パネルはマウント後に collapse() する。expanded state 自体は初期値で正しいので、
  // これはパネル実寸を合わせるためだけの副作用。
  useEffect(() => {
    if (!def.defaultExpanded) ref.current?.collapse();
    // マウント時のみ。ref/def は不変。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // クリック時は expanded state を直接切り替える（onResize に依存しない）。
  // パネル実寸も追随させるため ref も駆動する。
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) ref.current?.expand();
    else ref.current?.collapse();
  };

  return (
    <>
      {withHandle && <ResizableHandle horizontal withHandle />}
      <ResizablePanel
        panelRef={ref}
        collapsible
        collapsedSize={32}
        minSize="10%"
        defaultSize={def.defaultExpanded ? "22%" : undefined}
        onResize={() => setExpanded(!(ref.current?.isCollapsed() ?? false))}
        className="flex flex-col overflow-hidden"
      >
        <SectionHeader
          title={t(def.titleKey)}
          count={count ?? 0}
          expanded={expanded}
          onToggle={toggle}
          action={
            def.actionKey ? (
              <span className="text-[10px] text-muted-foreground">
                {t(def.actionKey)}
              </span>
            ) : undefined
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {expanded && <def.Body />}
        </div>
      </ResizablePanel>
    </>
  );
}
