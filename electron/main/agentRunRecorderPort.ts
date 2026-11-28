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
  /** 台帳の行の executionId（Native が台帳から引く）。 */
  readonly executionId: string;
  /** Native の読み戻しでは interactionVersion。 */
  readonly version: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly targetBasis: readonly AnalysisReadBasisEntryV1[] | null;
}

/** 台帳の鍵。provider の toolCallId は応答をまたぐと重なる（Hermes の連番、ID なし）。 */
export interface AgentRunToolCallKey {
  readonly executionId: string;
  readonly toolCallId: string;
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
      /** (executionId, toolCallId) は台帳にある最後の toolCallId の行であること。 */
      readonly executionId: string;
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
  /**
   * 応答 1 つ分を 1 つの tx で書く。呼ぶのは記録の経路の持ち主だけ（A2 は呼ばない）。
   * 鍵（executionId, toolCallId）の重複と、空の toolCallId は全体を拒む。
   */
  appendToolCalls(
    runId: string,
    entries: readonly AgentRunLedgerEntry[],
  ): Promise<void>;
  /** provenance と実行結果は 1 度だけ書ける。capability は前へ進む。 */
  updateToolCall(
    runId: string,
    call: AgentRunToolCallKey,
    update: {
      readonly mainOwnedProvenanceId?: string;
      readonly capabilityState?: AgentRunCapabilityState;
      readonly executionState?: Exclude<AgentRunExecutionState, "pending">;
    },
  ): Promise<void>;
}

/**
 * Gate A が capability の record（executionId）から Run を引く口。
 * executionId と Run の対応は、台帳を追記するときに記録の持ち主が作る。
 */
export type AgentRunResolution =
  | {
      readonly kind: "recorded";
      readonly runId: string;
      /**
       * 今の version を op に渡し、返った version を持つ。Run ごとに直列。
       * op は Native の呼出し 1 回にし、中で承認を待たない。再入しない。
       * op が失敗したら version を進めない。終端や workspace の切替の後は拒む。
       */
      transact<T extends AgentRunState>(
        op: (version: number) => Promise<T>,
      ): Promise<T>;
    }
  /** 旗が閉じている、または記録しない経路。 */
  | { readonly kind: "not_recording" }
  /** 記録するはずの応答に記録が無い（失敗、束縛の不一致を含む）。 */
  | { readonly kind: "unrecorded" };

export interface AgentRunResolver {
  resolveRun(input: {
    readonly senderId: number;
    readonly projectId: string;
    readonly executionId: string;
  }): AgentRunResolution;
}
