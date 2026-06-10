/**
 * codex_relations の外部変更を「既に開いている Map」へ伝える軽量通知層。
 *
 * relation の state は MapCanvas のローカル useState と CodexTypedRelationsSection
 * のローカル state に二重管理されており、useCodexStore には無い。Codex パネルから
 * relation を作成/削除したとき、Map 側の derived relation overlay が stale になるのを
 * 防ぐためのチャネル。相関図 board 自体は snapshot なので自動更新しない。
 *
 * ブラウザ環境では `window` の CustomEvent を使い、非ブラウザ(テスト等)では no-op。
 */

const EVENT_NAME = "codex-relations-changed";

interface CodexRelationsChangedDetail {
  projectId: string;
}

export function notifyCodexRelationsChanged(projectId: string): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<CodexRelationsChangedDetail>(EVENT_NAME, {
      detail: { projectId },
    }),
  );
}

/** 指定 project の通知だけ cb を呼ぶ。戻り値で購読解除する。 */
export function subscribeCodexRelationsChanged(
  projectId: string,
  cb: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<CodexRelationsChangedDetail>).detail;
    if (detail?.projectId === projectId) cb();
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
