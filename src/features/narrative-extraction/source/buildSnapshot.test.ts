import { describe, expect, it } from "vitest";
import { buildNarrativeCorpusSnapshot } from "./buildSnapshot";
import type { NarrativeSnapshotBuildInput } from "./types";

function prose(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text }] : [],
      },
    ],
  });
}

function rubyProse(base: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "ruby", attrs: { base, annotation: "reading" } }],
      },
    ],
  });
}

function input(
  overrides: Partial<NarrativeSnapshotBuildInput> = {},
): NarrativeSnapshotBuildInput {
  return {
    snapshotId: "snapshot-a",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "project-a" },
    documents: [
      {
        sourceKey: "project:scene:one",
        parentSourceKey: null,
        title: "第一場",
        orderIndex: 0,
        proseMirrorJson: prose("雨が降った。"),
        origin: {
          kind: "project-node",
          projectId: "project-a",
          nodeId: "scene-one",
          sourceVersion: 4,
          sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
          sourceUri: null,
        },
      },
      {
        sourceKey: "project:scene:two",
        parentSourceKey: "project:scene:one",
        title: "第二場",
        orderIndex: 1,
        proseMirrorJson: prose("門が開いた。"),
        origin: {
          kind: "project-node",
          projectId: "project-a",
          nodeId: "scene-two",
          sourceVersion: 2,
          sourceUpdatedAt: "2026-08-09T00:01:00.000Z",
          sourceUri: "external-root://novel/scene-two.md",
        },
      },
    ],
    omissions: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildNarrativeCorpusSnapshot", () => {
  it("seals ordered documents with opaque refs, parent refs, and source freshness", async () => {
    const result = await buildNarrativeCorpusSnapshot(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.normalizerVersion).toBe("gdx-canonical-text/1");
    expect(result.snapshot.documents.map((document) => document.ref)).toEqual([
      "D000001",
      "D000002",
    ]);
    expect(result.snapshot.documents[1].parentRef).toBe("D000001");
    expect(result.snapshot.documents[1].origin).toEqual({
      kind: "project-node",
      projectId: "project-a",
      nodeId: "scene-two",
      sourceVersion: 2,
      sourceUpdatedAt: "2026-08-09T00:01:00.000Z",
      sourceUri: "external-root://novel/scene-two.md",
    });
    expect(result.snapshot.documents[0].canonical.text).toBe("雨が降った。");
    expect(result.snapshot.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.snapshot.documents[0].contentDigest).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  it("keeps content digests independent of run identity and changes semantic digests on source changes", async () => {
    const first = await buildNarrativeCorpusSnapshot(input());
    const replay = await buildNarrativeCorpusSnapshot(
      input({
        snapshotId: "snapshot-b",
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
    );
    const changed = await buildNarrativeCorpusSnapshot(
      input({
        documents: [
          ...input().documents.slice(0, 1),
          {
            ...input().documents[1],
            proseMirrorJson: prose("門は閉じた。"),
          },
        ],
      }),
    );

    expect(first.ok && replay.ok && changed.ok).toBe(true);
    if (!first.ok || !replay.ok || !changed.ok) return;
    expect(replay.snapshot.digest).toBe(first.snapshot.digest);
    expect(replay.snapshot.documents[0].contentDigest).toBe(
      first.snapshot.documents[0].contentDigest,
    );
    expect(changed.snapshot.digest).not.toBe(first.snapshot.digest);
    expect(changed.snapshot.documents[1].contentDigest).not.toBe(
      first.snapshot.documents[1].contentDigest,
    );
  });

  it("keeps semantic digests independent of source freshness metadata", async () => {
    const first = await buildNarrativeCorpusSnapshot(input());
    const refreshed = await buildNarrativeCorpusSnapshot(
      input({
        documents: input().documents.map((document) => ({
          ...document,
          origin: {
            ...document.origin,
            sourceVersion: document.origin.sourceVersion + 10,
            sourceUpdatedAt: "2026-08-12T00:00:00.000Z",
          },
        })),
      }),
    );

    expect(first.ok && refreshed.ok).toBe(true);
    if (!first.ok || !refreshed.ok) return;
    expect(refreshed.snapshot.digest).toBe(first.snapshot.digest);
    expect(refreshed.snapshot.documents[0].documentDigest).toBe(
      first.snapshot.documents[0].documentDigest,
    );
    expect(refreshed.snapshot.documents[0].artifactDigest).not.toBe(
      first.snapshot.documents[0].artifactDigest,
    );
    expect(refreshed.snapshot.artifactDigest).not.toBe(
      first.snapshot.artifactDigest,
    );
  });

  it("seals projection differences separately from semantic cache digests", async () => {
    const plainDocument = {
      ...input().documents[0],
      proseMirrorJson: prose("same"),
    };
    const rubyDocument = {
      ...plainDocument,
      proseMirrorJson: rubyProse("same"),
    };
    const plain = await buildNarrativeCorpusSnapshot(
      input({ documents: [plainDocument] }),
    );
    const ruby = await buildNarrativeCorpusSnapshot(
      input({ documents: [rubyDocument] }),
    );

    expect(plain.ok && ruby.ok).toBe(true);
    if (!plain.ok || !ruby.ok) return;
    expect(ruby.snapshot.digest).toBe(plain.snapshot.digest);
    expect(ruby.snapshot.documents[0].documentDigest).toBe(
      plain.snapshot.documents[0].documentDigest,
    );
    expect(ruby.snapshot.documents[0].artifactDigest).not.toBe(
      plain.snapshot.documents[0].artifactDigest,
    );
    expect(ruby.snapshot.artifactDigest).not.toBe(
      plain.snapshot.artifactDigest,
    );
  });

  it("copies inputs before hashing and recursively freezes the sealed snapshot", async () => {
    const mutable = input() as unknown as {
      documents: Array<{
        title: string;
        origin: { sourceVersion: number };
      }>;
    } & NarrativeSnapshotBuildInput;
    const expectedTitle = mutable.documents[0]?.title;

    const pending = buildNarrativeCorpusSnapshot(mutable);
    if (mutable.documents[0]) {
      mutable.documents[0].title = "mutated after build started";
      mutable.documents[0].origin.sourceVersion = 999;
    }
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.documents[0].title).toBe(expectedTitle);
    expect(result.snapshot.documents[0].origin.sourceVersion).not.toBe(999);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.documents)).toBe(true);
    expect(Object.isFrozen(result.snapshot.documents[0].canonical)).toBe(true);
  });

  it("includes explicit omissions in the snapshot digest", async () => {
    const complete = await buildNarrativeCorpusSnapshot(input());
    const omitted = await buildNarrativeCorpusSnapshot(
      input({
        omissions: [
          { sourceKey: "project:scene:three", reason: "user-excluded" },
        ],
      }),
    );

    expect(complete.ok && omitted.ok).toBe(true);
    if (!complete.ok || !omitted.ok) return;
    expect(omitted.snapshot.digest).not.toBe(complete.snapshot.digest);
  });

  it.each([
    {
      name: "malformed JSON",
      documents: [
        {
          ...input().documents[0],
          proseMirrorJson: "{not-json",
        },
      ],
      code: "SNAPSHOT_INVALID_PM_JSON",
    },
    {
      name: "unknown leaf node",
      documents: [
        {
          ...input().documents[0],
          proseMirrorJson: JSON.stringify({
            type: "doc",
            content: [{ type: "futureAtom" }],
          }),
        },
      ],
      code: "SNAPSHOT_UNKNOWN_PM_NODE",
    },
  ])(
    "does not seal $name as an empty document",
    async ({ documents, code }) => {
      const result = await buildNarrativeCorpusSnapshot(input({ documents }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
    },
  );

  it("rejects duplicate stable source keys", async () => {
    const result = await buildNarrativeCorpusSnapshot(
      input({
        documents: [
          input().documents[0],
          { ...input().documents[1], sourceKey: "project:scene:one" },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SNAPSHOT_DUPLICATE_SOURCE_KEY" }),
      ]),
    );
  });

  it("rejects a document origin from another Project", async () => {
    const result = await buildNarrativeCorpusSnapshot(
      input({
        documents: [
          {
            ...input().documents[0],
            origin: {
              ...input().documents[0].origin,
              projectId: "project-foreign",
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SNAPSHOT_DOCUMENT_ORIGIN_MISMATCH",
        }),
      ]),
    );
  });
});
