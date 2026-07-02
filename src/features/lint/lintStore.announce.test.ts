// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/a11y/announcer", () => ({
  announce: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
import { announce } from "@/lib/a11y/announcer";
import { useLintStore } from "./lintStore";
import { useLintIgnoreStore } from "./lintIgnoreStore";
import type { Diagnostic, LintResponse, WireLintBlock } from "./types";

const mockInvoke = vi.mocked(invoke);
const mockAnnounce = vi.mocked(announce);

function block(text: string, offset = 0): WireLintBlock {
  return { id: 0, kind: "paragraph", text, str_offset_start: offset };
}

function diag(start: number, end: number, ruleId: string): Diagnostic {
  return {
    rule_id: ruleId,
    severity: "warning",
    message: "test",
    range: { start, end },
  };
}

function response(count: number): LintResponse {
  return {
    diagnostics: Array.from({ length: count }, (_, i) =>
      diag(i, i + 1, `ja/rule-${i}`),
    ),
    warnings: [],
    computed_at: Date.now(),
  };
}

async function run(sceneText: string): Promise<void> {
  await useLintStore
    .getState()
    .runLint("scene-1", [block(sceneText)], {}, "ja", sceneText, []);
}

describe("lintStore announce (WCAG 4.1.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLintIgnoreStore.getState().clear();
    useLintStore.getState().clear();
    useLintStore.getState().setCurrentScene("scene-1");
    mockAnnounce.mockClear();
  });

  it("完了時に診断数を announce する", async () => {
    mockInvoke.mockResolvedValue(response(2));
    await run("こんにちは");
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(String(mockAnnounce.mock.calls[0][0])).toContain("2");
  });

  it("診断数が変わらない再実行では announce しない (ノイズ抑止)", async () => {
    mockInvoke.mockResolvedValue(response(2));
    await run("こんにちは");
    await run("こんにちは");
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
  });

  it("診断数が変わったら再度 announce する", async () => {
    mockInvoke.mockResolvedValueOnce(response(2));
    await run("こんにちは");
    mockInvoke.mockResolvedValueOnce(response(3));
    await run("こんばんは");
    expect(mockAnnounce).toHaveBeenCalledTimes(2);
    expect(String(mockAnnounce.mock.calls[1][0])).toContain("3");
  });

  it("シーン切替で dedup がリセットされ同数でも announce する", async () => {
    mockInvoke.mockResolvedValue(response(1));
    await run("こんにちは");
    useLintStore.getState().setCurrentScene("scene-2");
    await useLintStore
      .getState()
      .runLint("scene-2", [block("こんにちは")], {}, "ja", "こんにちは", []);
    expect(mockAnnounce).toHaveBeenCalledTimes(2);
  });

  it("エラー時は assertive で announce する", async () => {
    mockInvoke.mockRejectedValue({ type: "InvalidConfig" });
    await run("こんにちは");
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce.mock.calls[0][1]).toBe("assertive");
  });

  it("同一エラーの連続発生では announce を繰り返さない", async () => {
    mockInvoke.mockRejectedValue({ type: "InvalidConfig" });
    await run("こんにちは");
    await run("こんばんは");
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
  });
});
