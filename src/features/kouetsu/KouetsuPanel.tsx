import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare, OctagonAlert, SearchCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useKouetsuStore, type KouetsuTab } from "./kouetsuStore";
import { IssuesInbox } from "./IssuesInbox";
import { CommentsTab } from "./CommentsTab";
import { BlockerTab } from "./BlockerTab";
import { recordMark } from "@/lib/perfLog";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { PanelHeader } from "@/features/layout/PanelHeader";
import { useIsLiveReaderRunning } from "@/features/post-effect/runStore";
import { ensureLiveReaderTranslations } from "@/locales/liveReader";

ensureLiveReaderTranslations();

const TABS: { id: KouetsuTab; labelKey: string; icon: LucideIcon }[] = [
  { id: "issues", labelKey: "kouetsu.tab.issues", icon: SearchCheck },
  { id: "comments", labelKey: "kouetsu.tab.comments", icon: MessageSquare },
  { id: "blocker", labelKey: "kouetsu.tab.blocker", icon: OctagonAlert },
];

export function KouetsuPanel({ isActive = true }: SlotPanelProps = {}) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const storedTab = useKouetsuStore((s) => s.activeTab);
  const setActiveTab = useKouetsuStore((s) => s.setActiveTab);
  const liveReaderRunning = useIsLiveReaderRunning();
  // persist 済み store から不正値（旧 "editorial" 等）が来ても tab 選択が
  // 壊れないよう既知の tab に正規化する
  const activeTab = TABS.some(({ id }) => id === storedTab)
    ? storedTab
    : TABS[0].id;
  const setPanelActive = useKouetsuStore((s) => s.setPanelActive);

  // keepalive で hidden の間、配下ビューの scene 追従処理を bail させるため
  // パネルの active 状態を store に反映する (isActive 省略時は active 扱い)。
  useEffect(() => {
    setPanelActive(isActive);
  }, [isActive, setPanelActive]);

  const __renderResult = (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as KouetsuTab)}
      className="flex h-full flex-col"
      data-testid="kouetsu-panel"
    >
      <PanelHeader panelId="kouetsu">
        <TabsList aria-label={t("layout.panel.kouetsu")} className="gap-0.5">
          {TABS.map(({ id, labelKey, icon: Icon }) => (
            <TabsTrigger key={id} value={id}>
              <Icon size={12} className="shrink-0" />
              {t(labelKey)}
              {id === "comments" && liveReaderRunning && (
                <span
                  data-testid="comments-live-reader-indicator"
                  aria-label={t("kouetsu.comments.liveReaderRunning")}
                  title={t("kouetsu.comments.liveReaderRunning")}
                  className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                />
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </PanelHeader>
      <TabsContent value="issues" className="min-h-0 flex-1 overflow-hidden">
        <IssuesInbox />
      </TabsContent>
      <TabsContent value="comments" className="min-h-0 flex-1 overflow-hidden">
        <CommentsTab />
      </TabsContent>
      <TabsContent value="blocker" className="min-h-0 flex-1 overflow-hidden">
        <BlockerTab />
      </TabsContent>
    </Tabs>
  );
  recordMark(
    "kouetsuPanel.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
