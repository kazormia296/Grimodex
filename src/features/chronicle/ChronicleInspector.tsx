import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Trash2,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ExternalLink,
} from "lucide-react";
import { EVENT_PRECISIONS, EVENT_KINDS } from "@/db/schema";
import type { EventRow } from "./api";
import type { SeasonConflict } from "./seasonCheck";
import type { AgeConflict } from "./ageCheck";
import { type ChronicleCalendar, type DateLang } from "./chronicleTime";
import { laneColorFor } from "./laneColor";
import { EventDateFields } from "./EventDateFields";
import { ChronicleDetailField } from "./ChronicleDetailField";
import { CodexEntryPicker } from "./CodexEntryPicker";
import { SceneLinkField, type SceneLinkMode } from "./SceneLinkField";
import { lunarInfoForDay } from "./chronicleLunar";

// narrow（＝インスペクタ幅が狭い）ときに下部アクションのラベルを畳んでアイコンのみに
// する。アクション行を `@container` にして各ラベル span に付ける（Tailwind v4 CQ・調整可）。
const ACTION_COLLAPSE = "@max-[360px]:hidden";

export interface ChronicleInspectorProps {
  event: EventRow;
  /** レーン（主人物）候補。任意の Codex を割り当て可能なので全件＋種別。 */
  laneOptions: { id: string; name: string; type: string }[];
  /** 場所候補（location 種別）。 */
  locations: { id: string; name: string }[];
  /** AI 秘匿の reveal アンカー候補（読む順のシーン）。hasDate=シーンに日時設定済み
   * （SceneLinkField が追加時に優先ダイアログを出すか判定する）。 */
  scenes?: { id: string; title: string; hasDate?: boolean }[];
  calendar: ChronicleCalendar;
  conflicts?: SeasonConflict[];
  ageConflicts?: AgeConflict[];
  hasTwoPlacesIssue?: boolean;
  hasCausalIssue?: boolean;
  /** Scene-Event union: 選択中がシーン由来トークン(scene:*)なら true。
   * event 固有の節（種別/参加/原因/秘匿/参照シーン/刻む取込）を隠し、削除は日付クリアに読み替える。 */
  isScene?: boolean;
  linkedSceneCount?: number;
  /** このイベントにリンク済みのシーン id（参照シーンの手動編集用）。 */
  linkedSceneIds?: string[];
  /** シーンをこのイベントへリンク／解除する（未指定なら参照シーン節を出さない）。
   * mode=イベント優先ならこのイベントの日付/POV/場所をシーンへ同期する。 */
  onLinkScene?: (sceneId: string, mode: SceneLinkMode) => void;
  onUnlinkScene?: (sceneId: string) => void;
  /** このイベントの主シーンをエディタで開く（scene-event/リンク済みのとき）。 */
  onOpenScene?: () => void;
  /** 参照シーンのピルクリックで該当シーンを開く。 */
  onOpenSceneById?: (sceneId: string) => void;
  allEvents?: { id: string; title: string }[];
  causeIds?: string[];
  onAddCause?: (causeId: string) => void;
  onRemoveCause?: (causeId: string) => void;
  onStamp?: () => void;
  onPull?: () => void;
  onPatch: (patch: Partial<EventRow>) => void;
  onDelete: () => void;
  onClose: () => void;
  lang?: DateLang;
  /** 現在の幅(px)。右サイド配置・左端グリップでリサイズ。 */
  width?: number;
  onWidthChange?: (w: number) => void;
  /** 参加レーン（追加の複数 Codex 所属）。primaryCodexId 以外の codexId。 */
  participantIds?: string[];
  onSetParticipants?: (codexEntryIds: string[]) => void;
}

const selectCls =
  "h-7 min-w-0 max-w-44 rounded-md border border-border bg-card px-2 text-xs text-foreground";
const labelCls =
  "flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground";

interface DraftTextFieldProps {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  rows?: number;
  delayMs?: number;
}

/**
 * ローカル下書き＋trailing debounce commit のテキスト入力。入力は即時反映し、
 * commit（tracked-write の DB 書込→bumpRevision→全件再取得、または tree store
 * 書込のカスケード）は打鍵停止後に 1 回へ纏める。commit はスケジュール時点の
 * 関数を捕まえるので、flush が選択切替後に走っても旧対象へ正しく書き込む。
 * blur / unmount で必ず flush（編集ロスト防止）。呼び出し側は対象切替時に
 * remount するよう key を付けること。
 */
