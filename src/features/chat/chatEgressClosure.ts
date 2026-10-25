/**
 * 場面の会話でない会話の「編集して再送」の閉鎖（NIR-1 DA-2b の PUB-G 前の必須 1、
 * `docs/plans/nir1-lane-decisions/da2b-renderer-decisions.md` の DR-DA2B-R17〜R19）。
 *
 * 編集は対象の user 行と後続の行を typed な CW（`chat_messages_delete`）で消す。CW は
 * restricted でも成功するが、再送は capture の外では保存されない（K3/2 の
 * 「chat の書込みの入口」4）。そこで、capture の対象になりうる会話（場面の会話）でない
 * ときは、編集の瞬間に状態の command を boolean の閉鎖のためだけに読み、`unrestricted`
 * と読めたときだけ進める。定数（`PROFILE_ACTIVATION_UI_ENABLED`）には依らない。
 * renderer の閉鎖は防御に数えない（Main と Native は変えていない）。
 *
 * 起動時の graph：この module は lazy な ChatPanel の chunk からだけ import する。
 * 状態の wrapper（`@/lib/profileEgressStatus`）は動的 import にする（静的に import すると
 * 共有の chunk が分かれ、起動時の preload の表が増える。DR-DA2B-R6 の (B)）。
 * top level に呼出しを置かない。
 */
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";

/** 会話の種類の判定に要る store の欄（`ChatState` の一部）。 */
export interface ConversationKindState {
  readonly chatScope: string;
  readonly activeSceneId: string;
  readonly scopeAnchorId: string | null;
  readonly threadFocusOverride: unknown;
}

/**
 * capture（`captureRouteIsEligible`）の会話の側の条件と同じ述語。場面の scope で、
 * 場面が開いていて、anchor が無く、thread の focus でないときだけ真。route の側の条件
 * （provider、agent、RAG など）は会話の種類ではないので見ない（K3/2 の契約のとおり、
 * 場面の会話の編集は開いたまま）。
 */
export function isSceneConversation(state: ConversationKindState): boolean {
  return (
    state.chatScope === "scene" &&
    typeof state.activeSceneId === "string" &&
    state.activeSceneId.length > 0 &&
    state.scopeAnchorId === null &&
    state.threadFocusOverride === null
  );
}

/**
 * 状態の読取の結果（view、または投げられた値）から閉鎖を決める。`{ state:
 * "unrestricted" }` そのものだけが開。restricted、activating、unavailable、例外、
 * 未知の値はどれも閉（fail-closed）。
 */
export function isNonSceneEditClosed(outcome: unknown): boolean {
  if (
    outcome === null ||
    typeof outcome !== "object" ||
    Array.isArray(outcome)
  ) {
    return true;
  }
  const keys = Object.keys(outcome);
  return !(
    keys.length === 1 &&
    keys[0] === "state" &&
    (outcome as { state?: unknown }).state === "unrestricted"
  );
}

/**
 * restricted は process の中で戻らない（K3/2 の可用性。一方向）ので、それを読めたときだけ
 * 保持する。開と、restricted 以外の閉（例外、unavailable、activating、時間切れ）は
 * 保持しない。
 */
let restrictedObserved = false;

/**
 * 状態の読取の上限（ms）。Main は自分で答えるのでふつうは即座に戻るが、戻らないときに
 * 編集の入口が process の間ふさがらないよう、超えたら閉として扱う（DR-DA2B-R20）。
 */
export const NON_SCENE_EDIT_STATUS_TIMEOUT_MS = 5_000;

async function readClosureOnce(): Promise<boolean> {
  try {
    const { getProfileEgressStatus } =
      await import("@/lib/profileEgressStatus");
    const view = await getProfileEgressStatus();
    if (view.state === "restricted") restrictedObserved = true;
    return isNonSceneEditClosed(view);
  } catch (error) {
    return isNonSceneEditClosed(error);
  }
}

/**
 * 閉なら true。時間切れも閉。読取は `admitConversationEdit` の `editInFlight` が
 * 1 本に限るので、ここでは束ねない。
 */
