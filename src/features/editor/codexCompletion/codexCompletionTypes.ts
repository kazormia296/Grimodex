export interface CodexCompletionSourceEntry {
  id: string;
  name: string;
  type: string;
  aliases?: string[] | string | null;
  excludedAliases?: string[] | string | null;
}

export interface CodexCompletionCandidate {
  entryId: string;
  surface: string;
  canonicalName: string;
  source: "name" | "alias";
  type: string;
  normalizedSurface: string;
}

export interface CodexCompletionMatch {
  candidate: CodexCompletionCandidate;
  prefix: string;
  suffix: string;
  from: number;
  to: number;
}
