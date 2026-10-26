/**
 * The disclosure of the NIR-1 local generation route as a structured list
 * (DD-1c, DR-DD1C-9; K5/3 "開示" :435-453). The items do not depend on the
 * display language; the wording of each item (Japanese and English drafts,
 * approved in Session C-2) is in `nir1LocalGenerationTranslations.ts`.
 *
 * The disclosure informs; it is not a confirmation. It asks for nothing,
 * records nothing and keeps no state (no "read" mark), and no send decision
 * reads it.
 */

/** 1 送るもの … 9 止め方と事後の確認 (K5/3 の項目 1〜9). */
export const NIR1_LOCAL_DISCLOSURE_ITEMS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type Nir1LocalDisclosureItem =
  (typeof NIR1_LOCAL_DISCLOSURE_ITEMS)[number];

/**
 * 1 AI 設定の OpenAI 互換の接続先の近く, 2 AI 使用ポリシーの設定, 3 生成の画面,
 * 5 restricted の利用者への要旨 (4 は PUB-L の承認資料とプライバシー通知で、画面の
 * 部品ではない).
 */
export type Nir1LocalDisclosurePlacement = 1 | 2 | 3 | 5;

export const NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS: Readonly<
  Record<Nir1LocalDisclosurePlacement, readonly Nir1LocalDisclosureItem[]>
> = {
  1: NIR1_LOCAL_DISCLOSURE_ITEMS,
  2: [3, 4, 9],
  // The short permanent line of the generation screen; every item is one
  // step away (`showAll`).
  3: [2, 3],
  // The summary of items 3, 4 and 6 (`summary` wording).
  5: [3, 4, 6],
};

/** Placement 5 shows each item's summary rather than its full text. */
export const NIR1_LOCAL_SUMMARY_ITEMS = [3, 4, 6] as const;

/** Whether the placement shows the route's destination and model. */
export const NIR1_LOCAL_PLACEMENT_SHOWS_ROUTE: Readonly<
  Record<Nir1LocalDisclosurePlacement, boolean>
> = { 1: true, 2: false, 3: true, 5: false };

/** Whether the placement offers the step to every item. */
export const NIR1_LOCAL_PLACEMENT_LINKS_ALL: Readonly<
  Record<Nir1LocalDisclosurePlacement, boolean>
> = { 1: false, 2: true, 3: true, 5: true };
