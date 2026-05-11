/**
 * Chat 用の @ メンション拡張。
 * 共通実装 (codex / SceneEditor / Beat と共有) をベースに、
 * tree から scene を `extraItems` として流し込んで `@` を統一トリガにする。
 */
import {
  createCodexMentionExtension,
  type CodexMentionPopupState,
  type MentionItem,
} from "@/features/codex/CodexMentionExtension";
import { useTreeStore } from "@/features/tree/treeStore";

export type MentionPopupState = CodexMentionPopupState;
export type ChatMentionItem = MentionItem;

/**
 * scene サジェスト件数の上限。Chapter outline が増えすぎてもポップアップが
 * 縦長にならないようハードキャップ。codex 0 件のときに scene だけ並ぶ
 * ケースで体感が崩れないよう、codex の見た目と揃えて 50 件で十分。
 */
const SCENE_SUGGESTION_LIMIT = 50;

function buildSceneSuggestions(query: string): MentionItem[] {
  const scenes = useTreeStore.getState().scenes;
  const q = query.toLowerCase();
  const filtered =
    q === "" ? scenes : scenes.filter((s) => s.title.toLowerCase().includes(q));
  return filtered.slice(0, SCENE_SUGGESTION_LIMIT).map((s) => ({
    kind: "scene" as const,
    id: s.id,
    name: s.title,
    typeLabel: "scene",
  }));
}

export function createChatMentionExtension(
  setPopup: (state: CodexMentionPopupState | null) => void,
) {
  return createCodexMentionExtension(setPopup, {
    extraItems: (query: string) => buildSceneSuggestions(query),
  });
}
