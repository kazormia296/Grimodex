import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays } from "lucide-react";
import { EVENT_GRANULARITIES, type EventGranularity } from "@/db/schema";
import {
  dateToDayNumber,
  formatChronicleDate,
  type ChronicleCalendar,
  type DateLang,
} from "./chronicleTime";
import { ChronicleDatePicker } from "./ChronicleDatePicker";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";

/** 出来事/シーンの作中日時 patch（start/end の粒度・日番号・分）。 */
export interface EventDatePatch {
  startTime?: number | null;
  startMinute?: number | null;
  startGranularity?: EventGranularity;
  endTime?: number | null;
  endMinute?: number | null;
  endGranularity?: EventGranularity;
}

export interface EventDateFieldsProps {
  calendar: ChronicleCalendar;
  startTime: number | null;
  startMinute: number | null;
  startGranularity: EventGranularity;
  endTime: number | null;
  endMinute: number | null;
  endGranularity: EventGranularity;
  onPatch: (patch: EventDatePatch) => void;
  lang?: DateLang;
}

const selectCls =
  "h-7 min-w-0 max-w-44 rounded-md border border-border bg-card px-2 text-xs text-foreground";
const dateBtnCls =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-accent";
const toggleBtnCls =
  "h-[26px] rounded-md border border-border bg-card px-2 text-[11px] text-muted-foreground hover:bg-accent";

/**
 * 開始 / 終了の作中日時を編集する共有コントロール（暦駆動の Popover 日付ピッカー統合）。
 * Chronicle インスペクタ（出来事）と Editor / Timeline インスペクタ（シーンの作中日付）で
 * 同一の UI を共有するために切り出したもの。粒度 select ＋ 日付ボタン(Popover) ＋
 * 点 / 期間トグルで構成し、内部は day 番号(startTime) ＋ 分 ＋ 粒度で保持する。
 * 日付数学は chronicleTime（純関数）へ委譲する。外側の枠（カード等）は呼び出し側が持つ。
 */
export function EventDateFields({
  calendar,
  startTime,
  startMinute,
  startGranularity,
  endTime,
  endMinute,
  endGranularity,
  onPatch,
  lang,
}: EventDateFieldsProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState<"start" | "end" | null>(null);
  const startYear = calendar.startYear ?? 0;
  const isInterval = endTime != null;

  // 日時ピッカー本体（Radix PopoverContent 内に描画。配置/衝突回避/アニメは Radix 側）。
  const pickerContentFor = (which: "start" | "end") => {
    const gran =
      which === "start"
        ? startGranularity
        : endGranularity === "none"
          ? "day"
          : endGranularity;
    const day =
      which === "start"
        ? (startTime ?? dateToDayNumber({ year: startYear }, calendar))
        : (endTime ??
          startTime ??
          dateToDayNumber({ year: startYear }, calendar));
    const minute = which === "start" ? (startMinute ?? 0) : (endMinute ?? 0);
    return (
      <ChronicleDatePicker
        which={which}
        granularity={gran as EventGranularity}
        calendar={calendar}
        day={day}
        minute={minute}
        lang={lang}
        onCommitDay={(d) => {
          if (which === "start") onPatch({ startTime: d });
          else onPatch({ endTime: Math.max(d, startTime ?? d) });
        }}
        onCommitMinute={(m) => {
          if (which === "start") onPatch({ startMinute: m });
          else onPatch({ endMinute: m });
        }}
        onClose={() => setPickerOpen(null)}
      />
    );
  };

  const setGranStart = (g: EventGranularity) => {
    if (g === "none") {
      onPatch({ startGranularity: "none", startTime: null, startMinute: null });
    } else {
      const base = startTime ?? dateToDayNumber({ year: startYear }, calendar);
      onPatch({ startGranularity: g, startTime: base });
    }
  };

  const startResolved =
    startGranularity === "none"
      ? ""
      : formatChronicleDate(
          startTime,
          startMinute,
          startGranularity,
          calendar,
          lang,
        );
  const endResolved = isInterval
    ? formatChronicleDate(
        endTime,
        endMinute,
        endGranularity === "none" ? "day" : endGranularity,
        calendar,
        lang,
      )
    : "";

  return (
    <div className="flex flex-col gap-2">
      {/* 開始 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-7 flex-none text-[11px] text-muted-foreground">
          {t("chronicle.startTime", "開始")}
        </span>
        <select
          value={startGranularity}
          onChange={(e) => setGranStart(e.target.value as EventGranularity)}
          aria-label={t("chronicle.startGranularity", "開始の粒度")}
          className={selectCls}
        >
          {EVENT_GRANULARITIES.map((g) => (
            <option key={g} value={g}>
              {t(`chronicle.granularity.${g}`, g)}
            </option>
          ))}
        </select>
        {startGranularity !== "none" ? (
          <Popover
            open={pickerOpen === "start"}
            onOpenChange={(o) => setPickerOpen(o ? "start" : null)}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className={dateBtnCls}
                style={{ fontFeatureSettings: "'tnum'" }}
              >
                <CalendarDays className="size-3.5 opacity-70" />
                {startResolved}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-[296px]">
              {pickerContentFor("start")}
            </PopoverContent>
          </Popover>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("chronicle.timeUnset", "時刻は未指定（並び順のみ）")}
          </span>
        )}
      </div>
      {/* 終了 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-7 flex-none text-[11px] text-muted-foreground">
          {t("chronicle.endTime", "終了")}
        </span>
        {isInterval ? (
          <>
            <Popover
              open={pickerOpen === "end"}
              onOpenChange={(o) => setPickerOpen(o ? "end" : null)}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={dateBtnCls}
                  style={{ fontFeatureSettings: "'tnum'" }}
                >
                  <CalendarDays className="size-3.5 opacity-70" />
                  {endResolved}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-[296px]">
                {pickerContentFor("end")}
              </PopoverContent>
            </Popover>
            <button
              type="button"
              onClick={() =>
                onPatch({
                  endTime: null,
                  endGranularity: "none",
                  endMinute: null,
                })
              }
              className={toggleBtnCls}
            >
              {t("chronicle.makePoint", "点にする")}
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">
              {t("chronicle.unset", "未指定")}
            </span>
            {startGranularity !== "none" && (
              <button
                type="button"
                onClick={() =>
                  onPatch({
                    endTime: (startTime ?? 0) + 60,
                    endGranularity: "day",
                    endMinute: 0,
                  })
                }
                className={toggleBtnCls}
              >
                {t("chronicle.makeInterval", "期間にする")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
