import { useCallback, useMemo } from "react";
import type { TrashItemData } from "./types";
import { dominantSource, getBodySize } from "./displayHelpers";
import { SceneTrashItem } from "./items/SceneTrashItem";
import { CodexTrashItem } from "./items/CodexTrashItem";
import { SnippetTrashItem } from "./items/SnippetTrashItem";
import { MapStickyTrashItem } from "./items/MapStickyTrashItem";
import { ForeshadowTrashItem } from "./items/ForeshadowTrashItem";
import { GridChapterTrashItem } from "./items/GridChapterTrashItem";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
  /** ドラッグ中フラグ。true なら body を半透明 + 影強調する。 */
  isDragging?: boolean;
}

/**
 * D&D の起点になる `data-trash-body-id` 属性 + 「ドラッグ中」スタイルを
 * subKind 別コンポーネントの周囲にラップする。各子コンポーネントの自前 div を
 * これでラップすると 2 重 box になり物理計算が壊れるため、子コンポーネントが
 * 自身の最外要素にこれらを乗せる。簡便のため、ここでは ref forward する形で
 * children にラップ用 attribute を付与する Wrapper を提供する。
 *
 * 実装方針: 子コンポーネントは従来どおり position:absolute の最外 div を返す。
 * 本ラッパは外側に何も追加せず、ref callback の中で `el.dataset.trashBodyId` と
 * `data-dragging` を後付けする。
 */
function withBodyAttributes(
  registerNode: (id: string, el: HTMLElement | null) => void,
  itemId: string,
  isDragging: boolean,
): (id: string, el: HTMLElement | null) => void {
  return (id, el) => {
    if (el) {
      el.dataset.trashBodyId = itemId;
      el.dataset.dragging = String(isDragging);
      if (isDragging) {
        el.style.zIndex = "100";
        el.style.opacity = "0.85";
        el.style.cursor = "grabbing";
      } else {
        el.style.zIndex = "";
        el.style.opacity = "";
        el.style.cursor = "grab";
      }
    }
    registerNode(id, el);
  };
}

export function TrashBinItem({
  item,
  registerNode,
  isDragging = false,
}: Props) {
  // wrapper を memoize して子の useCallback ref deps を安定化させ、
  // レンダごとの ref detach/reattach (nodesRef の取りこぼし) を防ぐ。
  const reg = useMemo(
    () => withBodyAttributes(registerNode, item.id, isDragging),
    [registerNode, item.id, isDragging],
  );
  switch (item.subKind) {
    case "scene":
      return <SceneTrashItem item={item} registerNode={reg} />;
    case "codex-entry":
      return <CodexTrashItem item={item} registerNode={reg} />;
    case "snippet":
      return <SnippetTrashItem item={item} registerNode={reg} />;
    case "map-sticky":
      return <MapStickyTrashItem item={item} registerNode={reg} />;
    case "foreshadow":
      return <ForeshadowTrashItem item={item} registerNode={reg} />;
    case "grid-chapter":
      return <GridChapterTrashItem item={item} registerNode={reg} />;
    case "text-fragment":
      return <TextFragmentTrashItem item={item} registerNode={reg} />;
    default:
      return <FallbackTrashItem item={item} registerNode={reg} />;
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
