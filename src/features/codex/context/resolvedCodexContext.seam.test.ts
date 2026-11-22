/**
 * MP-4b PR-3b-2 の seam：`vi.mock` は module id（解決後の file）単位で効く。
 *
 * `resolvedCodexContext`・`phaseResolver` は `electron/shared/readDomain/` へ移し、旧 path
 * （`@/features/codex/...`）は 1 行の `export * from` の stub にした。stub 経由で読んだ実体
 * （resolvedCodexContext）が、同じ実体側の phaseResolver を相対 import（`../phaseResolver.js`）するので、
 * **旧 path だけに掛けた `vi.mock` は moved→moved の値 import を素通りする**。
 * 試験が旧 path の mock に頼っていると、mock が呼ばれないまま実物が走って検証の意味が変わる
 * （例：consistencyPayloadBuilder.test は `mockResolveCodexState` の呼出しを assert しており、
 * 旧 path だけの mock では落ちる）。この試験はその仕組みと、直し方（実体 path にも同じ factory を掛ける）を固定する。
 *
 * vitest の module 解決の挙動が変わって旧 path の mock が実体まで届くようになった場合は、この試験が落ちる。
 * そのときは seam の表（docs/plans/mastra-mp4-decisions.md の DR-MP4-3i）を見直す。
 */
import { describe, expect, it, vi } from "vitest";

const { viaOldPath, viaRealPath } = vi.hoisted(() => ({
  viaOldPath: vi.fn(() => ({ summary: "old-path-mock" })),
  viaRealPath: vi.fn(() => ({ summary: "real-path-mock" })),
}));

// 旧 path（stub）の mock。stub を直接 import する非移動側にだけ届く。
vi.mock("@/features/codex/phaseResolver", () => ({
  resolveCodexState: viaOldPath,
}));
// 実体 path の mock。moved→moved の相対 import にも届く。
vi.mock("@/../electron/shared/readDomain/features/codex/phaseResolver", () => ({
  resolveCodexState: viaRealPath,
}));

import { resolveCodexContexts } from "@/features/codex/context/resolvedCodexContext";
import { resolveCodexState as resolveViaStub } from "@/features/codex/phaseResolver";

describe("moved→moved の値 import と vi.mock の seam", () => {
  it("stub を直接 import する側は旧 path の mock を受ける", () => {
    expect(resolveViaStub).toBe(viaOldPath);
  });

  it("実体の resolvedCodexContext は、実体 path の mock だけを受ける（旧 path の mock は素通り）", () => {
    const entry = {
      id: "e1",
      summary: null,
      content: "",
      contextMode: "always",
    };
    const result = resolveCodexContexts({
      entries: [entry],
      phases: [],
      anchor: { kind: "scene", sceneId: "s1" } as never,
      sceneTimeIndex: {} as never,
      resolutionMode: "reading",
    });
    expect(viaRealPath).toHaveBeenCalledTimes(1);
    expect(viaOldPath).not.toHaveBeenCalled();
    expect(result.resolvedById.get("e1")).toEqual({
      summary: "real-path-mock",
    });
  });
});
