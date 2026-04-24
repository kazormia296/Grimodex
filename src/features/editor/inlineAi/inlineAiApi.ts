import type { InlineAiCommand, InlineAiContext } from "./inlineAiTypes";
import { sendInlineAiStream, abortInlineAiStream } from "./inlineAiStreaming";

export function buildSystemPrompt(
  _command: InlineAiCommand,
  ctx: InlineAiContext,
): string {
  const lines: string[] = [
    `あなたは小説執筆アシスタントです。プロジェクト「${ctx.projectTitle}」のシーン「${ctx.sceneTitle}」の執筆を支援しています。`,
  ];
  if (ctx.codexSummaries) {
    lines.push(`\n## 関連設定\n${ctx.codexSummaries}`);
  }
  return lines.join("\n");
}

export function buildUserPrompt(
  command: InlineAiCommand,
  ctx: InlineAiContext,
): string {
  const scene = `\n## シーン本文\n${ctx.sceneText}`;
  const cursor = ctx.cursorContext
    ? `\n## カーソル周辺（【カーソル】マーカーの前後）\n${ctx.cursorContext}`
    : "";
  const selection = ctx.selectedText
    ? `\n## 選択テキスト\n${ctx.selectedText}`
    : "";

  switch (command.id) {
    case "continue":
      return `${scene}${cursor}\n\n続きを書いてください。自然な流れで500文字程度。本文のみ出力してください。`;
    case "rewrite":
      return `${scene}${selection}\n\n選択テキストを同じ意味でより良く書き直してください。本文のみ出力してください。`;
    case "describe":
      return `${scene}${cursor}\n\n「${ctx.arg ?? "対象"}」の描写を書いてください。本文のみ出力してください。`;
    case "dialogue":
      return `${scene}${cursor}\n\n「${ctx.arg ?? "キャラクター"}」の台詞と地の文を書いてください。本文のみ出力してください。`;
    case "shorten":
      return `${scene}${selection}\n\n選択テキストを意味を保ちながら短く簡潔にしてください。本文のみ出力してください。`;
    case "expand":
      return `${scene}${selection}\n\n選択テキストに詳細・描写を加えて膨らませてください。本文のみ出力してください。`;
    case "tone":
      return `${scene}${selection}\n\n選択テキストのトーンを「${ctx.arg ?? ""}」に変えてください。本文のみ出力してください。`;
    case "translate":
      return `${scene}${selection}\n\n選択テキストを「${ctx.arg ?? "English"}」に翻訳してください。翻訳文のみ出力してください。`;
    case "custom":
      return `${scene}${cursor}${selection}\n\n${ctx.arg ?? "テキストを改善してください。"}本文のみ出力してください。`;
    default:
      return `${scene}${cursor}\n\n続きを書いてください。本文のみ出力してください。`;
  }
}

/**
 * インライン AI をストリーミング実行する。
 * - chunk 受信のたびに `onChunk` が呼ばれる（真のストリーミング）
 * - `signal.aborted` になるとバックエンドに abort コマンドを送る
 * - Promise は `stop_reason === "stopped"` でも resolve し、呼び出し側で中止と
 *   通常終了を区別できるよう `stopReason` を返す
 */
export async function generateInlineAi(
  command: InlineAiCommand,
  context: InlineAiContext,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; model: string; stopReason: string }> {
  const messages = [
    { role: "system", content: buildSystemPrompt(command, context) },
    { role: "user", content: buildUserPrompt(command, context) },
  ];

  let accumulated = "";
  const cleanupRef: { fn: (() => void) | null } = { fn: null };

  const result = await new Promise<{ stopReason: string }>(
    (resolve, reject) => {
      const onAbort = () => {
        abortInlineAiStream().catch(() => {});
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      sendInlineAiStream(messages, {
        onTextDelta: (delta) => {
          accumulated += delta;
          onChunk(delta);
        },
        onDone: (info) => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ stopReason: info.stopReason });
        },
        onError: (message) => {
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(message));
        },
      })
        .then((c) => {
          cleanupRef.fn = c;
        })
        .catch((e: unknown) => {
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    },
  );

  cleanupRef.fn?.();

  return {
    text: accumulated,
    model: "claude-sonnet-4-6",
    stopReason: result.stopReason,
  };
}
