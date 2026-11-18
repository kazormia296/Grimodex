import {
  MODEL_CAPABILITY_SNAPSHOT_COMMAND,
  parseModelCapabilitySnapshotView,
  type ModelCapabilitySnapshotView,
} from "@/../electron/shared/modelCapabilitySnapshotWire";
import { isElectron, invoke } from "@/lib/tauri";

export type {
  ModelCapabilityOrigin,
  ModelCapabilitySnapshotView,
} from "@/../electron/shared/modelCapabilitySnapshotWire";

/**
 * main が採用済みの「モデル能力の registry の写し」（取得済みの cache、無ければ同梱）を読む。
 * 読み取り専用の typed IPC で、取得を始める入口ではない（取得は main の scheduler だけが行う）。
 *
 * - Electron 以外では null（取得も同梱も無い）。
 * - main が契約の形で返さなかった値も null（壊れた値を能力表へ入れない）。
 * - IPC の失敗（同梱も cache も使えない、restricted の閉鎖など）は reject する。呼び出し側が自前の表へ落ちる。
 *
 * 能力表への統合は次の PR。返る key は `<provider>/<id>` だけで、表示や AI への入力にしない。
 */
export async function getModelCapabilitySnapshot(): Promise<ModelCapabilitySnapshotView | null> {
  if (!isElectron()) return null;
  const raw = await invoke<unknown>(MODEL_CAPABILITY_SNAPSHOT_COMMAND);
  return parseModelCapabilitySnapshotView(raw);
}
