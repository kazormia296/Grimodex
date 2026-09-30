declare module "*.mjs" {
  interface Nir1RunnerBudget {
    readonly contextWindowTokens: number;
    readonly systemTokens: number;
    readonly historyTokens: number;
    readonly toolTokens: number;
    readonly responseReservationTokens: number;
  }

  interface Nir1RunnerBinding {
    readonly scopeToken: string;
    readonly sourceToken: string;
    readonly revisionId: string;
    readonly decisionId: string;
    readonly freshnessToken: string;
    readonly indexGeneration: string;
  }

  interface Nir1RunnerItem {
    readonly id: string;
    readonly kind: string;
    readonly text: string;
    readonly tokens: number;
    readonly atomicGroup?: string;
    readonly atomicPart?: string;
    readonly stability?: string;
    readonly qualificationProof?: object;
  }

  interface Nir1RunnerCase {
    readonly caseId: string;
    readonly qualificationRef: string;
    readonly input: Array<Record<string, unknown>>;
    readonly expected: {
      readonly requiredIds?: readonly string[];
      readonly selectedIds: readonly string[];
      readonly prohibitedIds: readonly string[];
      readonly rejectedGroups?: readonly string[];
      readonly proseOrder?: readonly string[];
      readonly baseline?: {
        readonly selectedIds: readonly string[];
        readonly proseOrder?: readonly string[];
        readonly usedTokens?: number;
      };
      readonly improvement?: {
        readonly provenance: string;
        readonly baseline: number;
        readonly candidate: number;
        readonly groupIds?: readonly string[];
      };
    };
    readonly cacheBinding?: Nir1RunnerBinding;
  }

  interface Nir1RunnerManifest {
    readonly execution: {
      readonly seed: string;
      readonly liveModelCalls: number;
      readonly budget: Nir1RunnerBudget;
      readonly predeclaredImprovement: {
        readonly slot: string;
        readonly baseline: number;
        readonly candidateTarget: number;
      };
      readonly qualificationOutputs?: Readonly<
        Record<string, Record<string, unknown>>
      >;
    };
    readonly cases: Array<Nir1RunnerCase>;
  }

  interface Nir1RunnerState {
    readonly seed: string;
    readonly liveModelCalls: number;
    readonly budget: Nir1RunnerBudget;
    readonly predeclaredImprovement?: {
      readonly slot: string;
      readonly baseline: number;
      readonly candidateTarget: number;
    };
  }

  interface Nir1RunnerArmOutput {
    readonly liveModelCalls?: number;
    readonly selectedItems?: readonly Nir1RunnerItem[];
    readonly selectedIds: readonly string[];
    readonly selectedText: readonly string[];
    readonly proseText: readonly string[];
    readonly proseOrder: readonly string[];
    readonly usedTokens: number;
    readonly exactUsedTokens: number;
    readonly contextBudgetTokens: number;
    readonly exactContextBudgetTokens: number;
    readonly improvementCounters?: {
      readonly baseline: number;
      readonly candidate: number;
    };
  }

  interface Nir1RunnerEvaluationResult {
    readonly liveModelCalls: number;
    readonly baseline: Nir1RunnerArmOutput;
    readonly candidate: Nir1RunnerArmOutput;
  }

  interface Nir1RunnerScoreCase {
    readonly caseId: string;
    readonly status: "passed" | "failed";
    readonly failures: readonly string[];
    readonly improvementStatus: string;
  }

  interface Nir1RunnerScore {
    readonly status: "passed" | "failed";
    readonly failures: readonly string[];
    readonly cases: readonly Nir1RunnerScoreCase[];
  }

  export function runNir1PackingEvaluation(
    manifest: Nir1RunnerManifest,
    arms: {
      readonly baseline: (
        testCase: Nir1RunnerCase,
        runState: Nir1RunnerState,
        index: number,
      ) => Nir1RunnerArmOutput;
      readonly candidate: (
        testCase: Nir1RunnerCase,
        runState: Nir1RunnerState,
        index: number,
      ) => Nir1RunnerArmOutput;
    },
  ): {
    readonly results: Array<{
      readonly caseId: string;
      readonly result: Nir1RunnerEvaluationResult;
    }>;
    readonly score: Nir1RunnerScore;
  };

  export function runNir1CacheBindingMutations(
    manifest: Nir1RunnerManifest,
    isCurrent: (
      cached: Nir1RunnerBinding,
      current: Nir1RunnerBinding,
    ) => boolean,
    replan: (input: {
      readonly testCase: Nir1RunnerCase;
      readonly runState: Nir1RunnerState;
      readonly mutationKey: string;
      readonly cachedBinding: Nir1RunnerBinding;
      readonly currentBinding: Nir1RunnerBinding;
    }) => {
      readonly cachedPlan: object;
      readonly plan: object;
      readonly reused: boolean;
      readonly staleMaterialPresent: boolean;
      readonly validMaterialRetained: boolean;
      readonly usedTokens: number;
    },
  ): Array<{
    readonly caseId: string;
    readonly key: string;
    readonly current: boolean;
    readonly reused: boolean;
    readonly staleMaterialPresent: boolean;
    readonly validMaterialRetained: boolean;
    readonly usedTokens: number;
  }>;
}
