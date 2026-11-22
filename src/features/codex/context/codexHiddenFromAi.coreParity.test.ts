import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-8a：renderer の `resolveCodexForAi`（legacy）と、read core の
 * `resolveCodexAiVisibility`・`listHiddenCodexIds`（renderer の fake db と、`listPhasesByEntryIds`・
 * `usePhaseStore` を呼ぶ port の上）が、同じ入力で同じ hidden・texts を返すことを見張る。
 * 判定の純関数は共有だが、読みの半分（id の重複除去・DB に無い id は hidden・早期 return）は legacy と core の
 * 2 か所に残っているので、そのずれをここで検出する（DR-MP4-39）。
 *
 * `toolExecutors.codexHidden.test.ts` と同じ fake：where を解釈しない db（列の key を投影する）と、
 * `phaseApi` の mock。fixture は、同じ時刻・同じ場面の Phase の同順位（id の `localeCompare` で決まる）も含む。
 */

interface FakeEntry {
  id: string;
  summary: string | null;
  content: string;
  contextMode: string;
}

const h = vi.hoisted(() => ({
  entries: [] as FakeEntry[],
  phases: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: async (ids: string[]) =>
    h.phases.filter((p) => ids.includes(String(p["entryId"]))),
  listDetailOverridesByPhaseIds: async () => [],
}));
vi.mock("@/db/client", async () => {
  const { codexEntries } = await import("@/db/schema");
  const query = (cols: Record<string, unknown> | undefined) => {
    let table: unknown;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: () => chain,
      then: (
        resolve: (v: unknown[]) => unknown,
        reject: (r: unknown) => unknown,
      ) =>
        Promise.resolve(
          table === codexEntries
            ? h.entries.map((entry) => {
                if (!cols) return { ...entry };
                const row: Record<string, unknown> = {};
                for (const key of Object.keys(cols)) {
                  row[key] = (entry as unknown as Record<string, unknown>)[key];
                }
                return row;
              })
            : [],
        ).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select: query } };
});

import { db } from "@/db/client";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { listPhasesByEntryIds } from "@/features/codex/phaseApi";
import type { TreeNodeData } from "@/features/tree/types";
import type { CoreReadDb } from "@/../electron/shared/mastraRead/ports";
import type { CoreCodexVisibilityPorts } from "@/../electron/shared/mastraRead/ports";
import {
  listHiddenCodexIds,
  resolveCodexAiVisibility,
} from "@/../electron/shared/readDomain/core/codexVisibility";
import { buildSceneTimeIndex } from "./sceneTimeIndex";
import { resolveCodexForAi } from "./codexHiddenFromAi";

const NOW = "2026-01-01T00:00:00.000Z";

