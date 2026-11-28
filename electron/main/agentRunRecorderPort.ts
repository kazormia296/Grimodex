import type {
  AgentRunCapabilityState,
  AgentRunExecutionState,
  AgentRunStatus,
  AnalysisReadBasisEntryV1,
  ApprovalResolution,
} from "../shared/agentRunTypes.js";

/** 状態を変える操作の戻り値。次の操作の expectedVersion に使う。 */
export interface AgentRunState {
  readonly runId: string;
  readonly version: number;
  readonly status: AgentRunStatus;
}

export interface AgentRunLedgerEntry {
  readonly toolCallId: string;
  readonly name: string;
  readonly canonicalArgs: unknown;
  readonly argsDigest: string;
  readonly executionId: string;
  readonly chatMessageId: string;
  /** 未発行の行は空文字。発行のときに updateToolCall で書き足す。 */
  readonly mainOwnedProvenanceId: string;
  readonly model: string;
  readonly capabilityState: AgentRunCapabilityState;
  readonly executionState: AgentRunExecutionState;
}

export interface PendingApproval {
  readonly interactionId: string;
  /** Native の読み戻しでは interactionVersion。 */
  readonly version: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly targetBasis: readonly AnalysisReadBasisEntryV1[] | null;
}

interface RunCas {
  readonly runId: string;
  readonly expectedVersion: number;
}

interface InteractionCas extends RunCas {
  readonly interactionId: string;
  readonly interactionVersion: number;
}

/** Gate A の A2 が呼ぶ main 専用の操作（DR-A3-15、DR-A3-17）。owner は Native が保持する。 */
export interface AgentRunApprovalPort {
  /** running → waiting_approval。新しい Interaction の version は 0。 */
  openApproval(
    input: RunCas & {
      readonly interactionId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argsDigest: string;
      /** 表示用の要約。UTF-8 で 64 KiB まで。 */
      readonly request: string;
      /** 新しく作る対象は null。版を指定する場合は 1〜64 件。 */
      readonly targetBasis: readonly AnalysisReadBasisEntryV1[] | null;
    },
  ): Promise<AgentRunState & { readonly interactionVersion: number }>;
  /** pending → resolved、waiting_approval → running。Native の版引数は runVersion。 */
  decideApproval(
    input: InteractionCas & { readonly decision: ApprovalResolution },
  ): Promise<AgentRunState>;
  /** 確かめ直しに通らないとき。Native の引数は runVersion と invalidation。 */
  invalidateApproval(
    input: InteractionCas & { readonly outcome: "superseded" | "expired" },
  ): Promise<AgentRunState>;
  /** 30 分で中断し pending を保持する。Native の理由は approval_timeout。 */
  interruptForApprovalTimeout(input: RunCas): Promise<AgentRunState>;
  /** claim の前でも読める。 */
  getPendingApproval(runId: string): Promise<PendingApproval | null>;
  /** main が応答を受けた時点で書く。toolCallId の重複は拒む。 */
  appendToolCall(runId: string, entry: AgentRunLedgerEntry): Promise<void>;
  /** provenance と実行結果は 1 度だけ書ける。capability は前へ進む。 */
  updateToolCall(
    runId: string,
    toolCallId: string,
    update: {
      readonly mainOwnedProvenanceId?: string;
      readonly capabilityState?: AgentRunCapabilityState;
      readonly executionState?: Exclude<AgentRunExecutionState, "pending">;
    },
  ): Promise<void>;
}
