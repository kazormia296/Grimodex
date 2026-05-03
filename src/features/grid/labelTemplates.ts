export interface LabelTemplateItem {
  nameI18nKey: string; // key under grid.labelTemplates.labels.*
  paletteSlotIndex: number; // index into PALETTE_SLOTS
}

export interface LabelTemplate {
  key: string;
  nameI18nKey: string; // key under grid.labelTemplates.*
  labels: LabelTemplateItem[];
}

export const LABEL_TEMPLATES: LabelTemplate[] = [
  {
    key: "three_act",
    nameI18nKey: "threeAct",
    labels: [
      { nameI18nKey: "act1", paletteSlotIndex: 7 }, // sky
      { nameI18nKey: "act2", paletteSlotIndex: 8 }, // violet
      { nameI18nKey: "act3", paletteSlotIndex: 0 }, // red
    ],
  },
  {
    key: "kishoten",
    nameI18nKey: "kishoten",
    labels: [
      { nameI18nKey: "ki", paletteSlotIndex: 7 }, // sky
      { nameI18nKey: "sho", paletteSlotIndex: 5 }, // emerald
      { nameI18nKey: "ten", paletteSlotIndex: 2 }, // amber
      { nameI18nKey: "ketsu", paletteSlotIndex: 0 }, // red
    ],
  },
  {
    key: "freytag",
    nameI18nKey: "freytag",
    labels: [
      { nameI18nKey: "exposition", paletteSlotIndex: 7 }, // sky
      { nameI18nKey: "risingAction", paletteSlotIndex: 4 }, // lime
      { nameI18nKey: "climax", paletteSlotIndex: 2 }, // amber
      { nameI18nKey: "fallingAction", paletteSlotIndex: 1 }, // orange
      { nameI18nKey: "resolution", paletteSlotIndex: 0 }, // red
    ],
  },
  {
    key: "save_the_cat",
    nameI18nKey: "saveTheCat",
    labels: [
      { nameI18nKey: "openingImage", paletteSlotIndex: 7 },
      { nameI18nKey: "themeStated", paletteSlotIndex: 8 },
      { nameI18nKey: "setup", paletteSlotIndex: 7 },
      { nameI18nKey: "catalyst", paletteSlotIndex: 4 },
      { nameI18nKey: "debate", paletteSlotIndex: 3 },
      { nameI18nKey: "breakIntoTwo", paletteSlotIndex: 5 },
      { nameI18nKey: "bStory", paletteSlotIndex: 6 },
      { nameI18nKey: "funAndGames", paletteSlotIndex: 5 },
      { nameI18nKey: "midpoint", paletteSlotIndex: 2 },
      { nameI18nKey: "badGuysClose", paletteSlotIndex: 1 },
      { nameI18nKey: "allIsLost", paletteSlotIndex: 0 },
      { nameI18nKey: "darkNightOfSoul", paletteSlotIndex: 11 },
      { nameI18nKey: "breakIntoThree", paletteSlotIndex: 8 },
      { nameI18nKey: "finale", paletteSlotIndex: 9 },
      { nameI18nKey: "finalImage", paletteSlotIndex: 10 },
    ],
  },
  {
    key: "hero_journey",
    nameI18nKey: "heroJourney",
    labels: [
      { nameI18nKey: "ordinaryWorld", paletteSlotIndex: 7 },
      { nameI18nKey: "callToAdventure", paletteSlotIndex: 5 },
      { nameI18nKey: "refusal", paletteSlotIndex: 11 },
      { nameI18nKey: "meeting", paletteSlotIndex: 6 },
      { nameI18nKey: "crossingThreshold", paletteSlotIndex: 4 },
      { nameI18nKey: "testsAlliesEnemies", paletteSlotIndex: 3 },
      { nameI18nKey: "approach", paletteSlotIndex: 2 },
      { nameI18nKey: "ordeal", paletteSlotIndex: 1 },
      { nameI18nKey: "reward", paletteSlotIndex: 0 },
      { nameI18nKey: "roadBack", paletteSlotIndex: 9 },
      { nameI18nKey: "resurrection", paletteSlotIndex: 8 },
      { nameI18nKey: "returnWithElixir", paletteSlotIndex: 7 },
    ],
  },
  {
    key: "story_circle",
    nameI18nKey: "storyCircle",
    labels: [
      { nameI18nKey: "youInZone", paletteSlotIndex: 7 },
      { nameI18nKey: "needWantDiscomfort", paletteSlotIndex: 5 },
      { nameI18nKey: "unfamiliarSituation", paletteSlotIndex: 4 },
      { nameI18nKey: "adaptationFunGames", paletteSlotIndex: 3 },
      { nameI18nKey: "beginToWantMoreSelf", paletteSlotIndex: 2 },
      { nameI18nKey: "familiar", paletteSlotIndex: 1 },
      { nameI18nKey: "bigChangeTryFail", paletteSlotIndex: 0 },
      { nameI18nKey: "returnChanged", paletteSlotIndex: 8 },
    ],
  },
  {
    key: "twenty_four",
    nameI18nKey: "twentyFour",
    labels: [
      { nameI18nKey: "hook", paletteSlotIndex: 7 },
      { nameI18nKey: "ch1Setup", paletteSlotIndex: 7 },
      { nameI18nKey: "ch2Inciting", paletteSlotIndex: 5 },
      { nameI18nKey: "ch3React", paletteSlotIndex: 5 },
      { nameI18nKey: "ch4Act", paletteSlotIndex: 4 },
      { nameI18nKey: "ch5Consequence", paletteSlotIndex: 4 },
      { nameI18nKey: "ch6Pressure", paletteSlotIndex: 3 },
      { nameI18nKey: "ch7Pinch1", paletteSlotIndex: 2 },
      { nameI18nKey: "ch8Midpoint", paletteSlotIndex: 2 },
      { nameI18nKey: "ch9Rally", paletteSlotIndex: 4 },
      { nameI18nKey: "ch10Pinch2", paletteSlotIndex: 2 },
      { nameI18nKey: "ch11Setback", paletteSlotIndex: 1 },
      { nameI18nKey: "ch12Darkest", paletteSlotIndex: 0 },
      { nameI18nKey: "ch13Climax", paletteSlotIndex: 0 },
      { nameI18nKey: "ch14Resolution", paletteSlotIndex: 8 },
      { nameI18nKey: "ch15Denouement", paletteSlotIndex: 8 },
      { nameI18nKey: "ch16Aftermath", paletteSlotIndex: 9 },
      { nameI18nKey: "ch17NewNormal", paletteSlotIndex: 9 },
      { nameI18nKey: "ch18FinalChallenge", paletteSlotIndex: 1 },
      { nameI18nKey: "ch19TwistSetup", paletteSlotIndex: 2 },
      { nameI18nKey: "ch20Revelation", paletteSlotIndex: 2 },
      { nameI18nKey: "ch21Convergence", paletteSlotIndex: 0 },
      { nameI18nKey: "ch22LastStand", paletteSlotIndex: 0 },
      { nameI18nKey: "ch23CrisisResolved", paletteSlotIndex: 8 },
      { nameI18nKey: "ch24Epilogue", paletteSlotIndex: 7 },
    ],
  },
];
