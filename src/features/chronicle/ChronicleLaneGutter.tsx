import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type { PackedLane } from "./chronicleLanePack";
import { GROUP_PREFIX } from "./chronicleLayout";
import { laneColorFor } from "./laneColor";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { CodexEntryPicker } from "./CodexEntryPicker";

export interface ChronicleLaneGutterProps {
  lanes: PackedLane[];
  gutterX: number;
  /** 選択中の出来事が属するレーンキー（codexId or "__unassigned"）。背景を淡く強調。 */
  activeLaneKey: string | null;
  /** 任意 Codex 候補（レーン追加・未割当の割当ドロップダウン用）。 */
  laneOptions?: { id: string; name: string; type: string }[];
  /** 編集ロック中は追加/割当 UI を隠す。 */
  locked?: boolean;
  /** 未割当レーンを群ごと Codex へ割当（groupId=null は基底未割当）。 */
  onAssignGroup?: (groupId: string | null, codexId: string) => void;
  /** レーン追加（空の未割当レーンを増やす）。 */
  onAddLane?: () => void;
  /** 空の未割当（追加）レーンを隠す（×）。 */
  onHideGroup?: (groupId: string) => void;
}

// 未割当レーンはグループ別に一意キー（base=__unassigned、追加群=__group_<g>）。
const laneKeyOf = (lane: PackedLane) =>
  lane.unassigned
    ? lane.groupId
      ? `${GROUP_PREFIX}${lane.groupId}`
      : "__unassigned"
    : (lane.codexId ?? "__unassigned");

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
  onAssignGroup,
  onAddLane,
  onHideGroup,
}: ChronicleLaneGutterProps) {
  const { t } = useTranslation();
  const [gutterEl, setGutterEl] = useState<HTMLDivElement | null>(null);

  const typeJa = (type: string): string =>
    t(`chronicle.laneType.${type}`, type);

  const optionLabel = (o: { name: string; type: string }) =>
    o.type && o.type !== "character"
      ? `${o.name}（${typeJa(o.type)}）`
      : o.name;
  // Spotlight 風ピッカー（Chat と同じ CodexEntryPicker）に渡す候補。
  const pickerOptions = laneOptions.map((o) => ({
    id: o.id,
    name: optionLabel(o),
  }));

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
        // 空でも表示する未割当（=空）レーンは × で隠せる。
        const isEmptyUnassigned = lane.unassigned && lane.keepEmpty;
        return (
          <div
            key={laneKeyOf(lane)}
            data-lane-id={laneKeyOf(lane)}
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
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              {lane.unassigned && onAssignGroup && !locked ? (
                // 「未割当」ラベル自体を Spotlight ピッカーに（常時表示）。この未割当
                // レーンの出来事をまとめて選んだ Codex レーンへ割り当てる。
                <CodexEntryPicker
                  value={null}
                  options={pickerOptions}
                  onChange={(id) => {
                    if (id) onAssignGroup(lane.groupId ?? null, id);
                  }}
                  ariaLabel={t("chronicle.assignLane", "レーンへ割当")}
                  placeholder={t("chronicle.unassigned", "未割当")}
                />
              ) : (
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
              )}
              <span className="text-[10px] text-muted-foreground">
                {countText}
              </span>
            </div>
            {isEmptyUnassigned && lane.groupId && onHideGroup && !locked && (
              <button
                type="button"
                onClick={() => onHideGroup(lane.groupId!)}
                aria-label={t("chronicle.removeLane", "レーンを隠す")}
                className="flex-none rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}

      {onAddLane && !locked && (
        <button
          type="button"
          onClick={() => onAddLane()}
          className="flex w-full items-center gap-1.5 border-b border-border/60 px-3.5 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5 flex-none" />
          {t("chronicle.addLane", "レーンを追加")}
        </button>
      )}

      <CodexPopover containerEl={gutterEl} />
    </div>
  );
}
