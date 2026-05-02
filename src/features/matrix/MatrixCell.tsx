import type { CellInfo } from "./lib/deriveCells";
import type { DisplayCell } from "./lib/deriveCellRender";
import type { DisplayMode } from "./matrixStore";
import type { ShowMode } from "./lib/deriveColumns";
import { deriveCellDisplay } from "./lib/deriveCellRender";

interface Props {
  cellInfo: CellInfo | undefined;
  /** Whether the row is a folder (Chapter) row */
  isFolder: boolean;
  /** Column's Codex entry ID (for pov/location mode) */
  colEntryId: string;
  /** Scene's pov_character_id (for pov mode) */
  povCharacterId?: string | null;
  /** Scene's location_id (for location mode) */
  locationId?: string | null;
  /** Whether this column's character has a beat-level POV override in this scene */
  isBeatPovOverride?: boolean;
  displayMode: DisplayMode;
  showMode: ShowMode;
  onContextMenu?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  onHoverAddClick?: () => void;
}

const INTENSITY_CLASS: Record<1 | 2 | 3, string> = {
  1: "bg-primary/5 text-primary/60",
  2: "bg-primary/12 text-primary/80",
  3: "bg-primary/25 text-primary",
};

function renderDisplay(display: DisplayCell): React.ReactNode {
  if (!display) return null;
  switch (display.kind) {
    case "dot":
      return (
        <span className={display.source === "relation" ? "opacity-50" : ""}>
          {display.source === "relation" ? "◯" : "●"}
        </span>
      );
    case "count":
      return (
        <span className="tabular-nums text-[10px] font-semibold">
          {display.count}
        </span>
      );
    case "heatmap":
      return null; // background color applied by container
    case "pov":
      return <span>{display.isBeatOverride ? "★" : "●"}</span>;
    case "role-aware": {
      const symbol =
        display.role === "actor" ? "●" : display.role === "target" ? "◯" : "·";
      return (
        <span>
          {display.isPov ? "★" : ""}
          {symbol}
        </span>
      );
    }
  }
}

function cellBgClass(display: DisplayCell): string {
  if (!display) return "";
  switch (display.kind) {
    case "dot":
    case "role-aware": {
      const src = display.source;
      if (src === "body") return "bg-primary/20 text-primary";
      if (src === "beat") return "bg-primary/10 text-primary/80";
      return "bg-primary/5 text-primary/60";
    }
    case "count":
    case "pov":
      return "bg-primary/20 text-primary";
    case "heatmap":
      return INTENSITY_CLASS[display.intensity];
    default:
      return "";
  }
}

export function MatrixCell({
  cellInfo,
  isFolder,
  colEntryId,
  povCharacterId,
  locationId,
  isBeatPovOverride,
  displayMode,
  showMode,
  onContextMenu,
  onClick,
  onHoverAddClick,
}: Props) {
  if (isFolder) {
    return (
      <div
        className="group relative flex h-8 w-full items-center justify-center border-b border-r border-border/30"
        onContextMenu={onContextMenu}
      >
        <button
          type="button"
          onClick={onHoverAddClick}
          className="hidden h-5 w-5 items-center justify-center rounded text-[10px] text-muted-foreground hover:bg-accent group-hover:flex"
          title="Add scene to this chapter"
        >
          +
        </button>
      </div>
    );
  }

  const display = deriveCellDisplay(
    cellInfo,
    colEntryId,
    povCharacterId,
    locationId,
    displayMode,
    showMode,
    isBeatPovOverride,
  );

  return (
    <div
      className={`flex h-8 w-full cursor-pointer items-center justify-center border-b border-r border-border/30 text-xs transition-colors hover:bg-accent/50 ${cellBgClass(display)}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {renderDisplay(display)}
    </div>
  );
}
