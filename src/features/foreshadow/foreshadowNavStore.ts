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
  }),
);
