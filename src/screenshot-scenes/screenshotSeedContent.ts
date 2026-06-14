/**
 * LP／マーケ用 撮影ステージのデモ・コンテンツ（言語別の唯一の正本）。
 *
 * - DB シード本体は `src/lib/browser-mock.ts` の seedScreenshotWorkspace /
 *   getScreenshotAnnotations / getScreenshotTrashItems が消費する。
 * - 校閲（lint）／疑似コメントのデモ状態は
 *   `src/screenshot-scenes/screenshotBootstrap.ts` が消費する。
 *
 * 言語非依存な値（ID・色・sort_order・status・タイムスタンプ・モデル名など）は
 * 各シード側ロジックに残し、ここには **翻訳が要る文字列と、それに紐づく位置情報
 * （ProseMirror 位置 / 文字オフセット）だけ** を置く。新言語を足すときはこの
 * Record にエントリを追加するだけで全サーフェスに行き渡る。
 *
 * 位置情報の規約:
 * - authorship.* / foreshadow setup.fromPos/toPos は **ProseMirror 位置**
 *   （proseDoc の段落構造に依存。本文を変えたら再計算が必要）。
 * - annotations.*.rangeStart/rangeEnd は近似ヒント。実ハイライトは textSnapshot
 *   から resolveAnnotationRange で再解決されるため、textSnapshot は本文の実在
 *   部分文字列であること。
 * - lint.diag*.rangeStart/rangeEnd は lastSceneText 上の文字オフセット。
 */
import type { ScreenshotLanguage } from "./screenshotMode";

export interface ScreenshotCodexContent {
  name: string;
  summary: string;
  tagName: string;
}

export interface ScreenshotSnippetContent {
  title: string;
  /** proseDoc に渡す段落配列 */
  body: string[];
  tagName: string;
}

export interface ScreenshotSceneContent {
  title: string;
  synopsis: string;
  storyTimeLabel: string;
  /** proseDoc に渡す段落配列 */
  body: string[];
  /** charCountForBody 相当（text ノード長の総和） */
  charCount: number;
}

export interface ScreenshotAnnotationContent {
  rangeStart: number;
  rangeEnd: number;
  textSnapshot: string;
  content: string;
  foundText: string;
  foundContext: string;
  llmReason: string;
  dismissKey: string;
}

export interface ScreenshotLintContent {
  /** 校閲対象のプレーンテキスト（lint range はこの文字列上のオフセット） */
  lastSceneText: string;
  diag1: {
    ruleId: string;
    message: string;
    fixLabel: string;
    fixReplacement: string;
    rangeStart: number;
    rangeEnd: number;
  };
  diag2: {
    ruleId: string;
    message: string;
    rangeStart: number;
    rangeEnd: number;
  };
}

export interface ScreenshotSeedContent {
  project: {
    title: string;
    genre: string;
    pov: string;
    tense: string;
    styleGuide: string;
    aiInstructions: string;
  };
  chapter: { title: string; synopsis: string };
  scenes: {
    scene1: ScreenshotSceneContent;
    scene2: ScreenshotSceneContent;
    scene3: ScreenshotSceneContent;
  };
  codex: {
    akane: ScreenshotCodexContent;
    otowa: ScreenshotCodexContent;
    haisha: ScreenshotCodexContent;
    akahimo: ScreenshotCodexContent;
    akanawa: ScreenshotCodexContent;
  };
  labels: { ki: string; important: string; consider: string };
  snippets: {
    restraint: ScreenshotSnippetContent;
    reunion: ScreenshotSnippetContent;
  };
  map: { edge1Label: string; edge2Label: string; frameTitle: string };
  foreshadows: {
    warmth: { title: string; intent: string; notes: string };
    visitor: { title: string; intent: string; notes: string };
    setupWarmth: { fromPos: number; toPos: number; aiReasoning: string };
    setupLock: { fromPos: number; toPos: number; aiReasoning: string };
  };
  chat: { sessionTitle: string; userMsg: string; assistantMsg: string };
  authorship: {
    scene1: { humanTo: number; aiTo: number; unknownTo: number };
    scene2: { humanTo: number };
    scene3: { aiTo: number };
  };
  annotations: {
    /** 整合性エラー（item の物理状態が設定と矛盾） */
    compassDry: ScreenshotAnnotationContent & {
      persona: string;
      entryName: string;
      expectedValue: string;
      foundValue: string;
    };
    /** 能力未登録の警告 */
    foreignMemory: ScreenshotAnnotationContent;
  };
  trash: {
    sceneDraft: {
      previewText: string;
      title: string;
      body: string[];
      synopsis: string;
      folderHintName: string;
      storyTimeLabel: string;
      charCount: number;
    };
    textFragment: { previewText: string; text: string; charCount: number };
  };
  lint: ScreenshotLintContent;
}

