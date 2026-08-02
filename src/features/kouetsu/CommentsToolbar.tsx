import { useTranslation } from "react-i18next";
import {
  ArrowDownUp,
  Bot,
  EyeOff,
  Loader2,
  MessagesSquare,
  Radio,
  RefreshCw,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { KouetsuScopePicker } from "./KouetsuScopePicker";
import { PseudoCommentRunControl } from "./PseudoCommentRunControl";
import type { CommentSortOrder, Filter } from "./commentsAggregation";
import { Switch } from "@/components/ui/switch";
import { ensureLiveReaderTranslations } from "@/locales/liveReader";

ensureLiveReaderTranslations();

interface Props {
  filter: Filter;
  onFilterChange: (filter: Filter) => void;
  showDismissed: boolean;
  onShowDismissedChange: (showDismissed: boolean) => void;
  sortOrder: CommentSortOrder;
  onSortOrderChange: (sortOrder: CommentSortOrder) => void;
  liveReaderEnabled: boolean;
  onLiveReaderEnabledChange: (enabled: boolean) => void;
  liveReaderRunning: boolean;
  onPseudoCompleted: () => Promise<void> | void;
  onReload: () => Promise<void> | void;
}

export function CommentsToolbar({
  filter,
  onFilterChange,
  showDismissed,
  onShowDismissedChange,
  sortOrder,
  onSortOrderChange,
  liveReaderEnabled,
  onLiveReaderEnabledChange,
  liveReaderRunning,
  onPseudoCompleted,
  onReload,
}: Props) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="comments-toolbar"
      className="grid shrink-0 gap-y-1 border-b border-border bg-muted/20 px-2 py-1 text-xs"
    >
      <div
        data-testid="comments-toolbar-filters"
        className="flex min-w-0 items-center gap-x-1.5 overflow-x-auto"
      >
        <div className="shrink-0">
          <KouetsuScopePicker />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(
            [
              ["all", t("snippets.filterAll"), MessagesSquare],
              ["human", t("scenes.sortManual"), User],
              ["ai", t("attribution.columnAi"), Bot],
            ] as const satisfies readonly [Filter, string, LucideIcon][]
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => onFilterChange(id)}
              className={cn(
                "flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5",
                filter === id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              <Icon size={11} className="shrink-0" />
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={showDismissed}
            onClick={() => onShowDismissedChange(!showDismissed)}
            className={cn(
              "flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5",
              showDismissed
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <EyeOff size={11} className="shrink-0" />
            {t("kouetsu.filter.dismissed")}
          </button>
        </div>
      </div>

      <div
        data-testid="comments-toolbar-actions"
        className="grid min-w-0 grid-rows-[auto_auto] gap-y-1"
      >
        <div
          data-testid="comments-toolbar-reader"
          className="flex min-w-0 items-center gap-1.5 overflow-hidden"
          title={t("kouetsu.comments.liveReaderHelp")}
        >
          <div className="min-w-0 flex-1">
            <PseudoCommentRunControl onCompleted={onPseudoCompleted} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-muted-foreground">
            <Radio
              size={12}
              className={cn("shrink-0", liveReaderEnabled && "text-primary")}
            />
            <span className="whitespace-nowrap text-[10px]">
              {t("kouetsu.comments.liveReader")}
            </span>
            {liveReaderRunning && (
              <Loader2
                size={11}
                className="shrink-0 animate-spin text-primary"
                aria-label={t("kouetsu.comments.liveReaderRunning")}
              />
            )}
            <Switch
              size="sm"
              checked={liveReaderEnabled}
              onCheckedChange={onLiveReaderEnabledChange}
              aria-label={t("kouetsu.comments.liveReader")}
            />
          </div>
        </div>

        <div
          data-testid="comments-toolbar-list"
          className="flex min-w-0 items-center justify-between gap-1.5"
        >
          <div className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground">
            <ArrowDownUp size={12} className="shrink-0" />
            <label htmlFor="kouetsu-comments-sort" className="sr-only">
              {t("kouetsu.comments.sortLabel")}
            </label>
            <select
              id="kouetsu-comments-sort"
              value={sortOrder}
              onChange={(event) =>
                onSortOrderChange(event.target.value as CommentSortOrder)
              }
              aria-label={t("kouetsu.comments.sortLabel")}
              className="max-w-28 truncate rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground outline-none"
            >
              <option value="newest">{t("kouetsu.comments.sortNewest")}</option>
              <option value="oldest">{t("kouetsu.comments.sortOldest")}</option>
              <option value="scene">{t("kouetsu.comments.sortScene")}</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => void onReload()}
            title={t("error.reload")}
            aria-label={t("error.reload")}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
