import type { PanelId } from "./panelIds";

/**
 * パネルの chunk の先読み。初回表示のもたつきの主因は、chunk の parse と評価が
 * 開いた瞬間に main thread を塞ぐこと（パッケージ版の読み込み自体は app:// の
 * ローカル読みで速い）。開く前に済ませておく。
 *
 * 先読みの実体は panelComponents.tsx が登録する（テストで panelComponents を
 * mock しても、ここは何も登録されないだけで動く）。
 */
interface PanelPreloader {
  preload: () => Promise<void>;
  isLoaded: () => boolean;
}

const preloaders = new Map<PanelId, PanelPreloader>();

export function registerPanelPreloaders(
  entries: Partial<Record<PanelId, PanelPreloader>>,
): void {
  for (const [id, preloader] of Object.entries(entries) as Array<
    [PanelId, PanelPreloader | undefined]
  >) {
    if (preloader) preloaders.set(id, preloader);
  }
}

/** 読み込み済み・eager・未登録のパネルでは何もしない。 */
export function preloadPanel(id: PanelId): Promise<void> {
  return preloaders.get(id)?.preload() ?? Promise.resolve();
}

export function isPanelLoaded(id: PanelId): boolean {
  return preloaders.get(id)?.isLoaded() ?? true;
}

/** 起動の直後は先読みしない（起動とプロジェクトを開く処理を邪魔しない）。 */
const IDLE_PRELOAD_START_DELAY_MS = 5_000;
/** 最後の入力からこの間は先読みしない（入力中の打鍵を塞がない）。 */
const IDLE_PRELOAD_INPUT_QUIET_MS = 1_500;
/** idle の残り時間がこれ未満なら次の idle を待つ。 */
const IDLE_PRELOAD_MIN_REMAINING_MS = 30;

/**
 * レイアウトに置かれているパネルを、手が止まっている idle の間に 1 つずつ先読み
 * する。1 回の idle では 1 つだけ評価し、評価が終わってから次を待つ。失敗した
 * パネルは 1 回の起動で 1 度だけ試す（初回の render でまた読む）。返り値で止める。
 * requestIdleCallback の無い環境では何もしない。
 */
export function startPanelIdlePreload(
  getPanelIds: () => readonly PanelId[],
): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.requestIdleCallback !== "function"
  ) {
    return () => {};
  }
  let stopped = false;
  let idleHandle: number | null = null;
  let lastInputAt = performance.now();
  const attempted = new Set<PanelId>();
  const onInput = () => {
    lastInputAt = performance.now();
  };
  const inputEvents = ["pointerdown", "keydown", "wheel"] as const;
  for (const type of inputEvents) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    if (idleHandle !== null) window.cancelIdleCallback(idleHandle);
    for (const type of inputEvents) {
      window.removeEventListener(type, onInput, { capture: true });
    }
  };

  const next = () => {
    if (stopped) return;
    idleHandle = window.requestIdleCallback((deadline) => {
      idleHandle = null;
      if (stopped) return;
      const quiet =
        performance.now() - lastInputAt >= IDLE_PRELOAD_INPUT_QUIET_MS;
      if (!quiet || deadline.timeRemaining() < IDLE_PRELOAD_MIN_REMAINING_MS) {
        next();
        return;
      }
      const id = getPanelIds().find(
        (panel) => !attempted.has(panel) && !isPanelLoaded(panel),
      );
      if (!id) {
        stop();
        return;
      }
      attempted.add(id);
      void preloadPanel(id).then(next);
    });
  };

  const timer = window.setTimeout(next, IDLE_PRELOAD_START_DELAY_MS);
  return stop;
}
