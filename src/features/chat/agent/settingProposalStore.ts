import { create } from "zustand";

/** 提案カードの利用者の判断（メモリ内。再読込後の履歴は未判断の表示に戻り、今の値から状態を導く）。 */
export type SettingProposalOutcome =
  | {
      status: "applied";
      previous: string;
      /** 適用前に明示値が有ったか。false の「元に戻す」は明示値を消す。 */
      previousExplicit: boolean;
      applied: string;
    }
  | { status: "dismissed" }
  | { status: "reverted" };

interface SettingProposalState {
  outcomes: Record<string, SettingProposalOutcome>;
  record: (proposalId: string, outcome: SettingProposalOutcome) => void;
}

export const useSettingProposalStore = create<SettingProposalState>()(
  (set) => ({
    outcomes: {},
    record: (proposalId, outcome) =>
      set((state) => ({
        outcomes: { ...state.outcomes, [proposalId]: outcome },
      })),
  }),
);
