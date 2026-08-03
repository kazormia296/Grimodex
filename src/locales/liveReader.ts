import i18next from "@/lib/i18n";

const LIVE_READER_TRANSLATIONS = {
  ja: {
    settings: {
      ai: {
        roleModel: {
          reader: {
            label: "読者コメント",
            description:
              "本文を読む最中のリアルタイム／擬似コメント。短い反応を返す JSON 出力が必要。",
          },
        },
        liveReader: {
          title: "リアルタイム読者コメント",
          triggerMode: "発火条件",
          triggerModeDesc:
            "本文の追記をどのタイミングで読者コメント生成へ送るかを選びます。リアルタイム読者コメント自体は校閲パネルからONにします。",
          modeCharacters: "文字数＋文末",
          modeSentence: "文末（。！？）",
          modeParagraph: "段落末（改行）",
          modeIdle: "入力停止後",
          threshold: "最小追記文字数",
          thresholdDesc:
            "「文字数＋文末」選択時に使用します。小さくすると生成頻度が上がります。",
          charsUnit: "字",
        },
      },
    },
    kouetsu: {
      comments: {
        liveReader: "本文入力に併せて生成",
        liveReaderHelp:
          "本文の追記を検知し、Settingsで設定した発火条件に達すると読者コメントを生成します。生成済みコメントはこのスイッチをOFFにしても削除されません。",
        liveReaderRunning: "リアルタイム読者コメントを生成中",
        sortLabel: "コメントの並び順",
        sortNewest: "新しい順",
        sortOldest: "古い順",
        sortScene: "シーン順",
      },
    },
  },
  en: {
    settings: {
      ai: {
        roleModel: {
          reader: {
            label: "Reader comments",
            description:
              "In-the-moment and pseudo reader comments. Requires concise structured JSON output.",
          },
        },
        liveReader: {
          title: "Live reader comments",
          triggerMode: "Trigger",
          triggerModeDesc:
            "Choose when appended text is sent for reader-comment generation. Enable live reader comments from the Kouetsu comments panel.",
          modeCharacters: "Character count + sentence end",
          modeSentence: "Sentence end",
          modeParagraph: "Paragraph end",
          modeIdle: "After typing stops",
          threshold: "Minimum appended characters",
          thresholdDesc:
            "Used only with “Character count + sentence end”. Lower values generate comments more often.",
          charsUnit: "chars",
        },
      },
    },
    kouetsu: {
      comments: {
        liveReader: "Generate with body input",
        liveReaderHelp:
          "When enabled, appended body text is sent for reader-comment generation once the trigger condition configured in Settings is reached. Existing comments are not deleted when this switch is turned off.",
        liveReaderRunning: "Generating live reader comments",
        sortLabel: "Comment sort order",
        sortNewest: "Newest first",
        sortOldest: "Oldest first",
        sortScene: "Scene order",
      },
    },
  },
} as const;

let installed = false;

/** Register translations only when a live-reader surface is loaded. */
export function ensureLiveReaderTranslations(): void {
  if (installed) return;

  for (const [language, translation] of Object.entries(
    LIVE_READER_TRANSLATIONS,
  )) {
    i18next.addResourceBundle(language, "translation", translation, true, true);
  }
  installed = true;
}
