/**
 * 構造テンプレート定義
 *
 * Apply structure template ▸ で適用する。
 * `rootChildren` を現在のコンテナ直下に直置きで展開する。
 *
 * Phase 4 後続: 構造役割 (=「Refusal of the Call」のような stage の意図) は
 * すべて folder.synopsis に格納する設計に統一した。chat の chapter outline
 * 注入経路に乗せるため。scene は placeholder のみで synopsis を持たない。
 *
 * i18n キー設計:
 *   grid.structureTemplates.{templateKey}.name
 *   grid.structureTemplates.{templateKey}.stages.{stageKey}.name
 *   grid.structureTemplates.{templateKey}.stages.{stageKey}.synopsis  (folder のみ)
 *   grid.structureTemplates.placeholderScene  (placeholder scene 共通名)
 */

export type StructureNodeKind = "folder" | "scene";

export interface StructureNode {
  kind: StructureNodeKind;
  /** i18n stage key under grid.structureTemplates.{templateKey}.stages。
   *  placeholder=true のときは i18n lookup をスキップして共通プレースホルダ名を使う。 */
  stage: string;
  /** kind === "folder" のときのみ。再帰可 */
  children?: StructureNode[];
  /** kind === "scene" のときのみ。共通の "シーン" / "Scene" 名を使う */
  placeholder?: boolean;
}

export interface StructureTemplate {
  key: string;
  rootChildren: StructureNode[];
}

const folder = (stage: string, children: StructureNode[]): StructureNode => ({
  kind: "folder",
  stage,
  children,
});

const scene = (stage: string): StructureNode => ({ kind: "scene", stage });

/** 各 stage を folder で wrap し、中に placeholder scene を 1つ置く。
 *  Pattern B/C (saveTheCat / heroJourney / storyCircle) の beat / stage に使う。 */
const stageFolder = (stage: string): StructureNode => ({
  kind: "folder",
  stage,
  children: [{ kind: "scene", stage, placeholder: true }],
});

export const STRUCTURE_TEMPLATES: StructureTemplate[] = [
  {
    key: "threeAct",
    rootChildren: [
      folder("act1", [scene("act1Scene")]),
      folder("act2", [scene("act2Scene")]),
      folder("act3", [scene("act3Scene")]),
    ],
  },
  {
    key: "kishoten",
    rootChildren: [
      folder("ki", [scene("kiScene")]),
      folder("sho", [scene("shoScene")]),
      folder("ten", [scene("tenScene")]),
      folder("ketsu", [scene("ketsuScene")]),
    ],
  },
  {
    key: "freytag",
    rootChildren: [
      folder("exposition", [scene("expositionScene")]),
      folder("risingAction", [scene("risingActionScene")]),
      folder("climax", [scene("climaxScene")]),
      folder("fallingAction", [scene("fallingActionScene")]),
      folder("resolution", [scene("resolutionScene")]),
    ],
  },
  {
    key: "saveTheCat",
    rootChildren: [
      folder("act1", [
        stageFolder("openingImage"),
        stageFolder("themeStated"),
        stageFolder("setup"),
        stageFolder("catalyst"),
        stageFolder("debate"),
      ]),
      folder("act2", [
        stageFolder("breakIntoTwo"),
        stageFolder("bStory"),
        stageFolder("funAndGames"),
        stageFolder("midpoint"),
        stageFolder("badGuysClose"),
        stageFolder("allIsLost"),
        stageFolder("darkNightOfSoul"),
        stageFolder("breakIntoThree"),
      ]),
      folder("act3", [stageFolder("finale"), stageFolder("finalImage")]),
    ],
  },
  {
    key: "heroJourney",
    rootChildren: [
      folder("departure", [
        stageFolder("ordinaryWorld"),
        stageFolder("callToAdventure"),
        stageFolder("refusal"),
        stageFolder("meeting"),
        stageFolder("crossingThreshold"),
      ]),
      folder("initiation", [
        stageFolder("testsAlliesEnemies"),
        stageFolder("approach"),
        stageFolder("ordeal"),
        stageFolder("reward"),
      ]),
      folder("returnAct", [
        stageFolder("roadBack"),
        stageFolder("resurrection"),
        stageFolder("returnWithElixir"),
      ]),
    ],
  },
  {
    key: "storyCircle",
    rootChildren: [
      stageFolder("youInZone"),
      stageFolder("needWantDiscomfort"),
      stageFolder("unfamiliarSituation"),
      stageFolder("adaptationFunGames"),
      stageFolder("beginToWantMoreSelf"),
      stageFolder("familiar"),
      stageFolder("bigChangeTryFail"),
      stageFolder("returnChanged"),
    ],
  },
  {
    key: "twentyFour",
    rootChildren: Array.from({ length: 24 }, (_, i) => {
      const n = i + 1;
      return folder(`ch${n}`, [scene(`ch${n}Scene`)]);
    }),
  },
];

export function findTemplate(key: string): StructureTemplate | undefined {
  return STRUCTURE_TEMPLATES.find((t) => t.key === key);
}

/** テンプレート全体で生成される folder 数と scene 数を事前計算 */
export function countTemplateNodes(template: StructureTemplate): {
  folders: number;
  scenes: number;
} {
  let folders = 0;
  let scenes = 0;
  function walk(nodes: StructureNode[]): void {
    for (const node of nodes) {
      if (node.kind === "folder") {
        folders++;
        if (node.children) walk(node.children);
      } else {
        scenes++;
      }
    }
  }
  walk(template.rootChildren);
  return { folders, scenes };
}
