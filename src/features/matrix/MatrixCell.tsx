import type { CellSource } from "./lib/deriveCells";

interface Props {
  source: CellSource | undefined;
  /** Whether the row is a folder (Chapter) row */
  isFolder: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  onHoverAddClick?: () => void;
}

/** Background class per source strength */
const SOURCE_CLASS: Record<CellSource, string> = {
  body: "bg-primary/20 text-primary",
  beat: "bg-primary/10 text-primary/80",
  relation: "bg-primary/5 text-primary/60",
};

/** Dot symbol per source */
const SOURCE_DOT: Record<CellSource, string> = {
  body: "●",
  beat: "●",
  relation: "◯",
};

export function MatrixCell({
  source,
  isFolder,
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

  return (
    <div
      className={`flex h-8 w-full cursor-pointer items-center justify-center border-b border-r border-border/30 text-xs transition-colors hover:bg-accent/50 ${
        source ? SOURCE_CLASS[source] : ""
      }`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {source && <span>{SOURCE_DOT[source]}</span>}
    </div>
  );
}
