import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/core";
import type { CodexMentionPopupState } from "@/features/codex/CodexMentionExtension";
import { createCodexMentionExtension } from "@/features/codex/CodexMentionExtension";
import { BracketInstructionDecoration } from "./BracketInstructionDecoration";

/**
 * Unplaced beat の小型 TipTap editor 用の最小拡張セット。
 * StarterKit はデフォルト設定（ブロックノードも含む）だが、
 * beat は inline* content なのでブロック分割操作が来ても問題ない。
 */
export function createUnplacedBeatExtensions(
  setMentionPopup: (state: CodexMentionPopupState | null) => void,
): Extensions {
  return [
    StarterKit,
    createCodexMentionExtension(setMentionPopup),
    BracketInstructionDecoration,
  ];
}
