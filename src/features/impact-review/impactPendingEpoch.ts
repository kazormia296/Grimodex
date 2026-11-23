import { create } from "zustand";

/**
 * 影響チェックの押下が終わった合図（メモリ内の連番だけ。保存しない）。
 * `no-candidates`／`no-change` は post-effect の run を作らずに baseline を進めるので、
 * run の running の変化だけでは再計算の契機を拾えない。ボタンが `finally` で bump し、
 * 「前回のチェック以降の変更」を表示する側（整合性タブの点・ボタン上の 1 行）が拾う。
 */
interface ImpactPendingEpochState {
  epoch: number;
  bump: () => void;
}

export const useImpactPendingEpochStore = create<ImpactPendingEpochState>(
  (set) => ({
    epoch: 0,
    bump: () => set((s) => ({ epoch: s.epoch + 1 })),
  }),
);