const scene = (
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null,
): TreeNodeData =>
  ({
    id,
    projectId: "p",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as TreeNodeData;

const entry = (id: string, contextMode: string): FakeEntry => ({
  id,
  summary: `${id} 要約`,
  content: `${id} 本文`,
  contextMode,
});

const phase = (
  id: string,
  entryId: string,
  anchorNodeId: string,
  contextModeOverride: string | null,
  over: Record<string, unknown> = {},
) => ({
  id,
  entryId,
  anchorNodeId,
  label: id,
  summaryOverride: null,
  contentOverride: null,
  contextModeOverride,
  createdAt: NOW,
  updatedAt: NOW,
  version: 0,
  ...over,
});

/** renderer の ctx と同じ形の port（`getPhaseState` は live の store を呼出し時に読む）。 */
const RENDERER_PORTS: CoreCodexVisibilityPorts = {
  getDb: () => db as unknown as CoreReadDb,
  getPhaseState: () => {
    const { sceneTimeIndex, resolutionMode } = usePhaseStore.getState();
    return {
      sceneTimeIndex,
      resolutionMode: { kind: "resolved", mode: resolutionMode },
    };
  },
  codex: { listPhases: (ids) => listPhasesByEntryIds([...ids]) },
};

const IDS = [
  "pub",
  "hid",
  "rel",
  "hide-later",
  "story-hide",
  "tie",
  "plain-text",
  "gone",
  "pub",
];

beforeEach(() => {
  h.entries = [
    entry("pub", "mentioned"),
    entry("hid", "hidden"),
    entry("rel", "hidden"),
    entry("hide-later", "mentioned"),
    entry("story-hide", "mentioned"),
    entry("tie", "hidden"),
    entry("plain-text", "mentioned"),
  ];
  h.phases = [
    phase("ph-rel", "rel", "s2", "mentioned", {
      summaryOverride: "解除後の要約",
      contentOverride: "解除後の本文",
    }),
    phase("ph-hide", "hide-later", "s2", "hidden"),
    // s3 は読む順で s2 の後ろ、物語時間では s2 の前。
    phase("ph-story", "story-hide", "s3", "hidden"),
    // 同じ時刻・同じ場面：id の localeCompare で並ぶので、ph-tie-b が後に効いて hidden になる。
    phase("ph-tie-b", "tie", "s1", "hidden"),
    phase("ph-tie-a", "tie", "s1", "mentioned"),
    phase("ph-text", "plain-text", "s1", null, {
      summaryOverride: "文だけ変える",
    }),
  ];
});

const STORE_VARIANTS = [
  [
    "reading",
    [scene("s1", "a0", "a1"), scene("s2", "a1", "a3"), scene("s3", "a2", "a2")],
  ],
  [
    "story",
    [scene("s1", "a0", "a1"), scene("s2", "a1", "a3"), scene("s3", "a2", "a2")],
  ],
  [
    "auto",
    [scene("s1", "a0", "a1"), scene("s2", "a1", "a3"), scene("s3", "a2", "a2")],
  ],
  [
    "auto",
    [scene("s1", "a0", "a1"), scene("s2", "a1", "a3"), scene("s3", "a2", null)],
  ],
] as const;

describe("renderer の resolveCodexForAi と read core の判定が一致する", () => {
  for (const [mode, nodes] of STORE_VARIANTS) {
    for (const withContent of [false, true]) {
      it(`${mode}（${nodes.map((n) => n.storyTimeOrder ?? "-").join(",")}）・withContent=${withContent}：全 sceneId で hidden・texts・released が同じ`, async () => {
        usePhaseStore.setState({
          sceneTimeIndex: buildSceneTimeIndex([...nodes]),
          resolutionMode: mode,
        });
        for (const sceneId of [
          undefined,
          null,
          "",
          "  ",
          "s1",
          "s2",
          " s3 ",
          "elsewhere",
        ]) {
          const legacy = await resolveCodexForAi({
            entryIds: IDS,
            projectId: "p",
            sceneId,
            withContent,
          });
          const core = await resolveCodexAiVisibility(RENDERER_PORTS, {
            entryIds: IDS,
            projectId: "p",
            sceneId,
            withContent,
          });
          const label = `${mode} / ${String(sceneId)}`;
          // 挿入順まで同じ。
          expect([...core.hidden], label).toEqual([...legacy.hidden]);
          expect([...core.texts.entries()], label).toEqual([
            ...legacy.texts.entries(),
          ]);
          expect(
            [
              ...(await listHiddenCodexIds(RENDERER_PORTS, {
                entryIds: IDS,
                projectId: "p",
                sceneId,
              })),
            ],
            label,
          ).toEqual([...legacy.hidden]);
        }
      });
    }
  }

  it("fixture が判定を区別している（全 sceneId で同じ結果の自明な比較になっていない）", async () => {
    usePhaseStore.setState({
      sceneTimeIndex: buildSceneTimeIndex([
        scene("s1", "a0", "a1"),
        scene("s2", "a1", "a3"),
        scene("s3", "a2", "a2"),
      ]),
      resolutionMode: "reading",
    });
    const at = async (sceneId: string) =>
      [
        ...(
          await resolveCodexAiVisibility(RENDERER_PORTS, {
            entryIds: IDS,
            projectId: "p",
            sceneId,
          })
        ).hidden,
      ].sort();
    const s1 = await at("s1");
    const s2 = await at("s2");
    expect(s1).not.toEqual(s2);
    // 同順位の Phase は id の順で、後の ph-tie-b（hidden）が効く。
    expect(s1).toContain("tie");
    // s2 では解除された rel は公開、hide-later は hidden。
    expect(s2).not.toContain("rel");
    expect(s2).toContain("hide-later");
  });
});
