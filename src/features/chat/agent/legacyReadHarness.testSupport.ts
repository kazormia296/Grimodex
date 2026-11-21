/**
 * MP-4b PR-0：legacy の read tool の特性試験の harness。
 *
 * 実 sql.js（browser-mock）の `@/db/client` に対して `executeTool` を呼ぶ。seed は
 * `__fixtures__/legacyReadSeed.ts`（data）を、`db_execute` の INSERT で入れる。
 *
 * 前提（golden の注記）：
 * - `countTokens` は試験側で `../contextBuilder` を差し替え、1 文字（UTF-16 の length）＝1 token
 *   に固定する。tokenizer の mode（exact／heuristic／live-estimate）で golden が揺れない。
 * - 年表の cache は毎 scenario の前に破棄する。
 * - store（tree／phase）は実物を使い、`nodes` は seed した DB の `listNodes`（archived 除外）から作る。
 */
import { executeTool } from "./toolExecutors";
import { invoke } from "@/lib/tauri";
import { listNodes } from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/types";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import i18next, { ensureLocale } from "@/lib/i18n";
import { invalidateChronicleToolCache } from "./chronicleToolCache";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import { LEGACY_READ_SEED, type SeedRow } from "./__fixtures__/legacyReadSeed";

export const LEGACY_READ_WORKSPACE_PATH = "/workspace/legacy-read.grimodex";

let seeded: Promise<void> | null = null;

/** fixture を入れる（file 内で 1 回だけ。呼び直しても再投入しない）。FK の順に並んでいる。 */
export function seedLegacyReadFixture(): Promise<void> {
  seeded ??= insertLegacyReadFixture();
  return seeded;
}

async function insertLegacyReadFixture(): Promise<void> {
  for (const { table, rows } of LEGACY_READ_SEED) {
    for (const row of rows as readonly SeedRow[]) {
      const columns = Object.keys(row);
      const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`;
      await invoke("db_execute", {
        sql,
        params: columns.map((c) => row[c]),
        method: "run",
      });
    }
  }
  legacyReadInvokeBridge.reset();
}

export interface LegacyReadWorld {
  /** 空文字＝project 無し（store の型は string。legacy は `!projectId` で判定する）。 */
  projectId: string;
  /** store の activeSceneId（空文字＝場面なし）。 */
  activeSceneId?: string;
  /** UI 言語（年表の日付整形）。既定 ja。 */
  language?: "ja" | "en";
  /** phase store の resolutionMode。既定 reading（seed の projects と同じ）。 */
  resolutionMode?: "reading" | "story" | "auto";
}

/** tree／phase store と年表の cache を world に揃える。nodes は DB（archived 除外）から作る。 */
export async function setLegacyReadWorld(
  world: LegacyReadWorld,
): Promise<void> {
  const nodes = (world.projectId
    ? await listNodes(world.projectId)
    : []) as unknown as TreeNodeData[];
  useTreeStore.setState({
    projectId: world.projectId,
    nodes,
    activeSceneId: world.activeSceneId ?? "",
  });
  usePhaseStore.setState({
    sceneTimeIndex: buildSceneTimeIndex(nodes),
    resolutionMode: world.resolutionMode ?? "reading",
  });
  await ensureLocale(world.language ?? "ja");
  await i18next.changeLanguage(world.language ?? "ja");
  invalidateChronicleToolCache();
}

export function setLegacyReadWorkspaceIdentity(): void {
  setCurrentWorkspaceIdentity({
    path: LEGACY_READ_WORKSPACE_PATH,
    openRevision: 1,
  });
}

export interface LegacyReadScenario {
  /** 1 行の名前（golden の key）。 */
  readonly name: string;
  readonly world: LegacyReadWorld;
  readonly params: Record<string, unknown>;
  /** command 単位の Native 差し替え（browser-mock の dense は常に []。canned の結果を返す）。 */
  readonly native?: Readonly<
    Record<string, (args: Record<string, unknown> | undefined) => unknown>
  >;
  /** executor の例外を `Error:` の summary で返す scenario のときだけ true。 */
  readonly expectError?: boolean;
}

export interface LegacyReadGoldenCase {
  readonly case: string;
  readonly world: LegacyReadWorld;
  readonly params: Record<string, unknown>;
  readonly result: {
    readonly name: string;
    readonly summary: string;
    readonly tokensUsed: number;
    readonly content: unknown;
    readonly error?: string;
  };
  /** model に渡る `JSON.stringify(content)` の bytes（tokensUsed の数えの元）。 */
  readonly contentJson: string;
}

/** scenario を順に流し、golden の文書（pretty JSON。key の順も固定される）を返す。 */
export async function runLegacyReadScenarios(
  tool: string,
  scenarios: readonly LegacyReadScenario[],
): Promise<string> {
  const cases: LegacyReadGoldenCase[] = [];
  for (const scenario of scenarios) {
    await setLegacyReadWorld(scenario.world);
    legacyReadInvokeBridge.reset();
    for (const [cmd, fn] of Object.entries(scenario.native ?? {})) {
      legacyReadInvokeBridge.override(cmd, fn);
    }
    const result = await executeTool(tool, "call-1", scenario.params);
    legacyReadInvokeBridge.reset();
    if (result.error && !scenario.expectError) {
      throw new Error(
        `${tool}/${scenario.name}: unexpected error: ${result.error}`,
      );
    }
    cases.push({
      case: scenario.name,
      world: scenario.world,
      params: scenario.params,
      result: {
        name: result.name,
        summary: result.summary,
        tokensUsed: result.tokensUsed,
        content: result.content,
        ...(result.error ? { error: result.error } : {}),
      },
      contentJson: JSON.stringify(result.content),
    });
  }
  return `${JSON.stringify({ tool, cases }, null, 2)}\n`;
}
