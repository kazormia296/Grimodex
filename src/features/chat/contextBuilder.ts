// Stub — to be implemented in Phase 3

export interface SceneContext {
  id: string;
  title: string;
  content: string;
}

export interface ProjectContext {
  title: string;
  description: string;
}

export interface BuildSystemPromptInput {
  scene: SceneContext;
  project?: ProjectContext;
}

export function buildSystemPrompt(_input: BuildSystemPromptInput): string {
  throw new Error("Not implemented");
}

export function countTokens(_text: string): number {
  throw new Error("Not implemented");
}
