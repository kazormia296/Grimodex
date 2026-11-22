import type { ChatMessage } from "./chatTypes";

type RowLike = Pick<ChatMessage, "id" | "role" | "content"> & {
  metadata?: string | null;
};

function parseRecord(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 再生成の元になる user の行。対象の assistant の直前（system と要約のマーカーを除く）が
 * user のときだけ返す。失敗・停止した turn は user の行を完了時にしか保存しないので、
 * 再読込の後には「直前に user の無い assistant 行」が残る。そこから遡って別の turn の
 * user を探すと、前の発話を再送してしまう。
 */
export function regenerationSourceUser<T extends RowLike>(
  messages: readonly T[],
  assistantMessageId: string,
): T | null {
  const index = messages.findIndex(
    (message) => message.id === assistantMessageId,
  );
  if (index === -1) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = messages[i]!;
    if (
      candidate.role === "system" ||
      "summary_id" in parseRecord(candidate.metadata)
    ) {
      continue;
    }
    return candidate.role === "user" ? candidate : null;
  }
  return null;
}

const DISPLAYED_METADATA_LISTS = [
  "tool_calls",
  "thinking_blocks",
  "citations",
  "codex_items",
  "codex_warnings",
] as const;

/**
 * 表示するものが何も無く、かつ「残り行」の印のある assistant の行。本文が空で、tool_calls・
 * thinking_blocks・引用・Codex の項目も無く、metadata が無い（出典用に予約したまま
 * 確定されなかった行）か、`stopped`／`runtime_error` の印がある（停止・失敗の残り）。
 * 正常に完了した空の回答（reasoning が上限で本文なしに終わった等。model・token の
 * meta 行を出す）や要約のマーカーは含めない。生成中かどうかは呼び出し側で判断する。
 */
export function isBlankAssistantRow(message: RowLike): boolean {
  if (message.role !== "assistant" || message.content.trim()) return false;
  const metadata = parseRecord(message.metadata);
  if ("summary_id" in metadata) return false;
  const hasDisplayed = DISPLAYED_METADATA_LISTS.some((key) => {
    const value = metadata[key];
    return Array.isArray(value) && value.length > 0;
  });
  if (hasDisplayed) return false;
  return (
    Object.keys(metadata).length === 0 ||
    metadata.stopped === true ||
    "runtime_error" in metadata
  );
}

/**
 * 一覧に出す行（system と、表示するものが無い assistant 行を除く）。行そのものは消さない
 * （出典の参照先なので、DB にも store にも残す）。生成中は末尾の行を隠さない
 * （agent の経路では、本文が来る前の行が空のまま末尾にある）。
 */
export function visibleChatRows<T extends RowLike>(
  messages: readonly T[],
  isStreaming: boolean,
): T[] {
  const lastId = messages.at(-1)?.id;
  return messages.filter(
    (message) =>
      message.role !== "system" &&
      !(
        isBlankAssistantRow(message) && !(isStreaming && message.id === lastId)
      ),
  );
}
