import type { createProject } from "./api";

interface ProjectRowSource {
  title: string;
  genre?: string;
  language?: string;
  pov?: string;
  tense?: string;
  /** SDEF/1 R12: create new scenes in the main line (creation screen only). */
  sceneScopeMainLine?: boolean;
}

/** The new project's row, from the creation input (blank fields are omitted). */
export function projectRowInput(
  input: ProjectRowSource,
): Parameters<typeof createProject>[0] {
  return {
    id: crypto.randomUUID(),
    title: input.title.trim(),
    genre: input.genre || undefined,
    language: input.language || undefined,
    pov: input.pov || undefined,
    tense: input.tense || undefined,
  };
}

/**
 * SDEF/1 R12 (DR-SDEF-28): only the creation screen's main-line check adds
 * the `sceneScopeDefault` option. Every other caller (imports, the evaluation
 * harness) gets no option, so the project has no Scene Scope default.
 */
export function projectCreateOptions(
  input: Pick<ProjectRowSource, "sceneScopeMainLine">,
): { sceneScopeDefault: "main-line" } | undefined {
  return input.sceneScopeMainLine === true
    ? { sceneScopeDefault: "main-line" }
    : undefined;
}
