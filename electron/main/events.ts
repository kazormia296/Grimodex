/**
 * EventBus（設計書 §7.1、Phase 2 S7）。
 *
 * - renderer 発 emit: `ipcRenderer.send("grim:emit")` → renderer 専用 allowlist
 *   検証（列挙制、§5.4）→ **全窓に broadcast（送信元窓を含む）**。
 *   Tauri v2 の emit 契約（全窓配信 + 自己配信）と一致させる —
 *   codexWindowSync.ts のロック収束と external_mount 契約が依存する性質。
 * - napi ThreadsafeFunction 発: `backend.onEvent((channel, payloadJson) => …)`
 *   を main 起動時に 1 回登録し、同じ broadcast に載せる。Phase 2 は
 *   `backend:ready` / `workspace:opened` で end-to-end を実証し、Phase 3 で
 *   棚卸し済みの24チャネルをこの配線に載せる（§7.1）。
 */
import { BrowserWindow, ipcMain } from "electron";

import {
  IPC,
  isAllowedBackendEventChannel,
  isAllowedMainEventChannel,
  isAllowedRendererEventChannel,
} from "../shared/ipcContract.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import type { ProfileEgressGate } from "./profileEgress.js";
import {
  parseWorkspaceLifecycleView,
  type WorkspaceLifecycleView,
} from "./workspaceLifecycleView.js";
import {
  isRelatedScenesInvalidatedEvent,
  isRelatedScenesIndexReadyEvent,
  RELATED_SCENES_INVALIDATED_EVENT,
  RELATED_SCENES_INDEX_READY_EVENT,
} from "../shared/relatedScenesSearchWire.js";

/** Native completion signal consumed by main only; never broadcast to a window. */
export const NARRATIVE_MAINTENANCE_EPOCH_ROTATED_EVENT =
  "narrative-maintenance:epoch-rotated";

let profileEgressGate: ProfileEgressGate | null = null;
let latestWorkspaceLifecycleView: WorkspaceLifecycleView | null = null;

/** Install the startup gate before any trusted manager can publish an event. */
export function setBackendEventEgressGate(
  profileEgress?: ProfileEgressGate | null,
): void {
  profileEgressGate = profileEgress ?? null;
}

/** 全窓（送信元含む）へ 1 イベントを配信する。 */
export function broadcastEvent(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.event, channel, payload);
  }
}

/** backend / trusted manager 発イベントを検証して配信する。 */
export function broadcastBackendEvent(channel: string, payload: unknown): void {
  if (!isAllowedBackendEventChannel(channel)) {
    console.warn(
      `[backend:event] rejected non-backend channel: ${String(channel)}`,
    );
    return;
  }
  if (profileEgressGate && !profileEgressGate.allowsBackendEvent(channel)) {
    console.warn(`[backend:event] rejected D2a egress channel: ${channel}`);
    return;
  }
  if (channel === "workspace:lifecycle-state") {
    const lifecycle = acceptWorkspaceLifecycleView(payload);
    if (!lifecycle) return;
    payload = lifecycle;
    profileEgressGate?.observeBackendEvent?.(channel, lifecycle);
  }
  broadcastEvent(channel, payload);
}