const ja: ScreenshotSeedContent = {
  project: {
    title: "朱の記憶",
    genre: "和風ダークファンタジー",
    pov: "三人称限定視点",
    tense: "過去形",
    styleGuide:
      "簡潔で鋭い文体を心がける。情景描写は短く、感情は行動と所作で示す。",
    aiInstructions:
      "和風ダークファンタジーの執筆補助。設定の一貫性と人物の動機を重視する。",
  },
  chapter: {
    title: "第一部：帰還",
    synopsis: "朱音が十年ぶりに故郷へ戻り、廃社と朱紐に再会する。",
  },
  scenes: {
    scene1: {
      title: "一章：廃社",
      synopsis:
        "雨の夜、朱音は十年ぶりに故郷の廃社へ帰る。祭壇には十年前に置いてきた朱紐が残っていた。",
      storyTimeLabel: "雨の夜",
      body: [
        "朱音は鳥居の手前で立ち止まった。十年ぶりだった。",
        "廃社は思っていたより小さかった。記憶の中では鬱蒼とした杉に囲まれた大きな建物だったが、今は雨に濡れた骨組みのように見えた。",
        "拝殿の扉には鍵がかかっていなかった。朱音は錠前を拾い上げ、しばらく眺めてから、元の場所に置いた。",
        "祭壇の奥に、赤いものがあった。朱紐だった。",
        "朱紐は乾いていた。雨ざらしのはずなのに、濡れていなかった。指が触れた瞬間、記憶が来た。朱音自身の記憶ではなかった。",
      ],
      charCount: 186,
    },
    scene2: {
      title: "二章：封じ文",
      synopsis:
        "廃社で朱紐とともに封じ文を見つける。朱音の名と「帰れ」の二文字が書かれている。",
      storyTimeLabel: "翌朝",
      body: [
        "廃社のシーンの翌朝。朱音は拝殿で目を覚ます。朱紐は手の中にある。",
        "封じ文は朱紐の下に置かれていた。紙は十年経っても黄ばんでいない。",
        "音羽が来る。「やっぱり来たか」と言って、饅頭を差し出す。それだけ。",
      ],
      charCount: 92,
    },
    scene3: {
      title: "回想：火の夜",
      synopsis:
        "十年前の夏の夜、廃社が燃えた。朱音はその場にいた。忘れられた声が残っている。",
      storyTimeLabel: "十年前",
      body: [
        "火は社の内側から出ていた。",
        "「離れろ」という声がした。誰の声か、朱音は今も思い出せない。",
        "朱音は走った。朱紐を手に、ただ走った。",
      ],
      charCount: 73,
    },
  },
  codex: {
    akane: {
      name: "朱音",
      summary:
        "朱紐を操る一族の最後の生き残り。十年間、都で記録師として生きてきた。故郷の廃社が燃えたという知らせを受け、十年ぶりに桐野へ帰る。",
      tagName: "主人公",
    },
    otowa: {
      name: "音羽",
      summary:
        "朱音の幼なじみ。今は桐野で薬師をしている。十年間、朱音が帰ってくるのを待っていた。",
      tagName: "協力者",
    },
    haisha: {
      name: "桐野の廃社",
      summary:
        "朱音の一族が代々守ってきた山中の社。十年前の火事で本殿が焼け、祭壇には朱音が置いていった朱紐が残っていた。",
      tagName: "舞台",
    },
    akahimo: {
      name: "朱紐",
      summary:
        "朱音の一族が代々受け継いできた赤い紐。鬼を縛り、記憶を封じる力がある。朱音が十年前に廃社の祭壇に置いていったもの。",
      tagName: "呪術",
    },
    akanawa: {
      name: "朱縄の儀",
      summary:
        "朱音の一族が百年以上行ってきた鬼封じの儀式。朱紐を使い、鬼の記憶ごと封じ込める。",
      tagName: "呪術",
    },
  },
  labels: { ki: "起", important: "重要", consider: "検討中" },
  snippets: {
    restraint: {
      title: "朱音の律し方",
      body: [
        "鳥居をくぐるとき、朱音は一度だけ足を止めた。止まった理由を自分では説明できなかった。",
      ],
      tagName: "語り口",
    },
    reunion: {
      title: "朱紐、再会",
      body: [
        "朱紐は乾いていた。雨ざらしのはずなのに、濡れていなかった。",
        "指が触れた瞬間、記憶が来た。朱音自身の記憶ではなかった。",
      ],
      tagName: "朱紐",
    },
  },
  map: { edge1Label: "帰還", edge2Label: "発見", frameTitle: "第一部：帰還" },
  foreshadows: {
    warmth: {
      title: "朱紐の温もり",
      intent: "十年経っても朱紐が乾いたままだった事実を後の章で回収する。",
      notes: "朱紐が朱音を待っていた／意思を持つ設定の伏線。",
    },
    visitor: {
      title: "廃社の侵入者",
      intent: "拝殿の錠前が落ちていた事実を、十年前以降の出入りの証拠にする。",
      notes: "朱鬼または別の誰かが廃社へ出入りしている。",
    },
    setupWarmth: {
      fromPos: 30,
      toPos: 52,
      aiReasoning: "読者が違和感として覚えやすい具体物になっている。",
    },
    setupLock: {
      fromPos: 18,
      toPos: 29,
      aiReasoning: "証拠としては弱いため後続で補強が必要。",
    },
  },
  chat: {
    sessionTitle: "朱音の語り口について",
    userMsg:
      "一章の冒頭を書いたのですが、朱音の語り口がまだ定まっていません。彼女は感情を抑える人間なので、地の文でも感情が直接出てこないようにしたいです。",
    assistantMsg:
      "鳥居をくぐるとき、朱音は一度だけ足を止めた。止まった理由を自分では説明できなかった。草の匂いがした。杉の木が揺れた。それだけのことで、先に進めなくなった。感情の名前を出さずに、「三つ数えてから」という行動で内面の動揺を示す方向が合います。",
  },
  authorship: {
    scene1: { humanTo: 95, aiTo: 168, unknownTo: 186 },
    scene2: { humanTo: 45 },
    scene3: { aiTo: 30 },
  },
  annotations: {
    compassDry: {
      rangeStart: 130,
      rangeEnd: 150,
      textSnapshot: "朱紐は乾いていた",
      persona: "整合性チェック",
      content:
        "Codexでは朱紐は雨に濡れると墨のように黒ずむ設定ですが、このシーンでは雨ざらしのまま乾いています。",
      entryName: "朱紐",
      expectedValue: "雨に濡れると黒ずむ",
      foundValue: "雨ざらしでも乾いている",
      foundText: "朱紐は乾いていた",
      foundContext:
        "朱紐は乾いていた。雨ざらしのはずなのに、濡れていなかった。",
      llmReason:
        "物理的な状態が設定と逆になっており、読者が意図的な異常かミスか判別できないため。",
      dismissKey: "codex-akahimo:wetness:scene-1",
    },
    foreignMemory: {
      rangeStart: 151,
      rangeEnd: 180,
      textSnapshot: "朱音自身の記憶ではなかった",
      content:
        "朱音が他者の記憶を受け取る能力は、この時点のCodexには未登録です。能力として採用するなら設定項目を追加してください。",
      foundText: "朱音自身の記憶ではなかった",
      foundContext: "指が触れた瞬間、記憶が来た。朱音自身の記憶ではなかった。",
      llmReason:
        "キャラクター能力として重要な変化だが、人物設定と儀式設定のどちらにも明示がないため。",
      dismissKey: "akane:foreign-memory:scene-1",
    },
  },
  trash: {
    sceneDraft: {
      previewText: "旧稿：火の夜の導入",
      title: "旧稿：火の夜の導入",
      body: ["火はまだ見えなかった。ただ、煙だけが山を降りてきていた。"],
      synopsis: "回想章の没導入。",
      folderHintName: "第一部：帰還",
      storyTimeLabel: "十年前",
      charCount: 28,
    },
    textFragment: {
      previewText: "朱音は泣きそうになった、という説明的な一文",
      text: "朱音は泣きそうになった、という説明的な一文",
      charCount: 23,
    },
  },
  lint: {
    lastSceneText:
      "朱音は鳥居の手前で立ち止まった。十年ぶりだった。廃社は思っていたより小さかった。祭壇の奥に、赤いものがあった。朱紐だった。",
    diag1: {
      ruleId: "ja/sentence-too-long",
      message: "一文が長く、情景と行動が同じ段落に詰まっています",
      fixLabel: "二文に分ける",
      fixReplacement:
        "廃社は思っていたより小さかった。記憶の中では鬱蒼とした杉に囲まれていた。",
      rangeStart: 28,
      rangeEnd: 86,
    },
    diag2: {
      ruleId: "ja/ambiguous-subject",
      message: "記憶が誰のものか、直前の文だけでは曖昧です",
      rangeStart: 148,
      rangeEnd: 166,
    },
  },
};

