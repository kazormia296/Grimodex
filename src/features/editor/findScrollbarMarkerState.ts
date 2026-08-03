import type { Editor } from "@tiptap/react";
import type { FindReplaceStorage } from "./FindReplaceExtension";
import type { FindScrollbarMarker } from "./findScrollbarMarkerGeometry";

export interface FindStateSnapshot {
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  currentIndex: number;
  matches: FindReplaceStorage["matches"];
}

export function readFindState(editor: Editor): FindStateSnapshot | null {
  const storage = (
    editor.storage as { findReplace?: FindReplaceStorage } | undefined
  )?.findReplace;
  if (!storage) return null;
  return {
    query: storage.query,
    caseSensitive: storage.caseSensitive,
    useRegex: storage.useRegex,
    currentIndex: storage.currentIndex,
    matches: storage.matches,
  };
}

export function sameFindState(
  left: FindStateSnapshot | null,
  right: FindStateSnapshot | null,
): boolean {
  return (
    left?.query === right?.query &&
    left?.caseSensitive === right?.caseSensitive &&
    left?.useRegex === right?.useRegex &&
    left?.currentIndex === right?.currentIndex &&
    left?.matches === right?.matches
  );
}

export function sameFindMarkers(
  left: ReadonlyArray<FindScrollbarMarker>,
  right: ReadonlyArray<FindScrollbarMarker>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (marker, index) =>
        marker.positionPercent === right[index]?.positionPercent &&
        marker.current === right[index]?.current,
    )
  );
}
