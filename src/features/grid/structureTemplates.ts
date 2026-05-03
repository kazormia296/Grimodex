/**
 * 構造テンプレート定義
 *
 * Apply structure template ▸ で適用する。
 * `rootChildren` を現在のコンテナ直下に直置きで展開し、各 placeholder scene には
 * その段階の説明文（synopsis）を初期値として埋める。
 *
 * i18n キー設計:
 *   grid.structureTemplates.{templateKey}.name
 *   grid.structureTemplates.{templateKey}.stages.{stageKey}.name
 *   grid.structureTemplates.{templateKey}.stages.{stageKey}.synopsis  (sceneのみ)
 */

export type StructureNodeKind = "folder" | "scene";

export interface StructureNode {
  kind: StructureNodeKind;
  /** i18n stage key under grid.structureTemplates.{templateKey}.stages */
  stage: string;
  /** kind === "folder" のときのみ。再帰可 */
  children?: StructureNode[];
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
        scene("openingImage"),
        scene("themeStated"),
        scene("setup"),
        scene("catalyst"),
        scene("debate"),
      ]),
      folder("act2", [
        scene("breakIntoTwo"),
        scene("bStory"),
        scene("funAndGames"),
        scene("midpoint"),
        scene("badGuysClose"),
        scene("allIsLost"),
        scene("darkNightOfSoul"),
        scene("breakIntoThree"),
      ]),
      folder("act3", [scene("finale"), scene("finalImage")]),
    ],
  },
  {
    key: "heroJourney",
    rootChildren: [
      folder("departure", [
        scene("ordinaryWorld"),
        scene("callToAdventure"),
        scene("refusal"),
        scene("meeting"),
        scene("crossingThreshold"),
      ]),
      folder("initiation", [
        scene("testsAlliesEnemies"),
        scene("approach"),
        scene("ordeal"),
        scene("reward"),
      ]),
      folder("returnAct", [
        scene("roadBack"),
        scene("resurrection"),
        scene("returnWithElixir"),
      ]),
    ],
  },
  {
    key: "storyCircle",
    rootChildren: [
      scene("youInZone"),
      scene("needWantDiscomfort"),
      scene("unfamiliarSituation"),
      scene("adaptationFunGames"),
      scene("beginToWantMoreSelf"),
      scene("familiar"),
      scene("bigChangeTryFail"),
      scene("returnChanged"),
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
