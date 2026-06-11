/**
 * projects.genre に保存されるジャンル値の正本。
 * CreateProjectDialog / ProjectCategory のセレクトと
 * codex の detailPresets のキーはここに揃える。
 */
export const GENRE_VALUES = [
  "Fantasy",
  "Sci-Fi",
  "Mystery",
  "Horror",
  "Romance",
  "Thriller",
  "Literary",
  "Historical",
  "Other",
] as const;

export type GenreValue = (typeof GENRE_VALUES)[number];
