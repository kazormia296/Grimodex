import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { PackedLane } from "./chronicleLanePack";
import { laneColorFor } from "./laneColor";
import { CodexPopover } from "@/features/editor/CodexPopover";

export interface ChronicleLaneGutterProps {
  lanes: PackedLane[];
  gutterX: number;
  /** 選択中の出来事が属するレーンキー（codexId or "__unassigned"）。背景を淡く強調。 */
  activeLaneKey: string | null;
  /** 任意 Codex 候補（レーン追加・未割当の割当ドロップダウン用）。 */
  laneOptions?: { id: string; name: string; type: string }[];
  /** 編集ロック中は追加/割当 UI を隠す。 */
  locked?: boolean;
  /** 選択中の出来事が未割当レーンに属する（=割当ドロップダウンを出す）。 */
  selectedUnassigned?: boolean;
  /** 未割当→Codex 割当（選択中の出来事に適用）。 */
  onAssignLane?: (codexId: string) => void;
  /** レーン追加（選択 Codex に新規出来事を作成してレーンを出す）。 */
  onAddLane?: (codexId: string) => void;
}

const laneKeyOf = (lane: PackedLane) =>
  lane.unassigned ? "__unassigned" : (lane.codexId ?? "__unassigned");

const miniSelect =
  "h-6 max-w-[150px] rounded border border-border bg-card px-1 text-[11px] text-foreground";

/**
 * 左レーンガター（アバター＋名前＋件数）。各セルは pack の lane.height に
 * 合わせ、トラックのレーンと縦位置を揃える。人物=円 / 場所等=角丸 / 未割当=点線。
 * レーン名は Codex ポップオーバー（Editor 本文と同じ）対応。最後尾に「追加」、
 * 未割当レーンには Codex 割当ドロップダウンを出す。
 */
export function ChronicleLaneGutter({
  lanes,
  gutterX,
  activeLaneKey,
  laneOptions = [],
  locked = false,
  selectedUnassigned = false,
  onAssignLane,
  onAddLane,
}: ChronicleLaneGutterProps) {
  const { t } = useTranslation();
  const [gutterEl, setGutterEl] = useState<HTMLDivElement | null>(null);

  const typeJa = (type: string): string =>
    t(`chronicle.laneType.${type}`, type);

  const optionLabel = (o: { name: string; type: string }) =>
    o.type && o.type !== "character"
      ? `${o.name}（${typeJa(o.type)}）`
      : o.name;

  return (
    <div
      ref={setGutterEl}
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
                // Codex 連携レーンは Editor 本文と同じ codex-highlight ポップオーバー対象。
                className={`truncate text-[13px] font-medium ${
                  !lane.unassigned && lane.codexId ? "codex-highlight" : ""
                }`}
                data-codex-entry-id={
                  !lane.unassigned && lane.codexId ? lane.codexId : undefined
                }
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
              {lane.unassigned &&
                selectedUnassigned &&
                onAssignLane &&
                !locked && (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) onAssignLane(e.target.value);
                    }}
                    aria-label={t("chronicle.assignLane", "レーンへ割当")}
                    className={`mt-1 ${miniSelect}`}
                  >
                    <option value="">
                      {t("chronicle.assignLaneShort", "→ レーンへ割当")}
                    </option>
                    {laneOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {optionLabel(o)}
                      </option>
                    ))}
                  </select>
                )}
            </div>
          </div>
        );
      })}

      {onAddLane && !locked && laneOptions.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2">
          <Plus className="size-3.5 flex-none text-muted-foreground" />
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onAddLane(e.target.value);
            }}
            aria-label={t("chronicle.addLane", "レーンを追加")}
            className={miniSelect}
          >
            <option value="">{t("chronicle.addLane", "＋レーンを追加")}</option>
            {laneOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {optionLabel(o)}
              </option>
            ))}
          </select>
        </div>
      )}

      <CodexPopover containerEl={gutterEl} />
    </div>
  );
}