export function DraftTextField({
  value,
  onCommit,
  placeholder,
  className,
  multiline = false,
  rows,
  delayMs = 500,
}: DraftTextFieldProps) {
  const [draft, setDraft] = useState(value);
  const pendingRef = useRef<{
    commit: (v: string) => void;
    value: string;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 外部更新（undo / 他ビュー編集）は未編集（pending なし）のときだけ取り込む。
  const lastValueRef = useRef(value);
  if (value !== lastValueRef.current) {
    lastValueRef.current = value;
    if (pendingRef.current == null) setDraft(value);
  }
  const flush = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const p = pendingRef.current;
    pendingRef.current = null;
    // 打ち消し合って元の値へ戻った下書きは書き込まない（無駄な再取得を防ぐ）。
    if (p && p.value !== lastValueRef.current) p.commit(p.value);
  }, []);
  const handleChange = useCallback(
    (v: string) => {
      setDraft(v);
      pendingRef.current = { commit: onCommit, value: v };
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, delayMs);
    },
    [onCommit, flush, delayMs],
  );
  // unmount（選択切替の remount / インスペクタを閉じる）時に pending を flush。
  useEffect(() => flush, [flush]);
  const common = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      handleChange(e.target.value),
    onBlur: flush,
    placeholder,
    className,
  };
  return multiline ? (
    <textarea rows={rows} {...common} />
  ) : (
    <input {...common} />
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** 選択中の出来事を編集する下部インスペクタ（暦駆動の日時ピッカー統合）。 */
export function ChronicleInspector({
  event,
  laneOptions,
  locations,
  scenes = [],
  calendar,
  conflicts,
  ageConflicts,
  hasTwoPlacesIssue = false,
  hasCausalIssue = false,
  isScene = false,
  linkedSceneCount = 0,
  linkedSceneIds = [],
  onLinkScene,
  onUnlinkScene,
  onOpenScene,
  onOpenSceneById,
  allEvents = [],
  causeIds = [],
  onAddCause,
  onRemoveCause,
  onStamp,
  onPull,
  onPatch,
  onDelete,
  onClose,
  lang,
  width = 360,
  onWidthChange,
  participantIds = [],
  onSetParticipants,
}: ChronicleInspectorProps) {
  const { t } = useTranslation();
  const laneLabel = (o: { name: string; type: string }) =>
    o.type && o.type !== "character"
      ? `${o.name}（${t(`chronicle.laneType.${o.type}`, o.type)}）`
      : o.name;
  const lanePickerOptions = laneOptions.map((o) => ({
    id: o.id,
    name: laneLabel(o),
  }));
  const laneNameById = new Map(laneOptions.map((o) => [o.id, laneLabel(o)]));
  // 参加レーン追加候補（primary・既存参加を除外）。
  const participantAddOptions = lanePickerOptions.filter(
    (o) => o.id !== event.primaryCodexId && !participantIds.includes(o.id),
  );

  // 左端グリップのドラッグで幅を変える（左へ引く=広く）。clamp [280, 640]。
  const onResizeStart = (e: React.MouseEvent) => {
    if (!onWidthChange) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) => {
      const next = Math.max(280, Math.min(640, startW - (ev.clientX - startX)));
      onWidthChange(next);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  const titleById = new Map(allEvents.map((e) => [e.id, e.title]));
  const causeOptions = allEvents.filter(
    (e) => e.id !== event.id && !causeIds.includes(e.id),
  );
  const lc = laneColorFor(event.primaryCodexId);

  return (
    <div
      className="flex h-full shrink-0 flex-row border-l border-border bg-card"
      style={{ width }}
    >
      {/* リサイズグリップ（左端ドラッグで幅変更） */}
      <div
        onMouseDown={onResizeStart}
        className="group flex w-2 shrink-0 cursor-ew-resize items-center justify-center hover:bg-accent/40"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chronicle.resizeInspector", "インスペクタの幅を変更")}
      >
        <span className="h-8 w-[3px] rounded-full bg-border group-hover:bg-muted-foreground/60" />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-3 p-3.5">
          {/* タイトル */}
          <div className="flex items-center gap-2.5">
            <span
              style={{
                flex: "none",
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: event.primaryCodexId
                  ? lc
                  : "var(--muted-foreground)",
              }}
            />
            <DraftTextField
              key={`title-${event.id}`}
              value={event.title}
              onCommit={(v) => onPatch({ title: v })}
              placeholder={t("chronicle.untitled", "無題のイベント")}
              className="min-w-0 flex-1 bg-transparent text-base font-semibold text-foreground outline-none"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label={t("chronicle.close", "閉じる")}
              className="grid size-[26px] flex-none place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              ×
            </button>
          </div>

          {/* 整合警告バナー */}
          {conflicts && conflicts.length > 0 && (
            <Banner>
              {t(
                "chronicle.seasonConflictDetail",
                "季節の矛盾: 時刻は{{eventSeason}}だが本文に{{sceneSeasons}}",
                {
                  eventSeason: conflicts[0].eventSeason,
                  sceneSeasons: [
                    ...new Set(conflicts.flatMap((c) => c.sceneSeasons)),
                  ].join("・"),
                },
              )}
            </Banner>
          )}
          {hasCausalIssue && (
            <Banner>
              {t(
                "chronicle.causalConflict",
                "因果の矛盾: 結果が原因より前にある",
              )}
            </Banner>
          )}
          {ageConflicts && ageConflicts.length > 0 && (
            <Banner>
              {t(
                "chronicle.ageConflictDetail",
                "年齢の矛盾: 算出{{age}}歳だが本文に「{{word}}」",
                {
                  age: ageConflicts[0].computedAge,
                  word: ageConflicts[0].ageWord,
                },
              )}
            </Banner>
          )}
          {hasTwoPlacesIssue && (
            <Banner>
              {t(
                "chronicle.twoPlacesConflict",
                "2か所同時の矛盾: 同一人物が同時刻に別の場所にいる",
              )}
            </Banner>
          )}

          {/* 横幅があれば2カラムに流すカードグリッド（間延び解消） */}
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              alignItems: "start",
            }}
          >
            {/* 基本フィールド（レーン/場所/種別/確度） */}
            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
              <label className={labelCls}>
                {t("chronicle.lane", "レーン")}
                <CodexEntryPicker
                  value={event.primaryCodexId}
                  options={lanePickerOptions}
                  onChange={(id) => onPatch({ primaryCodexId: id ?? "" })}
                  ariaLabel={t("chronicle.lane", "レーン")}
                  placeholder={t("chronicle.laneUnassigned", "（未割当）")}
                />
              </label>
              <label className={labelCls}>
                {t("chronicle.location", "場所")}
                <select
                  value={event.locationCodexId ?? ""}
                  onChange={(e) => onPatch({ locationCodexId: e.target.value })}
                  className={selectCls}
                >
                  <option value="">{t("chronicle.none", "なし")}</option>
                  {locations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              {!isScene && (
                <label className={labelCls}>
                  {t("chronicle.kindLabel", "種別")}
                  <select
                    value={event.kind}
                    onChange={(e) =>
                      onPatch({ kind: e.target.value as EventRow["kind"] })
                    }
                    className={selectCls}
                  >
                    {EVENT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`chronicle.kind.${k}`, k)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className={labelCls}>
                {t("chronicle.precisionLabel", "日付の確度")}
                <select
                  value={event.precision}
                  onChange={(e) =>
                    onPatch({
                      precision: e.target.value as EventRow["precision"],
                    })
                  }
                  className={selectCls}
                >
                  {EVENT_PRECISIONS.map((p) => (
                    <option key={p} value={p}>
                      {t(`chronicle.precision.${p}`, p)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* 参加レーン（複数 Codex 所属＝マルチレーン描画）。event 専用。 */}
            {!isScene && onSetParticipants && (
              <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                <span className="text-[11px] text-muted-foreground">
                  {t("chronicle.participants", "参加レーン（複数所属）")}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {participantIds.map((cid) => (
                    <span
                      key={cid}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-accent/60 py-0.5 pl-2 pr-1 text-xs"
                    >
                      {laneNameById.get(cid) ??
                        t("chronicle.unnamed", "（無名）")}
                      <button
                        type="button"
                        onClick={() =>
                          onSetParticipants(
                            participantIds.filter((x) => x !== cid),
                          )
                        }
                        aria-label={t("chronicle.removeParticipant", "外す")}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {participantAddOptions.length > 0 && (
                    <CodexEntryPicker
                      value={null}
                      options={participantAddOptions}
                      onChange={(id) => {
                        if (id) onSetParticipants([...participantIds, id]);
                      }}
                      ariaLabel={t(
                        "chronicle.addParticipant",
                        "参加レーンを追加",
                      )}
                      placeholder={t(
                        "chronicle.addParticipant",
                        "＋参加レーン",
                      )}
                    />
                  )}
                </div>
              </div>
            )}

            {/* 開始 / 終了 日時（Editor / Timeline のシーン日付と共有） */}
            <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
              <EventDateFields
                calendar={calendar}
                startTime={event.startTime}
                startMinute={event.startMinute}
                startGranularity={event.startGranularity}
                endTime={event.endTime}
                endMinute={event.endMinute}
                endGranularity={event.endGranularity}
                onPatch={onPatch}
                lang={lang}
              />
            </div>

            {/* 旧暦・六曜・節気（実暦12ヶ月暦のみ。中国農暦 UTC+8 ベース） */}
            {(() => {
              const lunar =
                event.startGranularity !== "none" && event.startTime != null
                  ? lunarInfoForDay(event.startTime, calendar)
                  : null;
              if (!lunar) return null;
              return (
                <div
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground"
                  title={t(
                    "chronicle.lunarHint",
                    "中国農暦(UTC+8)ベース。新月・節気が深夜にかかる境界日などで日本の旧暦・六曜と数日ずれることがあります。",
                  )}
                >
                  <span>
                    {t("chronicle.lunarLabel", "旧暦")}{" "}
                    {lunar.isLeapMonth ? t("chronicle.lunarLeap", "閏") : ""}
                    {lunar.month}
                    {t("chronicle.lunarMonthUnit", "月")}
                    {lunar.day}
                    {t("chronicle.lunarDayUnit", "日")}
                  </span>
                  <span>
                    ・ {t("chronicle.rokuyo", "六曜")}: {lunar.rokuyo}
                  </span>
                  {lunar.solarTerm && (
                    <span>
                      ・ {t("chronicle.solarTerm", "節気")}: {lunar.solarTerm}
                    </span>
                  )}
                </div>
              );
            })()}

            {/* 原因（因果エッジ）。event 専用。 */}
            {!isScene && (causeIds.length > 0 || onAddCause) && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex-none text-[11px] text-muted-foreground">
                  {t("chronicle.causes", "原因")}
                </span>
                {causeIds.map((cid) => (
                  <span
                    key={cid}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-accent/60 py-0.5 pl-2.5 pr-1.5 text-xs"
                  >
                    {titleById.get(cid) ||
                      t("chronicle.untitled", "無題のイベント")}
                    {onRemoveCause && (
                      <button
                        type="button"
                        onClick={() => onRemoveCause(cid)}
                        aria-label={t("chronicle.removeCause", "原因を外す")}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {onAddCause && causeOptions.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) onAddCause(e.target.value);
                    }}
                    aria-label={t("chronicle.addCause", "原因を追加")}
                    className={selectCls}
                  >
                    <option value="">
                      {t("chronicle.addCause", "＋原因を追加")}
                    </option>
                    {causeOptions.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title || t("chronicle.untitled", "無題のイベント")}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* AI 秘匿。event 専用（scene の可視性は別系統）。 */}
            {!isScene && (
              <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                <label className="flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={event.secret}
                    onChange={(e) => onPatch({ secret: e.target.checked })}
                    style={{ accentColor: "var(--primary)" }}
                    className="size-4"
                  />
                  {t("chronicle.secretLabel", "AI に秘匿（ネタバレ防止）")}
                </label>
                {event.secret && (
                  <div className="flex flex-wrap items-center gap-2 pl-6">
                    <span className="text-[11px] text-muted-foreground">
                      {t("chronicle.revealSceneLabel", "開示シーン")}
                    </span>
                    <select
                      value={event.revealSceneId ?? ""}
                      onChange={(e) =>
                        onPatch({ revealSceneId: e.target.value })
                      }
                      aria-label={t("chronicle.revealSceneLabel", "開示シーン")}
                      className={selectCls}
                    >
                      <option value="">
                        {t("chronicle.revealSceneAuto", "自動（初出シーン）")}
                      </option>
                      {scenes.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title ||
                            t("chronicle.untitledScene", "無題のシーン")}
                        </option>
                      ))}
                    </select>
                    <span className="min-w-40 flex-1 text-[11px] text-muted-foreground">
                      {t(
                        "chronicle.secretDescShort",
                        "開示シーン以降を書くときのみ AI に渡されます。",
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* シーンイベントのあらすじ（synopsis↔note）。scene 専用の簡易エディタ。 */}
            {isScene && (
              <label className={labelCls}>
                {t("chronicle.synopsis", "あらすじ")}
                <DraftTextField
                  key={`note-${event.id}`}
                  multiline
                  value={event.note ?? ""}
                  onCommit={(v) => onPatch({ note: v })}
                  rows={3}
                  className="min-h-16 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground"
                  placeholder={t(
                    "chronicle.synopsisPlaceholder",
                    "このシーンの要約…",
                  )}
                />
              </label>
            )}
          </div>

          {/* 詳細（リッチテキスト）。event 専用（scene は synopsis を上で編集）。 */}
          {!isScene && (
            <ChronicleDetailField
              key={`detail-${event.id}`}
              event={event}
              onPatchDetail={(detail) => onPatch({ detail })}
            />
          )}

          {/* 参照シーン（手動リンク）。event 専用（scene は自分自身なので不要）。 */}
          {!isScene && onLinkScene && onUnlinkScene && (
            <SceneLinkField
              key={`scene-link-${event.id}`}
              scenes={scenes}
              linkedSceneIds={linkedSceneIds}
              onLink={onLinkScene}
              onUnlink={onUnlinkScene}
              onOpenScene={onOpenSceneById}
            />
          )}

          {/* アクション（narrow 時はラベルを畳んでアイコンのみ＝@container + collapse span） */}
          <div
            data-testid="inspector-actions"
            className="@container flex items-center gap-2"
          >
            {onOpenScene && (
              <button
                type="button"
                onClick={onOpenScene}
                title={t(
                  "chronicle.openSceneHint",
                  "該当シーンをエディタで開く",
                )}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs hover:bg-accent"
              >
                <ExternalLink className="size-3.5" />
                <span className={ACTION_COLLAPSE}>
                  {t("chronicle.openScene", "シーンを開く")}
                </span>
              </button>
            )}
            {!isScene && linkedSceneCount > 0 && onStamp && (
              <button
                type="button"
                onClick={onStamp}
                title={t(
                  "chronicle.stampHint",
                  "この時刻を参照シーンの作中時間へ刻む",
                )}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs hover:bg-accent"
              >
                <ArrowDownToLine className="size-3.5" />
                <span className={ACTION_COLLAPSE}>
                  {t("chronicle.stamp", "シーンへ刻む")}
                </span>
              </button>
            )}
            {!isScene && linkedSceneCount > 0 && onPull && (
              <button
                type="button"
                onClick={onPull}
                title={t(
                  "chronicle.pullHint",
                  "参照シーンの作中時間をこのイベントへ取り込む",
                )}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs hover:bg-accent"
              >
                <ArrowUpFromLine className="size-3.5" />
                <span className={ACTION_COLLAPSE}>
                  {t("chronicle.pull", "シーンから取込")}
                </span>
              </button>
            )}
            {/* シーンイベントは「削除」せず作中日付をクリアしてタイムラインから外す。 */}
            <button
              type="button"
              onClick={onDelete}
              title={
                isScene
                  ? t(
                      "chronicle.clearSceneDateHint",
                      "シーンは消さずタイムラインから外します",
                    )
                  : t("chronicle.delete", "削除")
              }
              className="ms-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/30 bg-card px-3 text-xs text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" />
              <span className={ACTION_COLLAPSE}>
                {isScene
                  ? t("chronicle.clearSceneDate", "作中日付をクリア")
                  : t("chronicle.delete", "削除")}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
