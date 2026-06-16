/**
 * relation injection 3 アーム eval 用の合成コーパス。
 *
 * 実プロジェクトに phased + typed-relation のサンプルが無いため、
 * 「品質ノイズ／時点リーク」を再現する最小ストーリーを合成する。
 * 数値は本フィクスチャ上の相対比較であり、フィールド統計ではない点に注意。
 *
 * シーン順 (reading): sc1 < sc2 < sc3 < sc4。ターゲットは sc4（後半）。
 * sc4 で言及される seed は alice のみ。alice の直接の相手 = bob / cara (depth1)、
 * bob→dan・cara→eve が depth2。bob と dan は sc4 までに phase で summary が
 * 変わる＝生 base summary を注入すると時点リークになる。
 */
import type { CodexEntry } from "./api";
import type { CodexRelationRow } from "./codexRelationApi";
import type { CodexEntryPhase } from "@/db/schema";
import type { TreeNodeData } from "@/features/tree/treeStore";

const T = "2026-01-01T00:00:00.000Z";
const PID = "p-eval";

function mkEntry(partial: Partial<CodexEntry> & { id: string }): CodexEntry {
  return {
    projectId: PID,
    parentId: null,
    type: "character",
    name: "Untitled",
    aliases: null,
    excludedAliases: null,
    summary: null,
    content: "{}",
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: T,
    updatedAt: T,
    ...partial,
  };
}

function mkRelation(
  partial: Partial<CodexRelationRow> & {
    id: string;
    fromCodexId: string;
    toCodexId: string;
  },
): CodexRelationRow {
  return {
    projectId: PID,
    relationType: "custom",
    label: null,
    depthHint: null,
    sourceMapEdgeId: null,
    createdAt: T,
    updatedAt: T,
    ...partial,
  };
}

function mkPhase(
  partial: Partial<CodexEntryPhase> & {
    id: string;
    entryId: string;
    anchorNodeId: string;
  },
): CodexEntryPhase {
  return {
    label: "",
    summaryOverride: null,
    contentOverride: null,
    contextModeOverride: null,
    createdAt: T,
    updatedAt: T,
    ...partial,
  };
}

function mkScene(id: string, sortOrder: string): TreeNodeData {
  return {
    id,
    projectId: PID,
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: T,
    updatedAt: T,
  };
}

export interface RelationInjectionCorpus {
  nodes: TreeNodeData[];
  entries: CodexEntry[];
  relations: CodexRelationRow[];
  phasesByEntry: Map<string, CodexEntryPhase[]>;
  /** ターゲットシーン */
  targetSceneId: string;
  /** ターゲットシーンで言及/pin される seed（= 直接文脈に入るエントリ） */
  seedEntryIds: string[];
}

export function buildEvalCorpus(): RelationInjectionCorpus {
  const nodes = [
    mkScene("sc1", "a0"),
    mkScene("sc2", "a1"),
    mkScene("sc3", "a2"),
    mkScene("sc4", "a3"),
  ];

  const entries = [
    mkEntry({ id: "alice", name: "アリス", summary: "アリスは見習いの剣士。" }),
    // bob: sc3 で「師匠」→「裏切り者」に変化。sc4 では base("師匠") は時点ズレ。
    mkEntry({ id: "bob", name: "ボブ", summary: "ボブはアリスの剣の師匠。" }),
    // cara: 変化なし（リークしない対照）
    mkEntry({
      id: "cara",
      name: "カーラ",
      summary: "カーラはアリスの好敵手。",
    }),
    // dan: depth2。sc2 で「鍛冶師」→「消息不明」に変化。sc4 では base はズレ。
    mkEntry({ id: "dan", name: "ダン", summary: "ダンは王国の鍛冶師。" }),
    // eve: depth2。変化なし（リークしない対照）
    mkEntry({ id: "eve", name: "イヴ", summary: "イヴはカーラの妹。" }),
    // frank: relation 無し。決して注入されない対照
    mkEntry({ id: "frank", name: "フランク", summary: "フランクは旅の商人。" }),
  ];

  const relations = [
    mkRelation({
      id: "r1",
      fromCodexId: "alice",
      toCodexId: "bob",
      relationType: "mentor",
      label: "師匠",
    }),
    mkRelation({
      id: "r2",
      fromCodexId: "alice",
      toCodexId: "cara",
      relationType: "rival",
      label: "好敵手",
    }),
    // depth2: bob → dan
    mkRelation({
      id: "r3",
      fromCodexId: "bob",
      toCodexId: "dan",
      relationType: "rival",
      label: "商売敵",
    }),
    // depth2: cara → eve
    mkRelation({
      id: "r4",
      fromCodexId: "cara",
      toCodexId: "eve",
      relationType: "family",
      label: "姉妹",
    }),
  ];

  const phasesByEntry = new Map<string, CodexEntryPhase[]>([
    [
      "bob",
      [
        mkPhase({
          id: "ph-bob-1",
          entryId: "bob",
          anchorNodeId: "sc3",
          summaryOverride: "ボブは正体を現した裏切り者。",
        }),
      ],
    ],
    [
      "dan",
      [
        mkPhase({
          id: "ph-dan-1",
          entryId: "dan",
          anchorNodeId: "sc2",
          summaryOverride: "ダンは隠居して消息不明。",
        }),
      ],
    ],
  ]);

  return {
    nodes,
    entries,
    relations,
    phasesByEntry,
    targetSceneId: "sc4",
    seedEntryIds: ["alice"],
  };
}
