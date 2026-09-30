import { describe, it, expect } from "vitest";
import {
  computeThreadCharacterArc,
  type ArcMentionRow,
} from "./threadCharacterArc";
import type { PlotThreadLinkRow } from "./api";

function link(threadId: string, nodeId: string): PlotThreadLinkRow {
  return {
    id: `${threadId}-${nodeId}`,
    threadId,
    nodeId,
    phaseType: "develop",
    note: null,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
  };
}

function m(
  sceneId: string,
  codexEntryId: string,
  source: ArcMentionRow["source"],
  role?: string,
): ArcMentionRow {
  return { sceneId, codexEntryId, source, role: role ?? null };
}

describe("computeThreadCharacterArc", () => {
  it("ranks characters within the thread's scenes by weighted score", () => {
    // thread t1 = scenes s1,s2,s3 (t2.s9 は対象外)
    const links = [
      link("t1", "s1"),
      link("t1", "s2"),
      link("t1", "s3"),
      link("t2", "s9"),
    ];
    const mentions = [
      // alice: body in s1,s2,s3 (2/scene) = 6
      m("s1", "alice", "body"),
      m("s2", "alice", "body"),
      m("s3", "alice", "body"),
      // bob: beat actor in s1 (1+2=3)
      m("s1", "bob", "beat", "actor"),
      // carol: relation only in s2 (0) — 参考
      m("s2", "carol", "relation"),
      // 対象外スレッドの mention は無視
      m("s9", "alice", "body"),
    ];
    const arc = computeThreadCharacterArc(links, "t1", mentions, new Map());
    expect(arc.map((a) => a.codexEntryId)).toEqual(["alice", "bob", "carol"]);
    const alice = arc.find((a) => a.codexEntryId === "alice")!;
    expect(alice.sceneCount).toBe(3);
    expect(alice.score).toBe(6);
    const bob = arc.find((a) => a.codexEntryId === "bob")!;
    expect(bob.score).toBe(3);
    const carol = arc.find((a) => a.codexEntryId === "carol")!;
    expect(carol.score).toBe(0);
    expect(carol.sceneCount).toBe(1);
  });

  it("dedups scene count across body+beat+relation rows for the same (scene,char)", () => {
    const links = [link("t1", "s1")];
    const mentions = [
      m("s1", "alice", "body"),
      m("s1", "alice", "beat", "actor"),
      m("s1", "alice", "relation"),
    ];
    const arc = computeThreadCharacterArc(links, "t1", mentions, new Map());
    expect(arc).toHaveLength(1);
    // 1 シーンとして数える（3 重計上しない）。score = topSource(body=2) + beatRole(actor=2) = 4
    expect(arc[0].sceneCount).toBe(1);
    expect(arc[0].score).toBe(4);
  });

  it("dedups thread scenes across multiple phase markers", () => {
    // s1 が introduce と climax の 2 マーカーを持つ → シーンは 1 つ
    const links = [
      { ...link("t1", "s1"), id: "a", phaseType: "introduce" as const },
      { ...link("t1", "s1"), id: "b", phaseType: "climax" as const },
    ];
    const mentions = [m("s1", "alice", "body")];
    const arc = computeThreadCharacterArc(links, "t1", mentions, new Map());
    expect(arc[0].sceneCount).toBe(1);
    expect(arc[0].score).toBe(2);
  });

  it("applies a POV boost and includes POV-only characters", () => {
    const links = [link("t1", "s1"), link("t1", "s2")];
    const mentions = [m("s1", "alice", "body")]; // alice mentioned in s1
    // s1 POV = alice, s2 POV = dave (mention 無し)
    const pov = new Map<string, string | null>([
      ["s1", "alice"],
      ["s2", "dave"],
    ]);
    const arc = computeThreadCharacterArc(links, "t1", mentions, pov);
    const alice = arc.find((a) => a.codexEntryId === "alice")!;
    // body(2) + POV boost(3) = 5、isPov
    expect(alice.score).toBe(5);
    expect(alice.isPov).toBe(true);
    // dave は mention 無しでも POV シーンで登場（boost のみ）
    const dave = arc.find((a) => a.codexEntryId === "dave")!;
    expect(dave).toBeDefined();
    expect(dave.sceneCount).toBe(1);
    expect(dave.isPov).toBe(true);
    expect(dave.score).toBe(3);
  });

  it("returns [] when the thread has no scenes", () => {
    expect(computeThreadCharacterArc([], "t1", [], new Map())).toEqual([]);
  });

  it("only reads role from beat rows (body/relation role is ignored)", () => {
    const links = [link("t1", "s1")];
    // body row with a stray role='actor' must NOT be trusted as actor
    const mentions = [m("s1", "alice", "body", "actor")];
    const arc = computeThreadCharacterArc(links, "t1", mentions, new Map());
    // body topSource=2, role from non-beat ignored => mentioned(0). score=2
    expect(arc[0].score).toBe(2);
  });
});
