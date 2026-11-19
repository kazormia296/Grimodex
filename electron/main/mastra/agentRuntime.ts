/**
 * Mastra の Agent を作る最小の雛形（Mastra 移行 MP-3a。docs/plans/mastra-mp3-decisions.md の DR-MP3-18）。
 *
 * - `@mastra/*` を import してよい main 側の唯一の module（3 つ目の bundle `dist-electron/mastra-agent.cjs` の entry）。
 *   main.cjs と preload.cjs には入れない（electron/scripts/mastra-ee-check.mjs の `--dist` が検査する）。
 * - MP-3a では製品のどこからも require しない。MP-3c が、旗 L が開いたときだけ `require(変数)` で遅延 load する。
 * - Agent に workspace・skills・memory・mcp・browser を渡さない（DR-MP3-14。静的検査は
 *   electron/main/mastra/mastraWorkspaceDisabled.static.test.ts）。tool も渡さない（MP-3 は tool 0）。
 */
import { Agent } from "@mastra/core/agent";

/** `createMastraAgent` が受ける設定。workspace などの欄は型の上でも持たない。 */
export interface MastraAgentRuntimeConfig {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  /** LanguageModelV4 の adapter（MP-2）。型は Agent の `model` に合わせる。 */
  readonly model: ConstructorParameters<typeof Agent>[0]["model"];
}

/** tool 0・memory 無しの Agent を 1 つ作る。 */
export function createMastraAgent(config: MastraAgentRuntimeConfig): Agent {
  return new Agent({
    id: config.id,
    name: config.name,
    instructions: config.instructions,
    model: config.model,
  });
}

export { Agent };
