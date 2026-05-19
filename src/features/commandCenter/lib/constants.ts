/**
 * バーのポップオーバーに表示する 1 section あたりの最大件数。
 * パネルが開いていて store に 50 件あっても、バーは常にこの数まで sliced で表示する。
 */
export const BAR_VISIBLE_LIMIT_PER_SECTION = 10;

/**
 * 専用ビュー (Dockview パネル) がマウントされている時の provider.search の limit。
 */
export const PANEL_FETCH_LIMIT = 50;

/**
 * パネルが閉じている時のデフォルト limit。バー単独で必要な件数。
 */
export const BAR_FETCH_LIMIT = BAR_VISIBLE_LIMIT_PER_SECTION;