function acceptWorkspaceLifecycleView(
  payload: unknown,
): WorkspaceLifecycleView | null {
  let view: WorkspaceLifecycleView;
  try {
    view = parseWorkspaceLifecycleView(payload);
  } catch (error) {
    console.warn(
      `[backend:event] invalid workspace lifecycle view: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (latestWorkspaceLifecycleView) {
    if (view.revision < latestWorkspaceLifecycleView.revision) return null;
    if (
      view.revision === latestWorkspaceLifecycleView.revision &&
      JSON.stringify(view) !== JSON.stringify(latestWorkspaceLifecycleView)
    ) {
      console.warn(
        "[backend:event] conflicting workspace lifecycle views at one revision",
      );
      return null;
    }
  }
  latestWorkspaceLifecycleView = view;
  return view;
}

/** Publish a validated lifecycle snapshot obtained through the main-only getter. */
export function publishWorkspaceLifecycleSnapshot(payload: unknown): boolean {
  const view = acceptWorkspaceLifecycleView(payload);
  if (!view) return false;
  broadcastBackendEvent("workspace:lifecycle-state", view);
  return true;
}

/** Refresh the lifecycle projection after renderer subscription / page load. */
export async function refreshWorkspaceLifecycleView(
  backend: NapiBackendLike | null,
): Promise<boolean> {
  const getter = backend?.getWorkspaceLifecycleView;
  if (typeof getter !== "function") return false;
  try {
    const raw = await getter.call(backend);
    return publishWorkspaceLifecycleSnapshot(raw);
  } catch (error) {
    console.warn("[backend:event] lifecycle snapshot refresh failed", error);
    return false;
  }
}

/**
 * backend / trusted manager event を特定 renderer のみに配信する。
 * Approval のような authority-bearing event は全窓 broadcast しない。
 */
export function sendBackendEventToWindow(
  webContentsId: number,
  channel: string,
  payload: unknown,
): void {
  if (!isAllowedBackendEventChannel(channel)) {
    console.warn(
      `[backend:event] rejected non-backend channel: ${String(channel)}`,
    );
    return;
  }
  if (profileEgressGate && !profileEgressGate.allowsBackendEvent(channel)) {
    console.warn(`[backend:event] rejected D2a egress channel: ${channel}`);
    return;
  }
  const target = BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
  );
  if (!target) return;
  try {
    target.webContents.send(IPC.event, channel, payload);
  } catch (cause) {
    console.warn(
      `[backend:event] target ${webContentsId} became unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Electron main 専用イベントを検証して配信する。 */
export function broadcastMainEvent(channel: string, payload: unknown): void {
  if (!isAllowedMainEventChannel(channel)) {
    console.warn(`[main:event] rejected non-main channel: ${String(channel)}`);
    return;
  }
  broadcastEvent(channel, payload);
}

/**
 * Electron main 専用イベントを特定 renderer のみに配信する。
 * Deep link のように main window だけが扱う UI signal を、detached panelへ
 * broadcastしないための経路。
 */
export function sendMainEventToWindow(
  webContentsId: number,
  channel: string,
  payload: unknown,
): void {
  if (!isAllowedMainEventChannel(channel)) {
    console.warn(`[main:event] rejected non-main channel: ${String(channel)}`);
    return;
  }
  const target = BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
  );
  if (!target) return;
  try {
    target.webContents.send(IPC.event, channel, payload);
  } catch (cause) {
    console.warn(
      `[main:event] target ${webContentsId} became unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * napi 発イベント 1 件の検証 + 配信。channel は backend 専用 allowlist
 * を通す（Phase 3 でチャネルを増やす際、ipcContract の allowlist 更新漏れを
 * ここの warn で顕在化させる）。payload は EventSink 契約
 * （serde_json::Value の to_string）どおり JSON 文字列で届くので parse して
 * Tauri の event.payload と同形にする。
 */
function handleBackendEvent(
  channel: unknown,
  payloadJson: unknown,
  observer?: (channel: string, payload: unknown) => void,
): void {
  const observerOnly = channel === NARRATIVE_MAINTENANCE_EPOCH_ROTATED_EVENT;
  if (
    typeof channel !== "string" ||
    (!observerOnly && !isAllowedBackendEventChannel(channel))
  ) {
    console.warn(
      `[backend:event] dropped non-allowlisted channel: ${String(channel)}`,
    );
    return;
  }
  if (
    typeof channel === "string" &&
    !observerOnly &&
    profileEgressGate &&
    !profileEgressGate.allowsBackendEvent(channel)
  ) {
    console.warn(`[backend:event] rejected D2a egress channel: ${channel}`);
    return;
  }
  let payload: unknown = payloadJson;
  if (typeof payloadJson === "string") {
    try {
      payload = JSON.parse(payloadJson) as unknown;
    } catch {
      // EventSink 契約上は起きない。起きた場合も配信自体は継続する（emit は
      // ベストエフォート契約 — 生文字列のまま流し、原因調査は warn に頼る）。
      console.warn(`[backend:event] non-JSON payload on ${channel}`);
    }
  }
  if (channel === "workspace:lifecycle-state") {
    const lifecycle = acceptWorkspaceLifecycleView(payload);
    if (!lifecycle) return;
    payload = lifecycle;
  }
  if (
    channel === RELATED_SCENES_INVALIDATED_EVENT &&
    !isRelatedScenesInvalidatedEvent(payload)
  ) {
    console.warn("[backend:event] invalid related-scenes invalidation payload");
    return;
  }
  if (
    channel === RELATED_SCENES_INDEX_READY_EVENT &&
    !isRelatedScenesIndexReadyEvent(payload)
  ) {
    console.warn(
      "[backend:event] invalid related-scenes index readiness payload",
    );
    return;
  }
  try {
    profileEgressGate?.observeBackendEvent?.(channel, payload);
    observer?.(channel, payload);
  } catch (cause) {
    console.warn(
      `[backend:event] observer failed on ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (observerOnly) return;
  broadcastEvent(channel, payload);
}

/**
 * app ready 後に 1 回だけ呼ぶ。`backend` は .node ロード失敗時 null
 * （renderer 発バスのみ生かす — napi イベントは配線なし）。
 * onEvent 登録時、登録前に emit されたイベント（`backend:ready`）が
 * emit 順で flush される（grimodex-node EventQueue の契約）。
 */
export function registerEventBus(
  backend: NapiBackendLike | null,
  observer?: (channel: string, payload: unknown) => void,
  profileEgress?: ProfileEgressGate,
): void {
  setBackendEventEgressGate(profileEgress);
  ipcMain.on(IPC.emit, (_event, channel: unknown, payload: unknown) => {
    if (
      typeof channel !== "string" ||
      !isAllowedRendererEventChannel(channel)
    ) {
      console.warn(
        `[grim:emit] rejected non-allowlisted channel: ${String(channel)}`,
      );
      return;
    }
    broadcastEvent(channel, payload);
  });

  backend?.onEvent((channel: unknown, payloadJson: unknown) => {
    handleBackendEvent(channel, payloadJson, observer);
  });
}
