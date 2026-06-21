import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  reduceLock,
  canEdit as canEditPure,
  type LockState,
  type LockEvent,
} from "./codexEditLock";
import { emitLockEvent, onLockEvent } from "./codexWindowSync";
import {
  getPanelWindowTarget,
  panelWindowLabel,
} from "@/features/layout/multiwindow/panelWindow";

// holder 失効までの猶予。heartbeat 間隔より十分長く取り、生存中の取りこぼしで
// 誤って奪わないようにする。閉じ忘れ/クラッシュ時はこの時間で復帰。
const TTL_MS = 8000;
const HEARTBEAT_MS = 3000;

function computeWindowId(): string {
  const target = getPanelWindowTarget();
  return target ? panelWindowLabel(target) : "main";
}

/** この窓の安定 ID（main / panel-<id>）。窓ごとに一意・不変なのでモジュール load 時に確定。 */
export const CURRENT_WINDOW_ID = computeWindowId();

interface LockStoreState {
  state: LockState;
}
const useStore = create<LockStoreState>(() => ({ state: {} }));

/** 受信した lock イベント（自窓 dispatch / 他窓 broadcast）を state に畳み込む。 */
export function applyRemoteLockEvent(ev: LockEvent): void {
  useStore.setState((s) => ({ state: reduceLock(s.state, ev, TTL_MS) }));
}

function dispatch(type: LockEvent["type"], entryId: string): void {
  const ev: LockEvent = {
    type,
    entryId,
    windowId: CURRENT_WINDOW_ID,
    ts: Date.now(),
  };
  applyRemoteLockEvent(ev); // ローカル即時反映
  void emitLockEvent(ev); // 全窓へ broadcast（自窓 echo は idempotent）
}

export const acquireLock = (entryId: string): void =>
  dispatch("acquire", entryId);
export const releaseLock = (entryId: string): void =>
  dispatch("release", entryId);
export const heartbeatLock = (entryId: string): void =>
  dispatch("heartbeat", entryId);

/** この窓が entry を編集してよいか（holder 不在 / 自分 / 失効なら可）。 */
export function canEditEntry(entryId: string): boolean {
  return canEditPure(
    useStore.getState().state,
    entryId,
    CURRENT_WINDOW_ID,
    Date.now(),
    TTL_MS,
  );
}

let listenerStarted = false;
let unlisten: (() => void) | undefined;

/** 他窓の lock イベント購読を 1 度だけ開始する。 */
export function startCodexLockListener(): void {
  if (listenerStarted) return;
  listenerStarted = true;
  void onLockEvent((ev) => applyRemoteLockEvent(ev)).then((u) => {
    unlisten = u;
  });
}

export function __resetCodexEditLockForTest(): void {
  useStore.setState({ state: {} });
  unlisten?.();
  unlisten = undefined;
  listenerStarted = false;
}

/**
 * entry の本文編集 advisory lock。CodexManagementPanel が選択中 entry で 1 度呼ぶ。
 * mount/選択時に acquire＋heartbeat、unmount/entry 変更時に release。
 * 戻り値 canEdit が false の間、UI は本文エディタを read-only ＋バナー表示にする。
 */
export function useCodexEditLock(entryId: string | null): boolean {
  useEffect(() => {
    startCodexLockListener();
  }, []);

  const [, force] = useState(0);

  useEffect(() => {
    if (!entryId) return;
    acquireLock(entryId);
    const hb = setInterval(() => {
      heartbeatLock(entryId);
      // holder が死んで heartbeat が途絶えた場合の TTL 失効を拾うため再評価を促す。
      force((n) => n + 1);
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(hb);
      releaseLock(entryId);
    };
  }, [entryId]);

  const state = useStore((s) => s.state);
  if (!entryId) return true;
  return canEditPure(state, entryId, CURRENT_WINDOW_ID, Date.now(), TTL_MS);
}
