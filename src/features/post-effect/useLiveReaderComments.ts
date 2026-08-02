import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";

export interface LiveReaderCommentsParams {
  editor: Editor | null;
  sceneId: string;
  enabled: boolean;
  persona: string;
  genre: string | null;
  targetReaders: string | null;
  lang: string;
}

let nextLiveReaderOwnerId = 0;

/**
 * 追記だけを低頻度で AI へ渡す本文側の接続。重い生成経路は本文入力で
 * 有効化されたときだけ dynamic import し、通常の起動グラフへ含めない。
 */
export function useLiveReaderComments({
  editor,
  sceneId,
  enabled,
  persona,
  genre,
  targetReaders,
  lang,
}: LiveReaderCommentsParams): void {
  const ownerIdRef = useRef<number | null>(null);
  if (ownerIdRef.current === null) ownerIdRef.current = ++nextLiveReaderOwnerId;

  useEffect(() => {
    if (!editor || !sceneId || !enabled) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;
    void import("./liveReaderRuntime")
      .then(({ attachLiveReaderComments }) => {
        if (disposed) return;
        cleanup = attachLiveReaderComments({
          editor,
          sceneId,
          enabled,
          persona,
          genre,
          targetReaders,
          lang,
          ownerId: ownerIdRef.current ?? 0,
        });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.warn("live reader runtime load failed", error);
        }
      });

    return () => {
      disposed = true;
      cleanup?.();
      cleanup = null;
    };
  }, [editor, sceneId, enabled, persona, genre, targetReaders, lang]);
}
