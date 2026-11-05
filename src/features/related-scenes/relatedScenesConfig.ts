/** Existing Raw selector/fetch constants, shared by both fetch modes. */
export const RELATED_SCENES_MAX = 8;
export const RELATED_SCENES_FETCH_LIMIT = 30;
export const RELATED_SCENES_RELATIVE_GAP = 0.05;

/**
 * D：Raw-ready の後に IR（と最初の表示の Graph）を待つ時間（renderer の ms）。
 * L0 の D = 0.20 B（B=54.2 ms の fixture）＝ 10.84 ms は、実際の作品では IR が窓の
 * すぐ外に届き、多くが時間切れになった（PD 評価、日本語 117 Scene で到着の p99 24.8 ms・
 * 最大 25.5 ms、Raw の p90 約 204 ms）。DR-IRW-1〜3 で 40 ms に広げた（ユーザー承認
 * 2026-11-05）。IR が先に届けばその時点で返すので、待ちが常に 40 ms 延びるわけではない。
 */
export const RELATED_SCENES_IR_EXTRA_WAIT_MS = 40;

/**
 * K6/4 の批准 12（DR-WF-1）：`graph-ready` を契機にした取り直し（子）の合流にだけ
 * 渡す Graph の成分の窓 W_f（Raw-ready からの renderer の ms）。IR の deadline と、
 * 最初の表示やほかの契機の合流は D（上の定数）のまま。狭めるときは K6/4 の手順で
 * 凍結を取り直す。
 */
export const RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS = 100;
