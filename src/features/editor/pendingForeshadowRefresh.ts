import type { Editor } from "@tiptap/core";
import { refreshForeshadowPayoffMarkVersions } from "@/features/foreshadow/saveAnchors";
import type { ForeshadowRow } from "@/features/foreshadow/types";
import { debugLog } from "@/lib/debugLog";

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

/**
 * compositionend の後、この時間 composition・打鍵の活動が無ければ idle の適用を行う
 * （EAR-19）。日本語の連続入力は compositionend の直後（数 ms〜数十 ms）に次の
 * compositionstart が来る。次の task（0 ms）で dispatch すると、次の変換が始まる直前に
 * doc を変える transaction が入りうるので、静止してから適用する。
 */
export const COMPOSITION_QUIET_MS = 250;

/**
 * composing が真のまま、この時間 composition・打鍵の活動が無ければ、変換は固着した
 * （compositionend を取りこぼした）と見なす（EAR-21）。ProseMirror は editable が偽の間
 * compositionstart／update／end を処理せず、desktop では composing の時間切れも無いので、
 * 変換中に外部置換などで read-only が挟まると `view.composing` が真のまま残りうる。
 */
export const COMPOSITION_STALE_MS = 10_000;

/** editor ごとの composition・打鍵の最終活動時刻（listener を付けた editor だけ）。 */
const lastCompositionActivityAt = new WeakMap<Editor, number>();
const staleCompositionWarned = new WeakSet<Editor>();

function markCompositionActivity(editor: Editor): void {
  lastCompositionActivityAt.set(editor, Date.now());
  staleCompositionWarned.delete(editor);
}

/**
 * 変換中（確定前）か。view が無い・破棄済みなら false。ProseMirror の `composing` が真でも、
 * 最終活動から `COMPOSITION_STALE_MS` 以上経っていれば固着と見なして false を返す
 * （T0 の適用・idle／blur の適用・peer の処理し直しのすべてがここを通る）。
 */
export function isEditorComposing(editor: Editor): boolean {
  if (editor.isDestroyed) return false;
  let composing: boolean;
  try {
    composing = editor.view.composing === true;
  } catch {
    // view 未 mount の間は composing ではない。
    return false;
  }
  if (!composing) return false;
  const lastAt = lastCompositionActivityAt.get(editor);
  if (lastAt !== undefined && Date.now() - lastAt >= COMPOSITION_STALE_MS) {
    if (!staleCompositionWarned.has(editor)) {
      staleCompositionWarned.add(editor);
      debugLog.warn(
        "PendingForeshadowRefresh",
        "composition looks stuck; treating it as ended",
        {
          sensitivity: "safe",
          fields: {
            operation: "composition-stale",
            idleMs: Date.now() - lastAt,
          },
        },
      );
    }
    return false;
  }
  return true;
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
 * flush（閉じる・切替・手動保存・外部の保存）の T0 の直前。変換中でも保存を延期しない：
 * editor の DOM を blur して browser に compositionend を出させ、それでも変換が
 * 続くなら composition を捨てて適用する。実 IME での挙動は未確認（起案 §3.3a-4）。
 *
 * flush は editor を閉じない呼び手（手動保存、agent の自動適用、rename、
 * post-effect など）も通る。blur で作者の focus を奪い、続きの打鍵が body に落ちる
 * のは本件で直す不具合と同じ症状なので、blur の前に focus を覚え、適用の後に
 * editor が生きていれば戻す（EAR-20）。変換が blur で確定されること自体は残る。
 */
export function applyPendingForeshadowRefreshForFlush(
  editor: Editor,
  run: (apply: () => void) => void,
): void {
  if (applyPendingForeshadowRefresh(editor, run)) return;
  let hadFocus = false;
  try {
    hadFocus = editor.view.hasFocus?.() === true;
    editor.view.dom.blur();
  } catch {
    // view が既に無ければ適用だけ行う。
  }
  applyPendingForeshadowRefresh(editor, run, { force: true });
  if (!hadFocus || editor.isDestroyed) return;
  try {
    if (!editor.view.hasFocus?.()) editor.view.focus();
  } catch {
    // focus を戻せなくても保存は続ける。
  }
}

/**
 * compositionend の後に静止（`COMPOSITION_QUIET_MS`）してから、と blur で `onIdle` を
 * 呼ぶ listener を editor の DOM に付ける。`onIdle` は変換が終わっていることを確かめた
 * 後にだけ呼ぶ。静止の間に compositionstart が来れば取り消し、打鍵（keydown）が来れば
 * 静止の数え直し。あわせて composition・打鍵の最終活動時刻を記録する（固着の判定用）。
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
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const fireIfIdle = () => {
    timer = null;
    if (editor.isDestroyed) return;
    if (isEditorComposing(editor)) {
      // compositionend の後も composing が真のまま、新しい compositionstart も来ない
      // （compositionend を取りこぼした固着）。固着と見なされる（EAR-21）まで見張り、
      // 解けたら onIdle を呼ぶ。peer の通知の処理し直しが次の blur まで取り残されない。
      // 新しい変換が始まれば compositionstart が timer を取り消す。
      arm();
      return;
    }
    onIdle();
  };
  const arm = () => {
    clear();
    timer = setTimeout(fireIfIdle, COMPOSITION_QUIET_MS);
  };
  const onCompositionStart = () => {
    markCompositionActivity(editor);
    clear();
  };
  const onCompositionUpdate = () => {
    markCompositionActivity(editor);
  };
  const onCompositionEnd = () => {
    markCompositionActivity(editor);
    arm();
  };
  const onTyping = () => {
    markCompositionActivity(editor);
    if (timer !== null) arm();
  };
  const onBlur = () => {
    if (editor.isDestroyed || isEditorComposing(editor)) return;
    onIdle();
  };
  const passive = { passive: true } as const;
  dom.addEventListener("compositionstart", onCompositionStart, passive);
  dom.addEventListener("compositionupdate", onCompositionUpdate, passive);
  dom.addEventListener("compositionend", onCompositionEnd, passive);
  dom.addEventListener("keydown", onTyping, passive);
  dom.addEventListener("beforeinput", onTyping, passive);
  dom.addEventListener("blur", onBlur);
  return () => {
    clear();
    dom.removeEventListener("compositionstart", onCompositionStart);
    dom.removeEventListener("compositionupdate", onCompositionUpdate);
    dom.removeEventListener("compositionend", onCompositionEnd);
    dom.removeEventListener("keydown", onTyping);
    dom.removeEventListener("beforeinput", onTyping);
    dom.removeEventListener("blur", onBlur);
  };
}