export function readNonSceneEditClosed(): Promise<boolean> {
  if (restrictedObserved) return Promise.resolve(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), NON_SCENE_EDIT_STATUS_TIMEOUT_MS);
  });
  return Promise.race([readClosureOnce(), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** 閉のときの表示。理由の文言は Session C-1 の承認まで定数の後ろに置く（R5 の P3-7）。 */
export function notifyNonSceneEditClosed(): void {
  void (PROFILE_ACTIVATION_UI_ENABLED
    ? toast.info(i18next.t("profileEgress.chat.editClosed"))
    : toast.error(i18next.t("common.error")));
}

/** 編集の click の時点の対象（読取の間に変わっていないかを後で確かめる）。 */
export interface EditTargetSnapshot {
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly messageId: string;
  /** click の時点の一覧の最後の行（後ろに足された行を消さないため）。 */
  readonly lastMessageId: string | null;
  readonly sceneConversation: boolean;
}

/** 対象の確認に要る store の欄（`ChatState` の一部）。 */
export interface EditTargetState extends ConversationKindState {
  readonly activeProjectId: string | null;
  readonly activeSessionId: string | null;
  readonly isStreaming: boolean;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
  }>;
}

export function snapshotEditTarget(
  state: EditTargetState,
  messageId: string,
): EditTargetSnapshot {
  return {
    projectId: state.activeProjectId,
    sessionId: state.activeSessionId,
    messageId,
    lastMessageId: state.messages.at(-1)?.id ?? null,
    sceneConversation: isSceneConversation(state),
  };
}

/**
 * 読取の後も同じ workspace・会話・行で、stream が始まっておらず、一覧の最後の行が
 * click の時点と同じか（後ろに行が足されていたら、見えていなかった行まで消さない）。
 * chat の一覧は追記と削除しか起きないので、最後の行が同じで対象が残っていれば、入力欄の
 * 「最後の行の編集」の対象もまだ最後の user 行である（別の確認は要らない）。
 */
export function isEditTargetCurrent(
  snapshot: EditTargetSnapshot,
  state: EditTargetState,
): boolean {
  if (
    state.activeProjectId !== snapshot.projectId ||
    state.activeSessionId !== snapshot.sessionId ||
    state.isStreaming ||
    isSceneConversation(state) !== snapshot.sceneConversation ||
    (state.messages.at(-1)?.id ?? null) !== snapshot.lastMessageId
  ) {
    return false;
  }
  return state.messages.some((message) => message.id === snapshot.messageId);
}

/** 非場面の会話の編集が読取の途中か（連打は in-flight の 1 本にまとめる）。 */
let editInFlight = false;

/**
 * 編集の入口を通す。場面の会話では読まずに、同期で `proceed` を呼ぶ（今のまま）。
 * 場面の会話でないときは、状態を読み、開で、かつ `isCurrent()` が真のときだけ
 * `proceed` を呼ぶ。閉（時間切れを含む）なら `notifyNonSceneEditClosed` を出して何も
 * しない。読取の途中の 2 回目以降の要求は、1 回目が進行中なので通知せずに捨てる。
 * `isCurrent()` が偽（会話や workspace を移った、stream が始まった、行が変わった）の
 * ときも通知しない（利用者は既に別の操作に移っており、失敗の文は誤解を招く）。
 */
export async function admitConversationEdit(input: {
  readonly sceneConversation: boolean;
  readonly isCurrent: () => boolean;
  readonly proceed: () => void;
}): Promise<void> {
  if (input.sceneConversation) {
    input.proceed();
    return;
  }
  if (editInFlight) return;
  editInFlight = true;
  let closed: boolean;
  try {
    closed = await readNonSceneEditClosed();
  } finally {
    editInFlight = false;
  }
  if (closed) {
    notifyNonSceneEditClosed();
    return;
  }
  if (!input.isCurrent()) return;
  input.proceed();
}

/** 試験だけが使う。process の中の保持を戻す。 */
export function resetNonSceneEditClosureForTest(): void {
  restrictedObserved = false;
  editInFlight = false;
}
