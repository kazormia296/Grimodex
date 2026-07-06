import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";
import { ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { SectionHeader } from "./SectionHeader";

/** ヘッダ件数バッジに使う IssueCounts の数値キー。 */
export type CountKey =
  | "linterCount"
  | "typoCount"
  | "consistencyCount"
  | "impactCount"
  | "reviewCount"
  | "intentCount";

export interface SectionDef {
  key: string;
  titleKey: string;
  defaultExpanded: boolean;
  countKey: CountKey | null;
  Body: () => ReactElement;
  /** ヘッダ右端の補助表示（校正=自動検出ラベルのみ）。 */
  actionKey?: string;
}

/**
 * IssuesInbox の観点グループ 1 枠分。折りたたみ中は Body を mount しない
 * （project フェッチの束を避ける）。
 */
export function InboxSection({
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
