import { describe, it, expect } from "vitest";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
  PlotThreadBranchRow,
} from "./api";
import type { PlotPhaseType, PlotBranchKind } from "@/db/schema";
import { buildPlotThreadsMarkdown } from "./plotThreadMarkdown";

function thread(o: Partial<PlotThreadRow> & { id: string }): PlotThreadRow {
  return {
    projectId: "p1",
    name: o.id,
    color: null,
    description: null,
    sortOrder: "a0",
    startNodeId: null,
    endNodeId: null,
    version: 0,
    createdAt: "",
    updatedAt: "",
    ...o,
  };
}
function link(
  threadId: string,
  nodeId: string,
  phaseType: PlotPhaseType,
  note: string | null = null,
): PlotThreadLinkRow {
  return {
    id: `${threadId}-${nodeId}-${phaseType}`,
    threadId,
    nodeId,
    phaseType,
    note,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
  };
}
function branch(
  o: Partial<PlotThreadBranchRow> & {
    fromThreadId: string;
    toThreadId: string;
    atNodeId: string;
  },
): PlotThreadBranchRow {
  return {
    id: `${o.fromThreadId}-${o.toThreadId}-${o.atNodeId}`,
    projectId: "p1",
    kind: "branch",
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
    ...o,
  };
}

const LABELS = {
  heading: "プロット構成",
  colPhase: "段階",
  colScene: "シーン",
  colNote: "メモ",
  branchSection: "分岐・合流",
  unknownScene: "(不明なシーン)",
  unknownThread: "(不明なスレッド)",
};
const phaseLabel = (p: PlotPhaseType) => `<${p}>`;
const branchKindLabel = (k: PlotBranchKind) =>
  k === "branch" ? "分岐" : "合流";

function build(
  threads: PlotThreadRow[],
  links: PlotThreadLinkRow[],
  branches: PlotThreadBranchRow[],
  titles: Record<string, string>,
  order: Record<string, number>,
  projectName?: string,
) {
  return buildPlotThreadsMarkdown({
    threads,
    links,
    branches,
    titleByNodeId: new Map(Object.entries(titles)),
    indexByNodeId: new Map(Object.entries(order)),
    phaseLabel,
    branchKindLabel,
    labels: LABELS,
    projectName,
  });
}

describe("buildPlotThreadsMarkdown", () => {
  it("thread 見出し + 段階テーブル（軸順）+ description", () => {
    const md = build(
      [thread({ id: "t1", name: "復讐", description: "主人公の復讐譚" })],
      [link("t1", "s2", "develop"), link("t1", "s1", "introduce")],
      [],
      { s1: "出会い", s2: "対立" },
      { s1: 0, s2: 1 },
      "拙作",
    );
    expect(md).toContain("# プロット構成: 拙作");
    expect(md).toContain("## 復讐");
    expect(md).toContain("主人公の復讐譚");
    // 軸順 s1(0) → s2(1)
    const iIntro = md.indexOf("<introduce>");
    const iDev = md.indexOf("<develop>");
    expect(iIntro).toBeGreaterThan(-1);
    expect(iIntro).toBeLessThan(iDev);
    expect(md).toContain("| 段階 | シーン | メモ |");
  });

  it("空 description/note はスキップ（セル空）", () => {
    const md = build(
      [thread({ id: "t1", name: "糸", description: "" })],
      [link("t1", "s1", "introduce", "  ")],
      [],
      { s1: "場面" },
      { s1: 0 },
    );
    expect(md).not.toContain("description");
    // note 空 → 末尾セルが空
    expect(md).toContain("| <introduce> | 場面 |  |");
  });

  it("パイプ/改行は mdCell でエスケープ", () => {
    const md = build(
      [thread({ id: "t1", name: "a|b" })],
      [link("t1", "s1", "introduce", "1行目\n2行目|x")],
      [],
      { s1: "t|t" },
      { s1: 0 },
    );
    expect(md).toContain("## a\\|b");
    expect(md).toContain("| <introduce> | t\\|t | 1行目 2行目\\|x |");
  });

  it("未知 nodeId は unknownScene フォールバック", () => {
    const md = build(
      [thread({ id: "t1", name: "糸" })],
      [link("t1", "ghost", "introduce")],
      [],
      {},
      {},
    );
    expect(md).toContain("(不明なシーン)");
  });

  it("分岐・合流セクション（thread 名 + シーン解決）", () => {
    const md = build(
      [thread({ id: "t1", name: "本流" }), thread({ id: "t2", name: "支流" })],
      [],
      [
        branch({
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "s1",
          kind: "branch",
        }),
      ],
      { s1: "分岐点" },
      { s1: 0 },
    );
    expect(md).toContain("## 分岐・合流");
    expect(md).toContain("- 分岐: 本流 → 支流 @ 分岐点");
  });

  it("分岐が未知スレッドを参照したらスレッド用フォールバック（シーン用と区別）", () => {
    const md = build(
      [thread({ id: "t2", name: "支流" })],
      [],
      [
        branch({
          fromThreadId: "tGone",
          toThreadId: "t2",
          atNodeId: "s1",
          kind: "merge",
        }),
      ],
      { s1: "合流点" },
      { s1: 0 },
    );
    expect(md).toContain("(不明なスレッド) → 支流 @ 合流点");
    expect(md).not.toContain("(不明なシーン) → 支流");
  });

  it("projectName 省略時は見出しのみ", () => {
    const md = build([thread({ id: "t1", name: "糸" })], [], [], {}, {});
    expect(md).toContain("# プロット構成");
    expect(md).not.toContain("# プロット構成:");
  });
});
