/**
 * 窓間同期のトランスポート層（チャネル定数 + emit/listen ヘルパ）。
 *
 * 設計（検討メモ §C / §E）:
 * - 人間の書き込みは必ず JS の codexStore を通るので、書き込み後にフロントから
 *   broadcast すれば全窓で漏れなく拾える（v1 はフロント発 emit、Rust 発の
 *   命令横断 emit は v2 候補）。
 * - lock イベント（acquire/release/heartbeat）も同じ broadcast で全窓へ流し、
 *   各窓は codexEditLock の純レデューサで同一 holder に決定的収束する。
 * - externalWriteFeed(750ms) は MCP/agent の別プロセス用に併存。重複再ロードは
 *   loadEntries の冪等性で無害。
 */
import { emit, listen } from "@/lib/tauri";
import type { LockEvent } from "./codexEditLock";

// チャネル名はコードベース慣習 `name:subname`（chat:stream-chunk /
// license:state_changed 等）に合わせる。将来 Rust 側が同名で emit/listen する
// 際の grep・契約照合の一貫性のため。
/** あるプロジェクトの Codex データが変わった通知（受け手は loadEntries で再 hydrate）。 */
export const CODEX_CHANGED_CHANNEL = "codex:data-changed";
/** Codex 本文編集の advisory lock イベント。 */
export const CODEX_LOCK_CHANNEL = "codex:lock-event";

export interface CodexChangedPayload {
  projectId: string;
}

export function emitCodexChanged(projectId: string): Promise<void> {
  return emit<CodexChangedPayload>(CODEX_CHANGED_CHANNEL, { projectId });
}

export function onCodexChanged(
  handler: (payload: CodexChangedPayload) => void,
): Promise<() => void> {
  return listen<CodexChangedPayload>(CODEX_CHANGED_CHANNEL, handler);
}

export function emitLockEvent(ev: LockEvent): Promise<void> {
  return emit<LockEvent>(CODEX_LOCK_CHANNEL, ev);
}

export function onLockEvent(
  handler: (ev: LockEvent) => void,
): Promise<() => void> {
  return listen<LockEvent>(CODEX_LOCK_CHANNEL, handler);
}
