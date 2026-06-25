import {
  PLOT_PHASE_TYPES,
  type PlotPhaseType,
  type PlotBranchKind,
} from "@/db/schema";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
  PlotThreadBranchRow,
} from "./api";

/** Markdown テーブルセルの無害化（改行畳み込み・バックスラッシュ/パイプ escape）。 */
function mdCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

export interface PlotThreadsMarkdownLabels {
  heading: string;
  colPhase: string;
  colScene: string;
  colNote: string;
  branchSection: string;
  unknownScene: string;
  unknownThread: string;
}

export interface PlotThreadsMarkdownInput {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  branches: PlotThreadBranchRow[];
  titleByNodeId: Map<string, string>;
  /** 行/分岐を軸順に並べるための index（無いものは末尾）。 */
  indexByNodeId: Map<string, number>;
  phaseLabel: (p: PlotPhaseType) => string;
  branchKindLabel: (k: PlotBranchKind) => string;
  labels: PlotThreadsMarkdownLabels;
  projectName?: string;
}

/**
 * 手で組んだ thread/link/branch を Markdown へ整形する純関数（i18n ラベルは注入）。
 * 死蔵していた description/note を活性化し、空はスキップしてフォーマット崩れを防ぐ。
 */
export function buildPlotThreadsMarkdown(
  input: PlotThreadsMarkdownInput,
): string {
  const {
    threads,
    links,
    branches,
    titleByNodeId,
    indexByNodeId,
    phaseLabel,
    branchKindLabel,
    labels,
    projectName,
  } = input;

  const lines: string[] = [];
  lines.push(
    projectName
      ? `# ${labels.heading}: ${mdCell(projectName)}`
      : `# ${labels.heading}`,
    "",
  );

  const sceneIdx = (nodeId: string) =>
    indexByNodeId.get(nodeId) ?? Number.POSITIVE_INFINITY;
  const sceneTitle = (nodeId: string) =>
    titleByNodeId.get(nodeId) ?? labels.unknownScene;
  const phaseOrder = (p: PlotPhaseType) => PLOT_PHASE_TYPES.indexOf(p);

  const sortedThreads = [...threads].sort((a, b) =>
    cmpKeys(a.sortOrder, b.sortOrder),
  );
  for (const thread of sortedThreads) {
    lines.push(`## ${mdCell(thread.name)}`);
    const desc = thread.description?.trim();
    if (desc) lines.push("", desc);

    const threadLinks = links
      .filter((l) => l.threadId === thread.id)
      .sort((a, b) => {
        const di = sceneIdx(a.nodeId) - sceneIdx(b.nodeId);
        return di !== 0
          ? di
          : phaseOrder(a.phaseType) - phaseOrder(b.phaseType);
      });
    if (threadLinks.length > 0) {
      lines.push("");
      lines.push(
        `| ${labels.colPhase} | ${labels.colScene} | ${labels.colNote} |`,
      );
      lines.push(`| --- | --- | --- |`);
      for (const l of threadLinks) {
        const note = l.note?.trim() ? mdCell(l.note.trim()) : "";
        lines.push(
          `| ${mdCell(phaseLabel(l.phaseType))} | ${mdCell(
            sceneTitle(l.nodeId),
          )} | ${note} |`,
        );
      }
    }
    lines.push("");
  }

  if (branches.length > 0) {
    lines.push(`## ${labels.branchSection}`);
    const threadName = (id: string) => {
      const t = threads.find((x) => x.id === id);
      return t ? mdCell(t.name) : labels.unknownThread;
    };
    const sortedBranches = [...branches].sort(
      (a, b) => sceneIdx(a.atNodeId) - sceneIdx(b.atNodeId),
    );
    for (const b of sortedBranches) {
      lines.push(
        `- ${mdCell(branchKindLabel(b.kind))}: ${threadName(
          b.fromThreadId,
        )} → ${threadName(b.toThreadId)} @ ${mdCell(sceneTitle(b.atNodeId))}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
