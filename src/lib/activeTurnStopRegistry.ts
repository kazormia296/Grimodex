/**
 * 生成中の応答を持つ機能（chat の store）が登録する口。終了や切替の前の確認が使う。
 * 切替の側（projectStore など）が chat の store を直接読まないためにある。
 */
export interface ActiveTurnStopper {
  isActive(): boolean;
  stop(): void;
}

let stopper: ActiveTurnStopper | null = null;

export function registerActiveTurnStopper(next: ActiveTurnStopper): void {
  stopper = next;
}

export function getActiveTurnStopper(): ActiveTurnStopper | null {
  return stopper;
}
