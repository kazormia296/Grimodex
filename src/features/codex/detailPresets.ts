import type { CodexDetailDefinition } from "./detailApi";
import type { GenreValue } from "@/features/project/genreOptions";

export interface DetailFieldPreset {
  name: string;
  fieldType: "text" | "dropdown";
  /** dropdown のみ。fieldConfig JSON の options に展開される */
  options?: readonly string[];
  includeInContext: boolean;
}

export type DetailPresetsByType = Readonly<
  Record<string, readonly DetailFieldPreset[]>
>;

export const BASE_DETAIL_PRESETS: DetailPresetsByType = {};

export const GENRE_DETAIL_PRESETS: Readonly<
  Partial<Record<GenreValue, DetailPresetsByType>>
> = {};

export const PRESET_GENRES: readonly GenreValue[] = [];

export function resolvePresetFields(
  _typeSlug: string,
  _genre: string | null,
): DetailFieldPreset[] {
  throw new Error("not implemented");
}

export interface ApplyDetailPresetResult {
  added: CodexDetailDefinition[];
  skipped: number;
}

export async function applyDetailPreset(
  _projectId: string,
  _typeSlug: string,
  _genre: string | null,
): Promise<ApplyDetailPresetResult> {
  throw new Error("not implemented");
}
