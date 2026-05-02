export type PromptLang = "ja" | "en" | "zh" | "ko";

export interface L1TrimMarkers {
  removablePatterns: RegExp[];
}

export interface L3TrimMarkers {
  bodyHeaderRegex: RegExp;
}
