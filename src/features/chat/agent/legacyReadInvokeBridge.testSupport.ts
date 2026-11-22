/**
 * MP-4b PR-0：`@/lib/tauri` の `invoke` に挟む spy／差し替えの橋（何も import しない）。
 *
 * 試験側の `vi.mock("@/lib/tauri", ...)` が、本物の `invoke`（browser-mock＝実 sql.js）を
 * `bindActual` で渡し、`invoke` を差し替えとして返す。この module 自体は `@/lib/tauri` を
 * import しない（mock の factory 実行中に循環しないため）。
 *
 * 使い道は 3 つ：
 * 1. 呼ばれた command・引数の記録（`calls`）。Native 経路の command 名・引数・scope の固定。
 * 2. command 単位の差し替え（`override`）。browser-mock の dense は常に `[]` なので、
 *    semantic 2 本と fts にだけ canned の結果を返す。
 * 3. 呼出し時の hook（`onCall`）。await の途中で store を書き換え、読取り位置を固定する。
 */

export interface BridgeCall {
  readonly cmd: string;
  readonly args: Record<string, unknown> | undefined;
}

type ActualInvoke = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

type Override = (args: Record<string, unknown> | undefined) => unknown;

type OnCall = (call: BridgeCall) => void | Promise<void>;

let actual: ActualInvoke | null = null;
let onCall: OnCall | null = null;
const overrides = new Map<string, Override>();
const recorded: BridgeCall[] = [];

export const legacyReadInvokeBridge = {
  bindActual(fn: ActualInvoke): void {
    actual = fn;
  },
  /** 本物へ素通しする invoke（記録・hook・差し替えを通る）。 */
  invoke: async (
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> => {
    recorded.push({ cmd, args });
    if (onCall) await onCall({ cmd, args });
    const replace = overrides.get(cmd);
    if (replace) return replace(args);
    if (!actual) throw new Error("legacyReadInvokeBridge: actual not bound");
    return actual(cmd, args);
  },
  /** command 単位で結果を差し替える。 */
  override(cmd: string, fn: Override): void {
    overrides.set(cmd, fn);
  },
  /** 呼出しのたびに（本物か差し替えの前に）実行する hook。null で外す。 */
  setOnCall(fn: OnCall | null): void {
    onCall = fn;
  },
  calls(cmd?: string): BridgeCall[] {
    return cmd ? recorded.filter((c) => c.cmd === cmd) : [...recorded];
  },
  /** 記録・差し替え・hook を空にする（本物の binding は残す）。 */
  reset(): void {
    recorded.length = 0;
    overrides.clear();
    onCall = null;
  },
};
