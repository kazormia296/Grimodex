import { create } from "zustand";

/**
 * セマンティック検索結果クリックによる「シーンを開いてからチャンク位置へ
 * スクロール+選択ハイライト」ナビゲーション要求。
 * パネル (SemanticSearchDialog) 側が書き、エディタ側がシーンロード後に一度だけ
 * 消費する。foreshadowNavStore と同じ運用。
 *
 * `chunkText` は Rust 側 SearchHit.chunkText の生文字列。
 * findChunkInDoc(doc, chunkText) で PM position に変換する。
 */
export interface PendingChunkJump {
  sceneId: string;
  chunkText: string;
}

interface SemanticNavState {
  pendingJump: PendingChunkJump | null;
  requestJump: (jump: PendingChunkJump) => void;
  /** 該当 sceneId の jump があれば返し、内部状態は null にする (idempotent)。 */
  consumeJump: (sceneId: string) => PendingChunkJump | null;
}

export const useSemanticNavStore = create<SemanticNavState>()((set, get) => ({
  pendingJump: null,
  requestJump: (jump) => set({ pendingJump: jump }),
  consumeJump: (sceneId) => {
    const { pendingJump } = get();
    if (!pendingJump || pendingJump.sceneId !== sceneId) return null;
    set({ pendingJump: null });
    return pendingJump;
  },
}));
