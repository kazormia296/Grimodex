import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";

/**
 * コマンドの `run` が必要とする文脈。
 *
 * 今は GlobalCommandHost の props（キー操作の呼び出し元）が持つ値で、キー以外の
 * 呼び出し元（将来の Chat の agent）も同じ形で渡せるようにここに型を置く。
 */
export interface CommandContext {
  /** phone 幅の workspace か。phone では desktop の layout／tab を変えない。 */
  phoneWorkspace: boolean;
  runtimeCapabilities: Pick<RuntimeCapabilities, "genericProjectTransfer">;
  onToggleExport: () => void;
  onOpenSettings: () => void;
}

let registered: CommandContext | null = null;

/**
 * いま実行中の host（GlobalCommandHost）の文脈を登録する。返り値は登録解除で、
 * 自分が登録した値のときだけ消す（再 mount で入れ替わった後の古い cleanup が
 * 新しい登録を消さないため）。
 */
export function registerCommandContext(context: CommandContext): () => void {
  registered = context;
  return () => {
    if (registered === context) registered = null;
  };
}

/** 登録済みの文脈。host が mount されていなければ null。 */
export function getRegisteredCommandContext(): CommandContext | null {
  return registered;
}

const INERT_CONTEXT: CommandContext = {
  phoneWorkspace: false,
  runtimeCapabilities: { genericProjectTransfer: false },
  onToggleExport: () => {},
  onOpenSettings: () => {},
};

/**
 * 登録済みの文脈（無ければ何もしない既定）に `overrides` を重ねた文脈を作る。
 * 文脈の一部（phone かどうか等）だけを知っている呼び出し元が使う。
 */
export function resolveCommandContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return { ...(registered ?? INERT_CONTEXT), ...overrides };
}
