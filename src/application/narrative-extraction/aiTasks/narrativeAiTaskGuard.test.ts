import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const AI_TASKS_DIR = path.join(
  process.cwd(),
  "src/application/narrative-extraction/aiTasks",
);

function aiTaskFiles(): string[] {
  return readdirSync(AI_TASKS_DIR)
    .filter((name) => name.startsWith("run") && name.endsWith("Task.ts"))
    .sort();
}

/**
 * ライセンス認証設計書 §6 の配置規約（ゲートは既存 `blockIfPolicyOff` の隣）を
 * 機械的に固定する。これが無いと「policy ガードだけ書いた新タスク」が増え、
 * 制限状態のまま有償モデルを叩ける経路がまた開く — 実際、この検査を入れる
 * 直前まで 22 タスク全てがその状態だった。
 */
describe("narrative AI タスクのガード規約", () => {
  it("aiTasks 配下は policyGuard を直接 import しない（対の共有ガードを経由する）", () => {
    const offenders = aiTaskFiles().filter((name) =>
      readFileSync(path.join(AI_TASKS_DIR, name), "utf8").includes(
        "ai-policy/policyGuard",
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("AI を呼ぶ全タスクが共有ガードを通る", () => {
    const files = aiTaskFiles();
    expect(files.length).toBeGreaterThan(0);
    const ungated = files.filter((name) => {
      const source = readFileSync(path.join(AI_TASKS_DIR, name), "utf8");
      // AI を呼ばないタスクはガード不要。呼ぶなら必ず共有ガードを通ること。
      if (!source.includes("sendChatMessage")) return false;
      return !source.includes("blockNarrativeAiTask(");
    });
    expect(ungated).toEqual([]);
  });
});

describe("blockNarrativeAiTask", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("@/features/ai-policy/policyGuard");
    vi.doUnmock("@/features/license/gate");
  });

  async function load(policyBlocked: boolean, licenseBlocked: boolean) {
    const blockIfUnlicensed = vi.fn(() => licenseBlocked);
    const blockIfPolicyOff = vi.fn(() => policyBlocked);
    vi.doMock("@/features/ai-policy/policyGuard", () => ({ blockIfPolicyOff }));
    vi.doMock("@/features/license/gate", () => ({ blockIfUnlicensed }));
    const mod = await import("./narrativeAiTaskGuard");
    return {
      blockNarrativeAiTask: mod.blockNarrativeAiTask,
      blockIfUnlicensed,
      blockIfPolicyOff,
    };
  }

  it("ポリシー OFF でブロックし、ライセンスは見に行かない", async () => {
    const { blockNarrativeAiTask, blockIfUnlicensed } = await load(true, false);
    expect(blockNarrativeAiTask()).toBe(true);
    // policy OFF は利用者自身の設定なので、そちらの説明が優先される。
    expect(blockIfUnlicensed).not.toHaveBeenCalled();
  });

  it("ライセンス制限中はポリシーが許可でもブロックする", async () => {
    const { blockNarrativeAiTask } = await load(false, true);
    expect(blockNarrativeAiTask()).toBe(true);
  });

  it("toast は固定 id 付きで要求する（合成タスク→修復タスクの二重発火対策）", async () => {
    const { blockNarrativeAiTask, blockIfUnlicensed } = await load(false, true);
    blockNarrativeAiTask();
    expect(blockIfUnlicensed).toHaveBeenCalledWith(
      "narrative-ai-task-license-blocked",
    );
  });

  it("どちらも許可なら通す", async () => {
    const { blockNarrativeAiTask } = await load(false, false);
    expect(blockNarrativeAiTask()).toBe(false);
  });
});
