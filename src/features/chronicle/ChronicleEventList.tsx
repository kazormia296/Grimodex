import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, Lock, AlertTriangle } from "lucide-react";
import type { EventKind, EventPrecision } from "@/db/schema";
import { laneColorFor } from "./laneColor";

/** サイドペインのイベント一覧 1 行分の表示情報（親で算出して渡す純データ）。 */
export interface ChronicleEventListItem {
  id: string;
  title: string;
  kind: EventKind;
  precision: EventPrecision;
  secret: boolean;
  /** 期間（終了あり）か点か。先頭グリフの形に反映。 */
  isInterval: boolean;
  primaryCodexId: string | null;
  /** 解決済みレーン名（未割当は null）。 */
  laneName: string | null;
  /** 整形済み開始日付ラベル（無時刻/並び順モードは null）。 */
  dateLabel: string | null;
  /** 並べ替えキー（年表上の開始日。無時刻は null=末尾）。 */
  startDay: number | null;
  /** 整合警告を持つか。 */
  hasIssue: boolean;
}

export interface ChronicleEventListProps {
  items: ChronicleEventListItem[];
  selectedId: string | null;
  /** レーン絞り込み用の候補（id=codexId / name=表示名）。 */
  laneOptions: { id: string; name: string }[];
  /** 行クリック＝ナビゲーション（選択＋ビューを当該イベントへ寄せる）。 */
  onSelect: (id: string) => void;
  onClose: () => void;
}

const KIND_FILTERS: EventKind[] = ["generic", "birth", "death"];
const UNASSIGNED = "__unassigned";
const selectCls =
  "h-7 min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 text-xs text-foreground outline-none";

/**
 * 作中年表のサイドペイン・イベント一覧（検索・フィルター・クリックでナビゲーション）。
 * フィルタ/並べ替えはこのコンポーネント内で完結（純データ items を受け取るだけ）。
 * 並びは年表開始日の昇順（無時刻は末尾）→ タイトル。決定性: 乱数/時刻なし。
 */
export function ChronicleEventList({
  items,
  selectedId,
  laneOptions,
  onSelect,
  onClose,
}: ChronicleEventListProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [lane, setLane] = useState<string>("all");
  const [kind, setKind] = useState<string>("all");

  const kindLabel = (k: EventKind) =>
    k === "birth"
      ? t("chronicle.kind.birth", "出生")
      : k === "death"
        ? t("chronicle.kind.death", "死亡")
        : t("chronicle.kind.generic", "出来事");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = items.filter((it) => {
      if (lane === UNASSIGNED) {
        if (it.primaryCodexId) return false;
      } else if (lane !== "all" && it.primaryCodexId !== lane) {
        return false;
      }
      if (kind !== "all" && it.kind !== kind) return false;
      if (q) {
        const hay = `${it.title} ${it.laneName ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return out.sort((a, b) => {
      const ad = a.startDay ?? Infinity;
      const bd = b.startDay ?? Infinity;
      if (ad !== bd) return ad - bd;
      return a.title.localeCompare(b.title);
    });
  }, [items, query, lane, kind]);

  const dotStyle = (it: ChronicleEventListItem): CSSProperties =>
    it.isInterval
      ? {
          flex: "none",
          width: 12,
          height: 6,
          borderRadius: 3,
          background: laneColorFor(it.primaryCodexId),
        }
      : {
          flex: "none",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: laneColorFor(it.primaryCodexId),
        };

  return (
    <div
      data-testid="chronicle-event-list"
      className="flex w-60 flex-none flex-col overflow-hidden border-r border-border"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium">
          {t("chronicle.eventList", "イベント一覧")}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {filtered.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ms-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("chronicle.close", "閉じる")}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder={t("chronicle.eventListSearch", "タイトルで検索")}
          aria-label={t("chronicle.eventListSearch", "タイトルで検索")}
          data-testid="chronicle-event-list-search"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
      </div>

      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <select
          value={lane}
          onChange={(e) => setLane(e.target.value)}
          aria-label={t("chronicle.filterLane", "レーンで絞り込み")}
          className={selectCls}
        >
          <option value="all">
            {t("chronicle.filterAllLanes", "すべてのレーン")}
          </option>
          {laneOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          <option value={UNASSIGNED}>
            {t("chronicle.unassigned", "未割当")}
          </option>
        </select>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label={t("chronicle.filterKind", "種別で絞り込み")}
          className={selectCls}
        >
          <option value="all">
            {t("chronicle.filterAllKinds", "すべての種別")}
          </option>
          {KIND_FILTERS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {t("chronicle.eventListEmpty", "該当するイベントがありません")}
          </div>
        ) : (
          // list-style:none (preflight) は WebKit/VoiceOver がリスト意味論を
          // 落とすため、明示 role=list で復元する（macOS の WKWebView 対策）。
          <ul role="list" aria-label={t("chronicle.eventList", "イベント一覧")}>
            {filtered.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  data-event-list-id={it.id}
                  data-selected={it.id === selectedId || undefined}
                  aria-current={it.id === selectedId ? "true" : undefined}
                  onClick={() => onSelect(it.id)}
                  className={`flex w-full flex-col gap-0.5 border-b border-border/40 px-3 py-1.5 text-left hover:bg-accent ${
                    it.id === selectedId ? "bg-accent" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span style={dotStyle(it)} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {it.title || t("chronicle.untitled", "無題のイベント")}
                    </span>
                    {it.dateLabel && (
                      <span
                        className="flex-none text-[11px] text-muted-foreground"
                        style={{ fontFeatureSettings: "'tnum'" }}
                      >
                        {it.dateLabel}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 ps-4 text-[11px] text-muted-foreground">
                    {it.laneName && (
                      <span className="truncate">{it.laneName}</span>
                    )}
                    {it.kind !== "generic" && (
                      <span>· {kindLabel(it.kind)}</span>
                    )}
                    {it.hasIssue && (
                      <AlertTriangle
                        className="size-3 flex-none"
                        style={{ color: "#e0a23a" }}
                        aria-label={t("chronicle.hasIssue", "整合警告あり")}
                      />
                    )}
                    {it.secret && (
                      <Lock
                        className="size-3 flex-none"
                        aria-label={t("chronicle.secretTag", "秘匿")}
                      />
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
