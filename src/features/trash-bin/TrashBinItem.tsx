import { useCallback } from "react";
import type { TrashItemData } from "./types";
import { dominantSource, getBodySize } from "./displayHelpers";
import { SceneTrashItem } from "./items/SceneTrashItem";
import { CodexTrashItem } from "./items/CodexTrashItem";
import { SnippetTrashItem } from "./items/SnippetTrashItem";
import { MapStickyTrashItem } from "./items/MapStickyTrashItem";
import { ForeshadowTrashItem } from "./items/ForeshadowTrashItem";
import { PinTrashItem } from "./items/PinTrashItem";
import { GridChapterTrashItem } from "./items/GridChapterTrashItem";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

export function TrashBinItem({ item, registerNode }: Props) {
  switch (item.subKind) {
    case "scene":
      return <SceneTrashItem item={item} registerNode={registerNode} />;
    case "codex-entry":
      return <CodexTrashItem item={item} registerNode={registerNode} />;
    case "snippet":
      return <SnippetTrashItem item={item} registerNode={registerNode} />;
    case "map-sticky":
      return <MapStickyTrashItem item={item} registerNode={registerNode} />;
    case "foreshadow":
      return <ForeshadowTrashItem item={item} registerNode={registerNode} />;
    case "pin":
      return <PinTrashItem item={item} registerNode={registerNode} />;
    case "grid-chapter":
      return <GridChapterTrashItem item={item} registerNode={registerNode} />;
    case "text-fragment":
      return <TextFragmentTrashItem item={item} registerNode={registerNode} />;
    default:
      return <FallbackTrashItem item={item} registerNode={registerNode} />;
  }
}

function TextFragmentTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);
  const source = dominantSource(item);
  const borderColor =
    source === "ai"
      ? "border-l-purple-500"
      : source === "unknown"
        ? "border-l-muted-foreground"
        : "border-l-foreground/70";
  return (
    <div
      ref={ref}
      className={`absolute will-change-transform select-none rounded-sm border border-border/40 border-l-2 bg-background/95 px-2 py-1 font-mono text-xs whitespace-nowrap text-foreground shadow-sm ${borderColor}`}
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      <span className="block overflow-hidden text-ellipsis">
        {item.previewText}
      </span>
    </div>
  );
}

function FallbackTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);
  // Phase 5 で各 subKind の見た目を本格化する。Phase 4 までは暫定 box。
  return (
    <div
      ref={ref}
      className="absolute will-change-transform select-none rounded-md border border-border/40 bg-muted/80 px-2 py-1 text-xs text-foreground shadow"
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
        {item.previewText}
      </span>
    </div>
  );
}
