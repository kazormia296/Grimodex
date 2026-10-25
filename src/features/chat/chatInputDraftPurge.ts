/**
 * チャット入力の下書き（renderer の localStorage）を session／project の削除に合わせて消す。
 *
 * 初期 JS graph に入る store（chat session の削除、project の削除）から呼ばれるため、
 * ここには削除・削除の記録・鍵の workspace hash だけを置く。保存・復元は lazy な Chat
 * パネルの chunk にある `chatInputDraftStorage.ts` が持つ。
 */
export const CHAT_INPUT_DRAFT_KEY_PREFIX = "gdx.chatDraft.v1|";

/**
 * workspace の path を鍵へそのまま残さないための短い hash（FNV-1a 32bit）。
 * 別の DB にも同じ projectId（例: "default-project"）があるので、鍵と削除の記録の両方で使う。
 */
export function hashChatInputDraftWorkspace(path: string | null): string {
  if (path === null) return "none";
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * 削除の記録 [workspace の hash, projectId, sessionId（null は project 全体）, 恒久か]。
 * 書込み側は bind した時点より後の記録と照合し、消した下書きを debounce や flush で書き戻さない。
 * 記録はこの renderer の memory だけにある（別ウィンドウとは共有しない）。
 */
export type ChatInputDraftPurge = readonly [
  string,
  string,
  string | null,
  boolean,
];
let purges: ChatInputDraftPurge[] = [];

export const getChatInputDraftPurges = (): readonly ChatInputDraftPurge[] =>
  purges;

/** test 専用。削除の記録を空にする（製品の build では参照されず tree-shake される）。 */
export function resetChatInputDraftPurgesForTests(): void {
  purges = [];
}

/**
 * `sessionId` を渡すとその session の下書きだけ、省くと project の全下書きを消す。
 * `permanent` は project 自体の削除（同じ workspace の同じ id へ二度と書かない）。
 * 履歴の全消去は false。
 */
export function purgeChatInputDrafts(
  workspacePath: string | null,
  projectId: string,
  sessionId: string | null = null,
  permanent = sessionId !== null,
): void {
  const workspace = hashChatInputDraftWorkspace(workspacePath);
  purges.push([workspace, projectId, sessionId, permanent]);
  const project = encodeURIComponent(projectId);
  const slot = sessionId === null ? null : "s:" + encodeURIComponent(sessionId);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      const parts = key?.split("|");
      if (
        key?.startsWith(CHAT_INPUT_DRAFT_KEY_PREFIX) &&
        parts?.[1] === workspace &&
        parts[2] === project &&
        (slot === null || parts[3] === slot)
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // storage が使えなくても削除の操作そのものは止めない。
  }
}
