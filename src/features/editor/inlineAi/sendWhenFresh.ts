import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { useInlineAiStore } from "./inlineAiStore";

/**
 * 別のインライン AI が進行中（idle でない）なら、ツールバーの注意喚起（揺れ）を出して true を返す。
 * 呼び側は送らずに戻る。`generate` が従来出していた通知を、非同期の context を作る前に出すため。
 */
export function requestAttentionIfInlineAiBusy(): boolean {
  const state = useInlineAiStore.getState();
  if (state.status === "idle") return false;
  state.requestAttention();
  return true;
}

/** 取りやめ（送らなかった）ときの通知。作者に何も見えないままにしない。 */
export function requestInlineAiAttention(): void {
  useInlineAiStore.getState().requestAttention();
}

/** 送信を決めた時点の編集状態（文書・選択）。鮮度の比較に使う。 */
export interface EditorSendSnapshot {
  doc: ProseMirrorNode;
  from: number;
  to: number;
}

export function captureEditorSendSnapshot(editor: Editor): EditorSendSnapshot {
  const { from, to } = editor.state.selection;
  return { doc: editor.state.doc, from, to };
}

/** 文書と選択（from／to）が、控えた時点と同じか。 */
export function isEditorSendSnapshotCurrent(
  editor: Editor,
  snapshot: EditorSendSnapshot,
): boolean {
  const { from, to } = editor.state.selection;
  return (
    editor.state.doc.eq(snapshot.doc) &&
    from === snapshot.from &&
    to === snapshot.to
  );
}

export interface SendWhenFreshOptions<S, T> {
  /** 送信を決めた時点の状態を控える（同期）。`build` の直前に呼ぶ。 */
  capture: () => S;
  /** 控えた状態から context を作る（非同期。hidden 判定のために DB を引く）。 */
  build: (snapshot: S) => Promise<T>;
  /** 作り終えた時点でも、控えた状態が有効か（文書・選択・projection・書込み可否）。 */
  isFresh: (snapshot: S) => boolean;
  /**
   * 古くなったとき、今の状態で作り直して送ってよいか。別の文書（projection の key）に
   * 移った・書込み不可になった場合のように、作り直しても意味がないなら false。
   * 省略時は常に作り直す。
   */
  canRebuild?: (snapshot: S) => boolean;
  /** 送らずに取りやめたとき（作り直せない変化、作り直しても古い）に呼ぶ。 */
  onAbandon?: () => void;
  /** 有効な context を、その context を作った時点の snapshot とともに受けて送る。 */
  run: (context: T, snapshot: S) => void;
}

/**
 * 非同期で作った Inline AI の context を、送信時点でまだ有効なときだけ使う。
 *
 * `buildInlineAiContextForSend` は hidden 判定のために DB を引くので、呼び出しから
 * `generate` までの間にカーソル・選択・文書・projection・書込み可否が変わりうる。古い
 * context と今の選択（適用先）が食い違わないよう、古くなっていたら黙って捨てず、今の
 * 状態で context を 1 回だけ作り直して送る。作り直しても古い・作り直す意味が無いときだけ
 * 送らず debug に記録する。reject は未処理にせず記録する。
 */
export function sendWhenFresh<S, T>(options: SendWhenFreshOptions<S, T>): void {
  void (async () => {
    const first = options.capture();
    const firstContext = await options.build(first);
    if (options.isFresh(first)) {
      options.run(firstContext, first);
      return;
    }
    if (options.canRebuild && !options.canRebuild(first)) {
      debugLog.debug(
        "inline-ai",
        "インライン AI の送信を取りやめた（作り直せない変化）",
      );
      options.onAbandon?.();
      return;
    }
    const second = options.capture();
    const secondContext = await options.build(second);
    if (options.isFresh(second)) {
      options.run(secondContext, second);
      return;
    }
    debugLog.debug(
      "inline-ai",
      "インライン AI の送信を取りやめた（作り直しても状態が変わった）",
    );
    options.onAbandon?.();
  })().catch((error: unknown) => {
    debugLog.warn(
      "inline-ai",
      "インライン AI の context の作成または送信に失敗した",
      errorDetail(error),
    );
  });
}
