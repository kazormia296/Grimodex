import type {
  BuildSystemPromptInput,
  LayerBreakdown,
  ProjectContext,
  SceneContext,
} from "../contextBuilder";
import type { CodexContextEntry } from "@/features/codex/api";
import type { SceneTurnContextRequest } from "./turnContextRequest";
import type { LegacyPromptResult } from "./legacyPromptAdapter";

export interface RecalledMessageForPromotion {
  messageId: string;
  text: string;
}

export interface ContextDiagnostic {
  source: string;
  severity: "warning" | "fatal";
  code: string;
  message: string;
  latencyMs?: number;
  cause?: unknown;
}

export interface RequiredSceneContext {
  scene: SceneContext;
  project: ProjectContext | null;
  promptInput: BuildSystemPromptInput;
  detectedEntries: CodexContextEntry[];
  alwaysEntries: CodexContextEntry[];
  stableCodexIds: string[];
  projectOutline: string | undefined;
  chapterOutlines: Array<{ title: string; outline: string }>;
  recalledMessages: RecalledMessageForPromotion[];
  diagnostics: ContextDiagnostic[];
}

export type OptionalSceneContext = Partial<BuildSystemPromptInput>;

export interface ContextPlannerDeps {
  ensureTokenizer: () => Promise<void>;
  collectRequiredSceneContext: (
    request: SceneTurnContextRequest,
  ) => Promise<RequiredSceneContext>;
  collectOptionalSceneContext: (
    request: SceneTurnContextRequest,
    required: RequiredSceneContext,
  ) => Promise<OptionalSceneContext>;
  renderPrompt: (input: BuildSystemPromptInput) => LegacyPromptResult;
}

function missingRequiredSource(): Promise<RequiredSceneContext> {
  return Promise.reject(new Error("required scene source is not configured"));
}

/** Test/composition helper with safe defaults for optional dependencies. */
export function createContextPlannerDeps(
  overrides: Partial<ContextPlannerDeps>,
): ContextPlannerDeps {
  return {
    ensureTokenizer: async () => {},
    collectRequiredSceneContext: missingRequiredSource,
    collectOptionalSceneContext: async () => ({}),
    renderPrompt: () => ({
      prompt: "",
      totalTokens: 0,
      layers: [] as LayerBreakdown[],
    }),
    ...overrides,
  };
}
