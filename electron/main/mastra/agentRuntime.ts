/**
 * Mastra の Agent で 1 turn を回す runtime（Mastra 移行 MP-3c。docs/plans/mastra-mp3-decisions.md の DR-MP3-13、14、16、17）。
 *
 * - `@mastra/*` を import してよい main 側の唯一の module（3 つ目の bundle `dist-electron/mastra-agent.cjs` の entry）。
 *   main.cjs と preload.cjs には入れない（electron/scripts/mastra-ee-check.mjs の `--dist` が検査する）。
 *   main 側からは型の import だけで、実体は `electron/main/mastraAgentLoader.ts` が `require(変数)` で遅延 load する
 *   （旗 L が開いているときだけ）。
 * - この bundle に入れるのは Agent・adapter（`agentLanguageModel`）・方針（`agentModelPolicy`）だけ。audit の sink と Native への
 *   send は main 側（`mastraTurnOwner.ts`）が作って注入する（ipcContract を 3 つ目の bundle に持ち込まない）。
 *   class を境界越しに `instanceof` で見ない（sink は `isAgentModelError` の形の検査）。
 * - Agent に workspace・skills・memory・mcp・browser を渡さない（DR-MP3-14。静的検査は
 *   electron/main/mastra/mastraWorkspaceDisabled.static.test.ts）。tool も渡さない（MP-3 は tool 0）。
 * - 再試行しない（`AGENT_NO_RETRY_CONFIG`・`AGENT_CALL_OPTIONS`。GDX-POLICY-001、DR-MP3-16）。step は 1 回（`maxSteps: 1`）：
 *   tool 0 なので、model が tool_use を返しても 2 回目の送信は起きない。
 * - Mastra の logger は注入する（既定の ConsoleLogger は error を元ごと console に出す）。出すのは固定の文だけ。
 */
import { Agent } from "@mastra/core/agent";

import {
  type AgentObserveResponse,
  type AgentPrepareSend,
  createAgentLanguageModel,
  grimodexProviderOptions,
} from "./agentLanguageModel.js";
import {
  AGENT_CALL_OPTIONS,
  AGENT_NO_RETRY_CONFIG,
} from "./agentModelPolicy.js";
import type { AgentAuditSink, AgentRoute, AgentSend } from "./agentWire.js";

/**
 * 実行時の tool 名の許可リスト（DR-MP3-14 の 2 層目）。MP-3 は tool 0 なので空。
 * 足すのは tool を渡す lane（MP-4 以降）が、この定数と試験を意図して改訂するとき。
 */
export const MASTRA_AGENT_TOOL_ALLOWLIST: readonly string[] = Object.freeze(
  [] as string[],
);

/** Agent が持つ tool 名が許可リストに収まらないとき投げる。名前だけを載せる。 */
export class MastraAgentToolNotAllowedError extends Error {
  readonly toolNames: readonly string[];
  constructor(toolNames: readonly string[]) {
    super(
      `mastra agent has tools outside the allow-list: ${toolNames.join(", ")}`,
    );
    this.name = "MastraAgentToolNotAllowedError";
    this.toolNames = toolNames;
  }
}

/** `names` が `allowed` に収まることを確かめる。収まらなければ投げる。 */
export function assertAgentToolsAllowed(
  names: readonly string[],
  allowed: readonly string[] = MASTRA_AGENT_TOOL_ALLOWLIST,
): void {
  const outside = names.filter((name) => !allowed.includes(name));
  if (outside.length > 0) throw new MastraAgentToolNotAllowedError(outside);
}

/** 1 turn の入力。`messages` は user／assistant の text だけ（system は `instructions`）。 */
export interface MastraAgentTurnInput {
  /** 先頭の system の text。 */
  readonly instructions: string;
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
  }[];
  /** renderer が解決した route（`AgentRoute` と同形）。 */
  readonly route: AgentRoute;
  readonly systemCacheSegments: readonly string[] | null;
  readonly systemVolatileTail: string | null;
  /** Native への送信（main の閉包。identity と閉状態の検査を含む）。 */
  readonly send: AgentSend;
  /** audit の書き手（main の sink。turn ごとの包みを含む）。 */
  readonly audit: AgentAuditSink;
  /** audit.begin の前に各 send の request を同期的に確定する。 */
  readonly prepareSend?: AgentPrepareSend;
  /** audit.complete 後、Mastra に応答を返す前に同期的に観測する。 */
  readonly observeResponse?: AgentObserveResponse;
  /** forced の切り離し（restricted、workspace 切替、quit、sender 消失）で abort する。 */
  readonly signal: AbortSignal;
}

