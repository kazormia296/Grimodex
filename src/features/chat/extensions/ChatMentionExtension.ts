/**
 * Chat 用の @ メンション拡張。
 * 実体は features/codex の共通実装に移管済み（SceneEditor / Beat と共有）。
 * 既存の import パスを保つため、ここでは re-export だけ。
 */
import {
  createCodexMentionExtension,
  type CodexMentionPopupState,
} from "@/features/codex/CodexMentionExtension";

export type MentionPopupState = CodexMentionPopupState;
export const createChatMentionExtension = createCodexMentionExtension;
