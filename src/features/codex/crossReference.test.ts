import { describe, it, expect } from "vitest";
import {
  buildCrossReferenceFromMentionRows,
  buildCrossReferenceFromTexts,
} from "./crossReference";

describe("buildCrossReferenceFromTexts", () => {
  const entries = [
    { id: "codex-1", name: "太郎", type: "character" },
    { id: "codex-2", name: "花子", type: "character" },
    { id: "codex-3", name: "魔法の森", type: "location" },
  ];

  it("finds entries mentioned in scene texts", () => {
    const scenes = [
      { id: "s1", title: "シーン1", content: "太郎は魔法の森に向かった。" },
      {
        id: "s2",
        title: "シーン2",
        content: "花子と太郎は再び魔法の森で会った。太郎は驚いた。",
      },
    ];

    const result = buildCrossReferenceFromTexts(entries, scenes);

    const taro = result.find((r) => r.entryName === "太郎");
    expect(taro).toBeDefined();
    expect(taro!.scenes).toHaveLength(2);
    expect(taro!.scenes.find((s) => s.sceneId === "s1")?.count).toBe(1);
    expect(taro!.scenes.find((s) => s.sceneId === "s2")?.count).toBe(2);

    const hanako = result.find((r) => r.entryName === "花子");
    expect(hanako).toBeDefined();
    expect(hanako!.scenes).toHaveLength(1);

    const forest = result.find((r) => r.entryName === "魔法の森");
    expect(forest).toBeDefined();
    expect(forest!.scenes).toHaveLength(2);
  });

  it("returns empty for no entries", () => {
    const result = buildCrossReferenceFromTexts(
      [],
      [{ id: "s1", title: "シーン1", content: "テスト" }],
    );
    expect(result).toEqual([]);
  });

  it("returns empty for empty scene content", () => {
    const result = buildCrossReferenceFromTexts(entries, [
      { id: "s1", title: "シーン1", content: "" },
    ]);
    expect(result).toEqual([]);
  });

  it("sorts results by entry name", () => {
    const scenes = [
      {
        id: "s1",
        title: "シーン1",
        content: "花子と太郎と魔法の森",
      },
    ];
    const result = buildCrossReferenceFromTexts(entries, scenes);
    const names = result.map((r) => r.entryName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("reports semantic-only links even when the Codex name is absent", () => {
    const result = buildCrossReferenceFromTexts(entries, [
      {
        id: "s1",
        title: "シーン1",
        content: "彼女は振り返った。",
        semanticLinks: [
          { entryId: "codex-2", label: "花子", text: "彼女" },
        ],
      },
    ]);

    expect(result.find((entry) => entry.entryId === "codex-2")?.scenes).toEqual(
      [
        {
          sceneId: "s1",
          sceneTitle: "シーン1",
          count: 1,
          automaticCount: 0,
          semanticCount: 1,
        },
      ],
    );
  });

  it("keeps automatic and semantic occurrence counts independent", () => {
    const result = buildCrossReferenceFromTexts(entries, [
      {
        id: "s1",
        title: "シーン1",
        content: "花子は花子と呼ばれた。",
        semanticLinks: [
          { entryId: "codex-2", label: "花子", text: "彼女" },
          { entryId: "codex-2", label: "花子", text: "あの人" },
        ],
      },
    ]);

    expect(
      result.find((entry) => entry.entryId === "codex-2")?.scenes[0],
    ).toEqual({
      sceneId: "s1",
      sceneTitle: "シーン1",
      count: 4,
      automaticCount: 2,
      semanticCount: 2,
    });
  });

  it("ignores semantic links to missing Codex entries", () => {
    const result = buildCrossReferenceFromTexts(entries, [
      {
        id: "s1",
        title: "シーン1",
        content: "本文",
        semanticLinks: [
          { entryId: "deleted-entry", label: "削除済み", text: "彼女" },
        ],
      },
    ]);

    expect(result).toEqual([]);
  });
});

describe("buildCrossReferenceFromMentionRows", () => {
  const mentionEntries = [
    {
      id: "codex-1",
      name: "太郎",
      type: "character",
      aliases: null,
      excludedAliases: null,
    },
    {
      id: "codex-2",
      name: "花子",
      type: "character",
      aliases: null,
      excludedAliases: null,
    },
  ];

  it("builds scene links from the incremental mention index without duplicate edges", () => {
    const result = buildCrossReferenceFromMentionRows(mentionEntries, [
      { entryId: "codex-1", sceneId: "s1", sceneTitle: "シーン1" },
      { entryId: "codex-1", sceneId: "s1", sceneTitle: "シーン1" },
      { entryId: "codex-1", sceneId: "s2", sceneTitle: "シーン2" },
    ]);

    expect(result.find((entry) => entry.entryId === "codex-1")?.scenes).toEqual(
      [
        { sceneId: "s1", sceneTitle: "シーン1", count: 1 },
        { sceneId: "s2", sceneTitle: "シーン2", count: 1 },
      ],
    );
    expect(result.find((entry) => entry.entryId === "codex-2")?.scenes).toEqual(
      [],
    );
  });

  it("deduplicates body and semantic cache rows into one Galaxy edge", () => {
    const result = buildCrossReferenceFromMentionRows(mentionEntries, [
      {
        entryId: "codex-1",
        sceneId: "s1",
        sceneTitle: "シーン1",
        source: "body",
      },
      {
        entryId: "codex-1",
        sceneId: "s1",
        sceneTitle: "シーン1",
        source: "semantic",
      },
    ]);

    expect(result.find((entry) => entry.entryId === "codex-1")?.scenes).toEqual(
      [{ sceneId: "s1", sceneTitle: "シーン1", count: 1 }],
    );
  });
});
