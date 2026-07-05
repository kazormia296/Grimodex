import { useMemo } from "react";
import { ResizablePanelGroup } from "@/components/ui/resizable";
import { useLintStore } from "@/features/lint/lintStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useKouetsuStore } from "./kouetsuStore";
import { deriveIssueCounts, type IssueCounts } from "./issueCounts";
import { KouetsuScopeBar } from "./KouetsuScopeBar";
import { InboxSection, type CountKey, type SectionDef } from "./InboxSection";
import { LinterSection } from "./sections/LinterSection";
import { TypoSection } from "./sections/TypoSection";
import { ConsistencySection } from "./sections/ConsistencySection";
import { ImpactReviewSection } from "./sections/ImpactReviewSection";
import { ReviewSection } from "./sections/ReviewSection";
import { IntentDriftSection } from "./sections/IntentDriftSection";
import { MetaStructureSection } from "./sections/MetaStructureSection";
import { TimelineConsistencySection } from "./sections/TimelineConsistencySection";

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
