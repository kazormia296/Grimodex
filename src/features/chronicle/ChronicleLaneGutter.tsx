import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { PackedLane } from "./chronicleLanePack";
import { laneColorFor } from "./laneColor";

export interface ChronicleLaneGutterProps {
  lanes: PackedLane[];
  gutterX: number;
  /** 選択中の出来事が属するレーンキー（codexId or "__unassigned"）。背景を淡く強調。 */
  activeLaneKey: string | null;
}

const laneKeyOf = (lane: PackedLane) =>
  lane.unassigned ? "__unassigned" : (lane.codexId ?? "__unassigned");

/**
 * 左レーンガター（アバター＋名前＋件数）。各セルは pack の lane.height に
 * 合わせ、トラックのレーンと縦位置を揃える。人物=円 / 場所等=角丸 / 未割当=点線。
 */
export function ChronicleLaneGutter({
  lanes,
  gutterX,
  activeLaneKey,
}: ChronicleLaneGutterProps) {
  const { t } = useTranslation();

  const typeJa = (type: string): string =>
    t(`chronicle.laneType.${type}`, type);

  return (
    <div
      data-testid="chronicle-lane-gutter"
      // z-20: 選択マーカー(z-9)が左端で負 left にはみ出してもガターを覆わせない。
      className="z-20 flex-none border-r border-border bg-card"
      style={{ width: gutterX }}
    >
      {lanes.map((lane) => {
        const active = laneKeyOf(lane) === activeLaneKey;
        const lc = laneColorFor(lane.codexId);
        const initial = lane.name?.[0] ?? "?";
        const radius = lane.unassigned
          ? "50%"
          : lane.kind === "character"
            ? "50%"
            : "8px";
        const avatarStyle: CSSProperties = lane.unassigned
          ? {
              width: 28,
              height: 28,
              flex: "none",
              borderRadius: "50%",
              border: "1.5px dashed var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted-foreground)",
              fontSize: 13,
            }
          : {
              width: 28,
              height: 28,
              flex: "none",
              borderRadius: radius,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              background: `linear-gradient(145deg, ${lc}, color-mix(in oklch, ${lc} 62%, #000))`,
            };
        const countText =
          t("chronicle.count", "{{count}} 件", { count: lane.count }) +
          (lane.kind && lane.kind !== "character" && !lane.unassigned
            ? ` ・${typeJa(lane.kind)}`
            : "");
        return (
          <div
            key={laneKeyOf(lane)}
            data-lane-id={lane.codexId ?? "__unassigned"}
            className="flex items-center gap-2.5 border-b border-border/60 px-3.5"
            style={{
              height: lane.height,
              boxSizing: "border-box",
              background: active
                ? "color-mix(in oklch, var(--primary) 5%, transparent)"
                : undefined,
            }}
          >
            <div style={avatarStyle}>{lane.unassigned ? "·" : initial}</div>
            <div className="flex min-w-0 flex-col gap-px">
              <span
                className="truncate text-[13px] font-medium"
                style={{
                  color: lane.unassigned
                    ? "var(--muted-foreground)"
                    : "var(--foreground)",
                  fontStyle: lane.unassigned ? "italic" : undefined,
                }}
              >
                {lane.unassigned
                  ? t("chronicle.unassigned", "未割当")
                  : lane.name || t("chronicle.unnamed", "（無名）")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {countText}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
