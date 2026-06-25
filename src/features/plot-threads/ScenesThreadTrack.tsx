import type { PlotThreadRow } from "./api";
import { TRACK_COL_WIDTH } from "./sceneThreadTracks";

interface Props {
  /** 列順のセル状態文字列（buildSceneThreadTracks の cellByNode[nodeId]）。 */
  cells: string;
  /** 列スレッド（色解決用・安定参照）。 */
  columns: PlotThreadRow[];
  /** この行の分岐/合流コネクタ（connectorByNode[nodeId]・`from>to:kind`）。 */
  connectors?: string;
}

/** 列インデックスの中心 x(px)。 */
function colCenter(j: number): number {
  return j * TRACK_COL_WIDTH + TRACK_COL_WIDTH / 2;
}

/**
 * Scenes 行の左ガターに描く読み取り専用の「縦版ミニ・タイムライン」。
 * 各スレッド＝1 本の縦トラック。所属シーンは駅（ノード）、区間内は縦線で連結。
 * 分岐/合流は at 列の行で 2 本のトラックを横リンク（branch=実線 / merge=破線）。
 * 行の高さに追従（inset-y-0）し、全行で同じ列 x に並ぶため縦線が連続して見える。
 * pointer-events-none＝クリックは行へ透過（読み取り専用・並べ替え不可）。
 */
export function ScenesThreadTrack({ cells, columns, connectors }: Props) {
  if (columns.length === 0) return null;

  const connectorList = (connectors ?? "")
    .split(",")
    .filter(Boolean)
    .map((enc) => {
      const [pair, kind] = enc.split(":");
      const [from, to] = pair.split(">").map((n) => Number(n));
      return { from, to, kind: kind === "m" ? "merge" : "branch" };
    })
    .filter(
      (c) =>
        Number.isInteger(c.from) &&
        Number.isInteger(c.to) &&
        c.from < columns.length &&
        c.to < columns.length,
    );

  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 flex"
      style={{ width: columns.length * TRACK_COL_WIDTH }}
    >
      {columns.map((col, j) => {
        const ch = cells[j] ?? ".";
        if (ch === ".") {
          return (
            <span key={col.id} style={{ width: TRACK_COL_WIDTH }} aria-hidden />
          );
        }
        const color = col.color ?? "var(--primary)";
        const hasLine = ch !== "o";
        const hasNode = ch !== "|";
        const lineTop = ch === "t" ? "50%" : "0";
        const lineBottom = ch === "b" ? "50%" : "0";
        return (
          <span
            key={col.id}
            className="relative"
            style={{ width: TRACK_COL_WIDTH }}
            data-testid={`scene-track-${col.id}-${ch}`}
            title={col.name}
          >
            {hasLine && (
              <span
                className="absolute left-1/2 -translate-x-1/2"
                data-testid={`scene-track-line-${col.id}`}
                style={{
                  top: lineTop,
                  bottom: lineBottom,
                  width: 2,
                  backgroundColor: color,
                }}
              />
            )}
            {hasNode && (
              <span
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ width: 6, height: 6, backgroundColor: color }}
                data-testid={`scene-track-node-${col.id}`}
              />
            )}
          </span>
        );
      })}

      {/* 分岐/合流コネクタ（行中央で from↔to 列を横リンク）。 */}
      {connectorList.map((c, i) => {
        const x1 = colCenter(c.from);
        const x2 = colCenter(c.to);
        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        const color = columns[c.from]?.color ?? "var(--primary)";
        return (
          <span
            key={`conn-${i}`}
            data-testid={`scene-track-connector-${c.kind}`}
            title={c.kind}
            className="absolute -translate-y-1/2"
            style={{
              left,
              top: "50%",
              width,
              height: 0,
              borderTop: `2px ${c.kind === "merge" ? "dashed" : "solid"} ${color}`,
            }}
          />
        );
      })}
    </span>
  );
}
