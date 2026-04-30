import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";

export type InlineAiTextResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Run one inline-AI stream and resolve with the full text once `onDone` fires.
 * Always tears down the underlying Tauri listeners before resolving — without
 * this, every call leaks 3 listeners (regression of commit 337521c).
 *
 * The `settled`+`cleanup` pair handles the (theoretical) race where callbacks
 * fire before the awaited `sendInlineAiStream` Promise resolves.
 */
export function streamInlineAiText(
  messages: { role: string; content: string }[],
  options?: { model?: string },
): Promise<InlineAiTextResult> {
  return new Promise((resolve) => {
    const buffer: string[] = [];
    let cleanup: (() => void) | null = null;
    let settled = false;

    const settle = (result: InlineAiTextResult) => {
      if (settled) return;
      settled = true;
      cleanup?.();
      cleanup = null;
      resolve(result);
    };

    sendInlineAiStream(
      messages,
      {
        onTextDelta: (delta) => {
          buffer.push(delta);
        },
        onDone: () => settle({ ok: true, text: buffer.join("") }),
        onError: (message) => settle({ ok: false, error: message }),
      },
      options,
    )
      .then((c) => {
        if (settled) c();
        else cleanup = c;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        settle({ ok: false, error: msg });
      });
  });
}
