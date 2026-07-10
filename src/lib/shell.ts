/**
 * 実行シェル判定（Electron）の実体（設計書 §3.4、Phase 2 S5）。
 *
 * `isElectron` の公開 API は従来どおり `@/lib/tauri`（re-export）だが、
 * 実体はこの独立モジュールに置く。理由: 既存テスト 86 ファイルが
 * `vi.mock("@/lib/tauri")` を部分 factory（`isTauri` のみ等）で当てており、
 * 各ラッパー（dialog / fs / uiScale …）が mocked モジュール経由で
 * `isElectron` を呼ぶと undefined 呼び出しで壊れる。ここに置けば
 * ラッパーは mock の影響を受けず、happy-dom（`window.grimodex` 不在）では
 * 従来どおり false → browser fallback になる。
 *
 * 分岐順は isTauri → isElectron → browser-mock（Tauri 窓に
 * `window.grimodex` は存在しないため、この順序は安全側の作法）。
 */

/** preload が `window.grimodex` に公開する GrimodexBridge
 *  （型の正本: src/types/grimodex-bridge.d.ts の declare global）。 */
export type ElectronBridge = NonNullable<Window["grimodex"]>;

/** Check at call time, not module-load time（isTauri と同じ作法）。 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && "grimodex" in window;
}

/**
 * Electron ブリッジ本体を返す。`isElectron()` ガード後にのみ呼ぶこと
 * （不在時は throw — 呼び出し側ラッパーの分岐バグを早期検出する）。
 */
export function electronBridge(): ElectronBridge {
  const bridge = typeof window !== "undefined" ? window.grimodex : undefined;
  if (!bridge) {
    throw new Error("Electron bridge is unavailable (window.grimodex missing)");
  }
  return bridge;
}
