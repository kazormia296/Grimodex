/** Existing Raw selector/fetch constants, shared by both fetch modes. */
export const RELATED_SCENES_MAX = 8;
export const RELATED_SCENES_FETCH_LIMIT = 30;
export const RELATED_SCENES_RELATIVE_GAP = 0.05;

/** L0 frozen Raw baseline: D = 0.20 B, in renderer milliseconds. */
export const RELATED_SCENES_IR_EXTRA_WAIT_MS = 10.840000000596048;

/**
 * K6/4 の批准 12（DR-WF-1）：`graph-ready` を契機にした取り直し（子）の合流にだけ
 * 渡す Graph の成分の窓 W_f（Raw-ready からの renderer の ms）。IR の deadline と、
 * 最初の表示やほかの契機の合流は D（上の定数）のまま。狭めるときは K6/4 の手順で
 * 凍結を取り直す。
 */
export const RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS = 100;
