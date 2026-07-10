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
    readings: null,
    summary: null,
    content: "{}",
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    version: 0,
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

/**
 * benefit シナリオ用コーパス（phase 無し）。
 *
 * bob はアリスの「従者（家臣）」だが**シーン本文には主従が書かれていない**。
 * しかも見た目の手がかりは逆（アリス＝旅の若者／ボブ＝歴戦の騎士）なので、
 * relation を注入しない off は「アリスがボブに従う」と取り違えやすい。
 * label-only は「経由: from アリス via 従者」で主従の向きを知る。
 * → relation 注入の benefit（関係がシーン外にしか無い時の価値）を判別する。
 */
export function buildBenefitCorpus(): RelationInjectionCorpus {
  const nodes = [mkScene("b1", "a0")];
  const entries = [
    mkEntry({ id: "alice", name: "アリス", summary: "アリスは旅をする若者。" }),
    mkEntry({ id: "bob", name: "ボブ", summary: "ボブは歴戦の騎士。" }),
  ];
  const relations = [
    mkRelation({
      id: "rb1",
      fromCodexId: "alice",
      toCodexId: "bob",
      relationType: "servant",
      label: "従者",
    }),
  ];
  return {
    nodes,
    entries,
    relations,
    phasesByEntry: new Map(),
    targetSceneId: "b1",
    seedEntryIds: ["alice"],
  };
}

/**
 * intra-context surfacing シナリオ用コーパス（phase 無し）。
 *
 * benefit との違いは **bob も seed（両方が文脈にいる）** こと。alice と bob が両方
 * シーンに登場するが、二人の主従（bob は alice の家臣）は **本文にも各 summary にも
 * 書かれていない**。重要: summary に身分を書くと off でも階層が分かってしまい測定に
 * ならない。そこで summary は身分を伏せ、見た目の手がかりはむしろ逆（alice＝旅の若者
 * ／bob＝歴戦の騎士）にして、関係を surfacing しないと「老騎士が若者を率いる」と
 * 取り違えやすくする。両端とも seed なので discovery では引き込まれず surfacing でのみ
 * 関係が出る。関係は向きを持つ（alice→bob via 家臣）ため向き保持も同時に検証できる。
 */
export function buildIntraContextCorpus(): RelationInjectionCorpus {
  const nodes = [mkScene("i1", "a0")];
  const entries = [
    mkEntry({ id: "alice", name: "アリス", summary: "アリスは旅をする若者。" }),
    mkEntry({ id: "bob", name: "ボブ", summary: "ボブは歴戦の騎士。" }),
  ];
  const relations = [
    mkRelation({
      id: "ri1",
      fromCodexId: "alice",
      toCodexId: "bob",
      relationType: "vassal",
      label: "家臣",
    }),
  ];
  return {
    nodes,
    entries,
    relations,
    phasesByEntry: new Map(),
    targetSceneId: "i1",
    seedEntryIds: ["alice", "bob"],
  };
}

/**
 * intra-context surfacing **対称関係**シナリオ用コーパス（phase 無し）。
 *
 * directional 版が「向きを当てる」難所だったのに対し、こちらは向きを間違えようがない
 * 対称関係（幼馴染）で純粋に「隠れた関係を surfacing すると描写に反映されるか」を測る。
 * alice（警備隊長）と bob（裏町の軽業師）は立場が対立し、二人が幼馴染である事実は
 * **概要にもシーン本文にも書かれていない**。関係を知らなければ「赤の他人の追跡劇」に
 * なるが、surfacing すれば旧知の friction（名前呼び・ためらい等）を織り込める。
 * 両端とも seed なので discovery では出ず、surfacing でのみ関係が現れる。
 */
export function buildIntraSymmetricCorpus(): RelationInjectionCorpus {
  const nodes = [mkScene("s1", "a0")];
  const entries = [
    mkEntry({
      id: "alice",
      name: "アリス",
      summary: "アリスは王都警備隊の隊長。",
    }),
    mkEntry({ id: "bob", name: "ボブ", summary: "ボブは裏町に生きる軽業師。" }),
  ];
  const relations = [
    mkRelation({
      id: "rs1",
      fromCodexId: "alice",
      toCodexId: "bob",
      relationType: "childhood_friend",
      label: "幼馴染",
    }),
  ];
  return {
    nodes,
    entries,
    relations,
    phasesByEntry: new Map(),
    targetSceneId: "s1",
    seedEntryIds: ["alice", "bob"],
  };
}
