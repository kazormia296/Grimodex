/** 並べ替えの作業粒度。 */
export type ReorderGranularity = "sentence" | "bunsetsu" | "character";

/** 段落 flat テキスト上の 1 単位（半開区間 [from, to)）。 */
export interface ReorderUnit {
  from: number;
  to: number;
  /** 表示用プレーンテキスト（flat text の slice）。 */
  surface: string;
}

/** 段落 1 つ分の flatten 結果（codexDocFlatten 契約、ブロック境界 \\n なし）。 */
export interface ParagraphFlat {
  text: string;
  flatPmPos: number[];
  flatIsRuby: boolean[];
}

/** 段落内 range の旧 PM → 新 PM マッピング（Codex 装飾 remap 用）。 */
export interface RangeSegmentMap {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
}

/** CodexHighlightPlugin へ渡す段落内 permutation meta。 */
export interface CodexInlineReorderInfo {
  kind: "inlinePermutation";
  segments: RangeSegmentMap[];
}

/** Tauri `segment_bunsetsu` の 1 文節 DTO。 */
export interface BunsetsuDto {
  start: number;
  end: number;
  surface: string;
}
