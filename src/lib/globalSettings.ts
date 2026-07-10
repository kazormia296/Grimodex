import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "@/features/workspace/store";

/**
 * GlobalSettings（global-settings.json）の read-modify-write を、全 writer で
 * 単一フライト直列化するモジュールレベルのチェーン。
 *
 * 背景: layoutStore / gridStore / mapStore / timelineStore / chronicleStore /
 * matrixStore / workspaceStore はいずれも「get_global_settings で全体を読み、
 * 自分の slice だけ差し替えて save_global_settings で全体を書き戻す」形をとる。
 * Rust 側の write_lock は save 1 回の file write しか直列化せず、read→save を跨ぐ
 * 2 IPC の区間は保護しない。2 つの writer が同じ v0 を読んでから順に書き戻すと、
 * 後勝ちの全体書き込みが相手の slice を v0 のまま上書きし、lost update になる
 * （例: レイアウトの 500ms デバウンス保存と grid 設定のユーザー操作保存の交錯）。
 *
 * 全 writer は同一 renderer 上にあるため、モジュールレベルの Promise チェーンで
 * read-modify-write を直列化すれば、各 writer の read は必ず前の writer の save
 * 確定後に走る。これにより stale-slice の上書きを構造的に排除する。
 */
let chain: Promise<unknown> = Promise.resolve();

/**
 * `patch` を「直前の書き込み確定後に読んだ最新の GlobalSettings」に適用し、その
 * 結果を保存する。保存後の GlobalSettings を解決値として返す。呼び出しは到着順に
 * 直列化される。読み書きのいずれかが失敗した場合は reject するが、内部チェーンは
 * 生かすため後続の writer は影響を受けない（呼び出し側で個別に成否を扱うこと）。
 */
export function patchGlobalSettings(
  patch: (current: GlobalSettings) => GlobalSettings,
): Promise<GlobalSettings> {
  const run = chain.then(async () => {
    const current = await invoke<GlobalSettings>("get_global_settings");
    const next = patch(current);
    await invoke("save_global_settings", { settings: next });
    return next;
  });
  // チェーンは失敗しても生かす（握り潰した rejection で後続 writer を止めない）。
  chain = run.catch(() => {});
  return run;
}
