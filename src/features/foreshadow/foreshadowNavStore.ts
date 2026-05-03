import { create } from "zustand";

/**
 * シーンを跨いだ「シーンを開いてからその位置を選択」ナビゲーション要求。
 * パネル側が書き、エディタ側が該当シーンのロード後に一度だけ消費する。
 */
export interface PendingForeshadowJump {
  sceneId: string;
  fromPos: number;
  toPos: number;
}

interface ForeshadowNavState {
  pendingJump: PendingForeshadowJump | null;
  requestJump: (jump: PendingForeshadowJump) => void;
  consumeJump: (sceneId: string) => PendingForeshadowJump | null;

  /** エディタのホバーポップオーバーからパネル行にジャンプする要求。 */
  pendingPanelHighlight: string | null;
  requestPanelHighlight: (foreshadowId: string) => void;
  consumePanelHighlight: () => string | null;

  /** Grid カードからシーン関連に絞り込む要求。 */
  pendingSceneFilter: string | null;
  requestSceneFilter: (sceneId: string) => void;
  consumeSceneFilter: () => string | null;
}

export const useForeshadowNavStore = create<ForeshadowNavState>()(
  (set, get) => ({
    pendingJump: null,
    requestJump: (jump) => set({ pendingJump: jump }),
    consumeJump: (sceneId) => {
      const { pendingJump } = get();
      if (!pendingJump || pendingJump.sceneId !== sceneId) return null;
      set({ pendingJump: null });
      return pendingJump;
    },

    pendingPanelHighlight: null,
    requestPanelHighlight: (foreshadowId) =>
      set({ pendingPanelHighlight: foreshadowId }),
    consumePanelHighlight: () => {
      const { pendingPanelHighlight } = get();
      if (!pendingPanelHighlight) return null;
      set({ pendingPanelHighlight: null });
      return pendingPanelHighlight;
    },

    pendingSceneFilter: null,
    requestSceneFilter: (sceneId) => set({ pendingSceneFilter: sceneId }),
    consumeSceneFilter: () => {
      const { pendingSceneFilter } = get();
      if (!pendingSceneFilter) return null;
      set({ pendingSceneFilter: null });
      return pendingSceneFilter;
    },
  }),
);
