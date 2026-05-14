/**
 * CLI プロバイダ (Claude Code / Codex / OpenCode) を Chat バックエンドとして
 * 利用するための Tauri command ラッパ。
 *
 * - 通常チャット (HTTP API 系) と同じ `chat:stream-chunk` / `chat:stream-done` /
 *   `chat:stream-error` イベントを emit するため、フロント側のストリーミング
 *   ハンドリング (`sendChatMessageStream` の `StreamCallbacks` 等) はそのまま
 *   再利用できる。
 * - subprocess 起動なので、API キーや baseURL は使わない。代わりに binary path /
 *   model / cli kind を payload で渡す。
 */

import { invoke, listen } from "@/lib/tauri";
import type { CliKind } from "./types";

interface StreamChunkPayload {
  delta: string;
  block_type: "text" | "thinking";
}

interface StreamDonePayload {
  stop_reason: string;
  input_tokens?: number;
  output_tokens?: number;
}

interface StreamErrorPayload {
  message: string;
}

export interface CliStreamCallbacks {
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onDone: (info: {
    stopReason: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;
  onError: (message: string) => void;
}

export interface CliChatPayload {
  cli: CliKind;
  binaryPath?: string;
  model?: string;
  /** 単一プロンプト本体。CLI には引数として渡される (`-p <prompt>` 等)。 */
  prompt: string;
}

/**
 * CLI subprocess を起動して stream-chunk / stream-done イベントを発火させる。
 * 戻り値はリスナー解除用の cleanup 関数。
 */
export async function sendCliChatStream(
  payload: CliChatPayload,
  callbacks: CliStreamCallbacks,
): Promise<() => void> {
  // CLI 専用のイベント名空間 (cli:stream-*) を使う。
  // HTTP 系チャット (chat:stream-*) と inline AI が同じバスを使っているため、
  // CLI も同じイベント名にすると複数ストリーム同時走行時に混信する。
  const unlisteners = await Promise.all([
    listen<StreamChunkPayload>("cli:stream-chunk", (p) => {
      if (p.block_type === "thinking") {
        callbacks.onThinkingDelta(p.delta);
      } else {
        callbacks.onTextDelta(p.delta);
      }
    }),
    listen<StreamDonePayload>("cli:stream-done", (p) => {
      callbacks.onDone({
        stopReason: p.stop_reason,
        inputTokens: p.input_tokens,
        outputTokens: p.output_tokens,
      });
    }),
    listen<StreamErrorPayload>("cli:stream-error", (p) => {
      callbacks.onError(p.message);
    }),
  ]);
  const cleanup = () => {
    unlisteners.forEach((u) => u());
  };

  invoke<void>("send_cli_chat_stream", { payload }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    callbacks.onError(msg);
  });

  return cleanup;
}

/** 進行中の CLI ストリームを abort する */
export async function abortCliChatStream(): Promise<void> {
  await invoke<void>("abort_cli_chat_stream");
}

/**
 * CLI バイナリを PATH 上から探す。
 * 見つかればフルパス、なければ null。Settings の「自動検出」ボタンで使う。
 */
export async function detectCliBinary(cli: CliKind): Promise<string | null> {
  const result = await invoke<string | null>("detect_cli_binary", { cli });
  return result;
}

/** `<binary> --version` を叩いて起動可否を確認する */
export async function testCliConnection(binaryPath: string): Promise<string> {
  return invoke<string>("test_cli_connection", { binaryPath });
}