const en: ScreenshotSeedContent = {
  project: {
    title: "The Iron Crown",
    genre: "Dark Fantasy",
    pov: "Third person limited",
    tense: "Past",
    styleGuide:
      "Clear, sharp prose. Keep description brief; show emotion through action and gesture rather than naming it.",
    aiInstructions:
      "Assist with a dark fantasy novel. Keep the world consistent and the characters' motives clear.",
  },
  chapter: {
    title: "Part One: The Return",
    synopsis:
      "Eleanor returns to Greymoor after ten years and meets the ruined hall and the compass again.",
  },
  scenes: {
    scene1: {
      title: "Chapter One: The Hall",
      synopsis:
        "On a night of rain, Eleanor returns to the ruined Ashveil Hall for the first time in ten years. On the hearthstone, the compass she left behind still lies.",
      storyTimeLabel: "A night of rain",
      body: [
        "Eleanor stopped a few paces short of the gate. It had been ten years.",
        "The hall was smaller than she remembered. In her memory it had been a great dark house ringed by old elms; now it was a half-collapsed shell, wet to the bone with rain.",
        "The door to the keeping-room was not locked. There had been a lock, but it had fallen, hasp and all. Eleanor picked it up, turned it over, and set it back where it had lain.",
        "Something had been left on the old hearthstone. A compass.",
        "The compass was dry. It had been left to ten years of rain, and it was not wet. The moment her finger touched it, the memory came. It was not her own memory.",
      ],
      charCount: 625,
    },
    scene2: {
      title: "Chapter Two: The Writ",
      synopsis:
        "At the hall, with the compass, Eleanor finds the sealed writ. Her name is on it, and the two words 'Come back.'",
      storyTimeLabel: "The next morning",
      body: [
        "The morning after the hall. Eleanor wakes in the keeping-room. The compass is in her hand.",
        "The sealed writ had lain under the compass. The paper has not yellowed in ten years.",
        'Wrenna arrives. "So you came after all," she says, and holds out a wrapped parcel. That is all.',
      ],
      charCount: 269,
    },
    scene3: {
      title: "Memory: The Night of the Fire",
      synopsis:
        "Ten years ago, on a summer night, the hall burned. Eleanor was there. A forgotten voice still remains.",
      storyTimeLabel: "Ten years ago",
      body: [
        "The fire came from inside the house.",
        '"Get back," a voice said. Whose voice it was, Eleanor still cannot say.',
        "She ran. The compass in her hand, she simply ran.",
      ],
      charCount: 156,
    },
  },
  codex: {
    akane: {
      name: "Eleanor Ashveil",
      summary:
        "The last of a line that kept the Sundering Rite. For ten years she has lived in Ironhaven as a quiet archivist. Word that her family hall has burned sends her back to Greymoor for the first time in a decade.",
      tagName: "Protagonist",
    },
    otowa: {
      name: "Wrenna Cole",
      summary:
        "Eleanor's old friend, now a healer and keeper of the records at Greymoor. She waited ten years for Eleanor to come back. She will not admit that she waited.",
      tagName: "Ally",
    },
    haisha: {
      name: "Ashveil Hall",
      summary:
        "The Ashveil seat in the hills, kept by Eleanor's line for generations. The east wing burned ten years ago and was never rebuilt. On the old hearthstone, the compass Eleanor left behind still lay.",
      tagName: "Setting",
    },
    akahimo: {
      name: "Aldric's Compass",
      summary:
        "A compass handed down in Eleanor's line. It binds a Hollow and holds memory. Eleanor left it on the hall's hearthstone ten years ago. 'It will always find your blood.'",
      tagName: "Arcane",
    },
    akanawa: {
      name: "The Sundering Rite",
      summary:
        "The Hollow-binding rite Eleanor's line has worked for over a century. Using the compass, it seals a Hollow together with its memory. The last full working failed ten years ago.",
      tagName: "Arcane",
    },
  },
  labels: { ki: "Opening", important: "Key", consider: "Considering" },
  snippets: {
    restraint: {
      title: "How Eleanor Steadies Herself",
      body: [
        "At the gate, Eleanor stopped once. She could not have said why she stopped. There was the smell of grass. An elm moved. For nothing more than that, she could not go on.",
      ],
      tagName: "Voice",
    },
    reunion: {
      title: "The Compass, Again",
      body: [
        "The compass was dry. It had been left to ten years of rain, and it was not wet.",
        "The moment her finger touched it, the memory came. It was not her own memory.",
      ],
      tagName: "Compass",
    },
  },
  map: {
    edge1Label: "Return",
    edge2Label: "Discovery",
    frameTitle: "Part One: The Return",
  },
  foreshadows: {
    warmth: {
      title: "The Compass Stays True",
      intent:
        "Pay off the fact that the compass stayed dry for ten years — the setup for 'the compass was waiting for Eleanor / has a will of its own.'",
      notes:
        "Foreshadows that the compass waited for Eleanor and has a will of its own.",
    },
    visitor: {
      title: "The Intruder at the Hall",
      intent:
        "Make the fallen lock function as proof that someone has been coming to the hall since the fire ten years ago.",
      notes: "The Hollow, or someone else, has been entering the hall.",
    },
    setupWarmth: {
      fromPos: 477,
      toPos: 496,
      aiReasoning:
        "A concrete detail the reader is likely to register as strange.",
    },
    setupLock: {
      fromPos: 314,
      toPos: 341,
      aiReasoning: "Weak as evidence on its own; needs reinforcing later.",
    },
  },
  chat: {
    sessionTitle: "Developing Eleanor's voice",
    userMsg:
      "I've written the opening of chapter one, but Eleanor's voice still isn't set. She holds her feelings in, so I want even the narration to keep emotion from surfacing directly.",
    assistantMsg:
      "At the gate, Eleanor stopped once. She could not have said why she stopped. There was the smell of grass. An elm moved. For nothing more than that, she could not go on. She counted to three, and began to walk again. It shows the inner shake through the action ('counted to three') without naming the feeling, and reads her as someone who governs herself.",
  },
  authorship: {
    scene1: { humanTo: 330, aiTo: 558, unknownTo: 634 },
    scene2: { humanTo: 137 },
    scene3: { aiTo: 72 },
  },
  annotations: {
    compassDry: {
      rangeStart: 472,
      rangeEnd: 491,
      textSnapshot: "The compass was dry",
      persona: "Consistency check",
      content:
        "The codex notes that Aldric's Compass clouds and stalls in the damp, yet in this scene it has weathered ten years of rain and stays dry and true.",
      entryName: "Aldric's Compass",
      expectedValue: "Clouds and stalls in the damp",
      foundValue: "Dry and true after ten years of rain",
      foundText: "The compass was dry",
      foundContext:
        "The compass was dry. It had been left to ten years of rain, and it was not wet.",
      llmReason:
        "The object's physical state runs opposite to the established setting, so the reader cannot tell whether it is a deliberate anomaly or a mistake.",
      dismissKey: "codex-akahimo:wetness:scene-1",
    },
    foreignMemory: {
      rangeStart: 603,
      rangeEnd: 628,
      textSnapshot: "It was not her own memory",
      content:
        "Eleanor receiving another's memory on touching the compass is not yet registered as an ability in the codex. If you keep it, add it to her character setting.",
      foundText: "It was not her own memory",
      foundContext:
        "The moment her finger touched it, the memory came. It was not her own memory.",
      llmReason:
        "An important change to the character's abilities, but it is stated in neither the character nor the rite setting.",
      dismissKey: "akane:foreign-memory:scene-1",
    },
  },
  trash: {
    sceneDraft: {
      previewText: "Old draft: opening of the fire night",
      title: "Old draft: opening of the fire night",
      body: [
        "The fire was not yet visible. Only the smoke came down the hills.",
      ],
      synopsis: "A cut opening for the flashback chapter.",
      folderHintName: "Part One: The Return",
      storyTimeLabel: "Ten years ago",
      charCount: 65,
    },
    textFragment: {
      previewText: "Eleanor almost wept — an over-explained line.",
      text: "Eleanor almost wept — an over-explained line.",
      charCount: 45,
    },
  },
  lint: {
    lastSceneText:
      "Eleanor stopped a few paces short of the gate. It had been ten years. The hall was smaller than she remembered, a great dark house in her memory but now a half-collapsed shell wet to the bone with rain. The compass was dry. The moment her finger touched it, the memory came, and it was not her own.",
    diag1: {
      ruleId: "en/sentence-too-long",
      message:
        "This sentence runs long; scene and action are packed into a single breath.",
      fixLabel: "Split into two sentences",
      fixReplacement:
        "The hall was smaller than she remembered. In her memory it had been a great dark house, but now it was a half-collapsed shell.",
      rangeStart: 70,
      rangeEnd: 202,
    },
    diag2: {
      ruleId: "en/ambiguous-subject",
      message:
        "Whose memory this is cannot be told from the preceding sentence alone.",
      rangeStart: 279,
      rangeEnd: 297,
    },
  },
};

export const SCREENSHOT_SEED_CONTENT: Record<
  ScreenshotLanguage,
  ScreenshotSeedContent
> = { ja, en };