/** Mastra の logger に渡す先。`message` は固定の文で、error の中身は含めない。 */
export type MastraAgentLogSink = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
) => void;

export interface MastraAgentRuntimeOptions {
  readonly log?: MastraAgentLogSink;
}

export interface MastraAgentRuntime {
  /**
   * 1 turn を回す。tool 0・memory 無しの Agent を作り、adapter の model で `generate` を 1 回（step 1）呼ぶ。
   * 応答の本体は呼び手が audit の complete で受ける（生の `AgentWireResponse`。Mastra の text は使わない）。
   */
  runTurn(input: MastraAgentTurnInput): Promise<void>;
}

/** `require` した module の形（loader が検査する）。 */
export interface MastraAgentRuntimeModule {
  createMastraAgentRuntime(
    options?: MastraAgentRuntimeOptions,
  ): MastraAgentRuntime;
}

type MastraLogger = Parameters<Agent["__setLogger"]>[0];

/**
 * 注入する logger。Mastra が出す error・警告の引数（元の error、request の中身）は捨て、level と先頭の文字列
 * （Mastra 自身の定型文）だけを渡す。transport は持たない（log を溜めない）。
 */
function createMastraLogger(sink: MastraAgentLogSink): MastraLogger {
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: unknown): void => {
      try {
        sink(level, typeof message === "string" ? message : "mastra log");
      } catch {
        // log は best effort。
      }
    };
  const empty = {
    logs: [] as never[],
    total: 0,
    page: 0,
    perPage: 0,
    hasMore: false,
  };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    trackException: () => undefined,
    getTransports: () => new Map(),
    listLogs: () => Promise.resolve(empty),
    listLogsByRunId: () => Promise.resolve(empty),
  } as unknown as MastraLogger;
}

/** tool 0・memory 無しの Agent を 1 つ作る。workspace・skills・memory・mcp・browser は渡さない。 */
function createAgent(
  model: ConstructorParameters<typeof Agent>[0]["model"],
  instructions: string,
  logger: MastraLogger,
): Agent {
  const agent = new Agent({
    id: "grimodex-main-agent",
    name: "grimodex-main-agent",
    instructions,
    model,
    maxRetries: AGENT_NO_RETRY_CONFIG.maxRetries,
    maxProcessorRetries: AGENT_NO_RETRY_CONFIG.maxProcessorRetries,
    errorProcessorDefaults: AGENT_NO_RETRY_CONFIG.errorProcessorDefaults,
  });
  agent.__setLogger(logger);
  return agent;
}

export function createMastraAgentRuntime(
  options: MastraAgentRuntimeOptions = {},
): MastraAgentRuntime {
  const logger = createMastraLogger(options.log ?? (() => undefined));
  return {
    async runTurn(input) {
      const { model } = createAgentLanguageModel({
        send: input.send,
        audit: input.audit,
        originalTools: [],
        prepareSend: input.prepareSend,
        observeResponse: input.observeResponse,
      });
      const agent = createAgent(model, input.instructions, logger);
      assertAgentToolsAllowed(Object.keys(await agent.listTools()));
      await agent.generate(
        input.messages.map(
          (
            message,
          ):
            | { role: "user"; content: string }
            | { role: "assistant"; content: string } =>
            message.role === "user"
              ? { role: "user", content: message.content }
              : { role: "assistant", content: message.content },
        ),
        {
          ...AGENT_CALL_OPTIONS,
          maxSteps: 1,
          abortSignal: input.signal,
          providerOptions: grimodexProviderOptions({
            route: input.route,
            systemCacheSegments: input.systemCacheSegments
              ? [...input.systemCacheSegments]
              : null,
            systemVolatileTail: input.systemVolatileTail,
          }),
        },
      );
    },
  };
}

export { Agent };
