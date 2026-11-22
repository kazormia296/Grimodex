import type { Editor } from "@tiptap/core";
import { refreshForeshadowPayoffMarkVersions } from "@/features/foreshadow/saveAnchors";
import type { ForeshadowRow } from "@/features/foreshadow/types";

/**
 * 伏線 mark の楽観ロック token（`baseVersion` 属性）の更新を、日本語の変換中は
 * 「遅らせて必ず適用する」ための editor ごとの pending（EAR-7、起案 §3.3a）。
 *
 * 自分の autosave は editor を read-only にしないので、保存の応答が返った時点で
 * 作者が変換中のことがある。変換中の transaction の dispatch は入力を乱すおそれが
 * あるため遅らせるが、捨ててはいけない：mark の `baseVersion` は次回保存の OCC token
 * そのもので、更新を失うと追従保存が古い token を送って FORESHADOW_VERSION_MISMATCH で
 * tx ごと失敗し続ける。適用点は (1) compositionend の次の task、(2) blur、
 * (3) 次の保存の T0 の直前（呼び手）の 3 つ。T0 で適用できない（変換が続いている）
 * 背景の保存は延期し、flush は composition を確定させてから適用する。
 */
const pendingByEditor = new WeakMap<Editor, Map<string, ForeshadowRow>>();

/** 変換中（確定前）か。view が無い・破棄済みなら false。 */
export function isEditorComposing(editor: Editor): boolean {
  if (editor.isDestroyed) return false;
  try {
    return editor.view.composing === true;
  } catch {
    // view 未 mount の間は composing ではない。
    return false;
  }
}

/** 保存結果の rows を pending に積む。同じ foreshadowId は新しい version で上書きする。 */
export function deferForeshadowRefresh(
  editor: Editor,
  rows: readonly ForeshadowRow[],
): void {
  if (rows.length === 0) return;
  let pending = pendingByEditor.get(editor);
  if (!pending) {
    pending = new Map();
    pendingByEditor.set(editor, pending);
  }
  for (const row of rows) {
    const existing = pending.get(row.id);
    // version が戻る更新で OCC token を巻き戻さない。
    if (existing && existing.version > row.version) continue;
    pending.set(row.id, row);
  }
}

export function hasPendingForeshadowRefresh(editor: Editor): boolean {
  return (pendingByEditor.get(editor)?.size ?? 0) > 0;
}

/** editor が破棄された・doc が再ロードで置き換わったとき。古い token で巻き戻さない。 */
export function discardPendingForeshadowRefresh(editor: Editor): void {
  pendingByEditor.delete(editor);
}

/** mark の `baseVersion` を rows の version に更新する transaction を 1 回 dispatch する。 */
export function dispatchForeshadowRefresh(
  editor: Editor,
  rows: readonly ForeshadowRow[],
): void {
  if (editor.isDestroyed || rows.length === 0) return;
  refreshForeshadowPayoffMarkVersions((apply) => {
    const tr = editor.state.tr;
    apply(tr);
    if (tr.steps.length > 0) editor.view.dispatch(tr);
  }, rows);
}

/**
 * pending を適用する。変換中（`force` でない限り）は何もせず false を返す。
 * 適用は呼び手の `run`（programmatic の囲み。dirty を立てない）の中で行う。
 * pending が無ければ true（適用すべきものが無い）。
 */
export function applyPendingForeshadowRefresh(
  editor: Editor,
  run: (apply: () => void) => void,
  options: { force?: boolean } = {},
): boolean {
  const pending = pendingByEditor.get(editor);
  if (!pending || pending.size === 0) return true;
  if (!options.force && isEditorComposing(editor)) return false;
  const rows = [...pending.values()];
  pendingByEditor.delete(editor);
  run(() => dispatchForeshadowRefresh(editor, rows));
  return true;
}

/**
 * flush（閉じる・切替・手動保存）の T0 の直前。変換中でも保存を延期しない：
 * editor の DOM を blur して browser に compositionend を出させ、それでも変換が
 * 続くなら（この後 editor は破棄される）composition を捨てて適用する。
 * 実 IME での挙動は未確認（起案 §3.3a-4）。
 */
export function applyPendingForeshadowRefreshForFlush(
  editor: Editor,
  run: (apply: () => void) => void,
): void {
  if (applyPendingForeshadowRefresh(editor, run)) return;
  try {
    editor.view.dom.blur();
  } catch {
    // view が既に無ければ適用だけ行う。
  }
  applyPendingForeshadowRefresh(editor, run, { force: true });
}

/**
 * compositionend の次の task と blur で `onIdle` を呼ぶ listener を editor の DOM に付ける。
 * `onIdle` は変換が終わっていることを確かめた後にだけ呼ぶ（同じ stack の dispatch が
 * ProseMirror の確定処理と競合しうるため、compositionend は 1 task 遅らせる）。
 * 戻り値は解除関数。
 */
export function installCompositionIdleListener(
  editor: Editor,
  onIdle: () => void,
): () => void {
  if (editor.isDestroyed) return () => undefined;
  let dom: HTMLElement;
  try {
    dom = editor.view.dom as HTMLElement;
  } catch {
    return () => undefined;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fireIfIdle = () => {
    timer = null;
    if (editor.isDestroyed || isEditorComposing(editor)) return;
    onIdle();
  };
  const onCompositionEnd = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fireIfIdle, 0);
  };
  const onBlur = () => {
    if (editor.isDestroyed || isEditorComposing(editor)) return;
    onIdle();
  };
  dom.addEventListener("compositionend", onCompositionEnd);
  dom.addEventListener("blur", onBlur);
  return () => {
    if (timer !== null) clearTimeout(timer);
    dom.removeEventListener("compositionend", onCompositionEnd);
    dom.removeEventListener("blur", onBlur);
  };
}
