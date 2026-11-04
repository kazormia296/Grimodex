import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import {
  bindEvidenceSpanCatalog,
  buildEvidenceSpanCatalog,
} from "@/features/narrative-extraction/evidence/spanCatalog";
import { splitChroniclePromptForCache } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import {
  buildCitationIdObservationPromptArtifact,
  buildCitationIdRepairPromptArtifact,
  CITATION_ID_OBSERVATION_EXPECTED_SHAPE,
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
} from "./citationIdObservation";
import { CHRONICLE_PROMPT_CACHE_MIN_PREFIX_CHARS } from "./chroniclePromptCache";
import { runObservationExtractionTask } from "./runObservationExtractionTask";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: sendMock,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({
    apiVariant: null,
    model: "claude-sonnet-5-5",
    provider: "anthropic",
    endpointId: null,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: "citation-task-test" }) },
}));

function prose(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

async function fixture(text = "同じ文。門が開いた。"): Promise<{
  readonly binding: Awaited<ReturnType<typeof bindEvidenceSpanCatalog>>;
  readonly window: {
    readonly windowId: string;
    readonly sourceRef: string;
    readonly text: string;
  };
}> {
  const built = await buildNarrativeCorpusSnapshot({
    snapshotId: "snapshot-citation-task",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "citation-task-test" },
    documents: [
      {
        sourceKey: "project:scene:one",
        parentSourceKey: null,
        title: "一場",
        orderIndex: 0,
        proseMirrorJson: prose(text),
        origin: {
          kind: "project-node",
          projectId: "citation-task-test",
          nodeId: "scene-one",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-09-05T00:00:00.000Z",
          sourceUri: null,
        },
      },
    ],
    omissions: [],
    createdAt: "2026-09-05T00:00:00.000Z",
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("fixture snapshot failed");
  const document = built.snapshot.documents[0];
  if (!document) throw new Error("fixture document missing");
  const sourceView = await buildNarrativeSourceView({
    ref: "S0001",
    document,
    documentRange: { start: 0, end: document.canonical.text.length },
  });
  const catalog = await buildEvidenceSpanCatalog(built.snapshot);
  const binding = await bindEvidenceSpanCatalog(built.snapshot, catalog, {
    requestIdentity: "citation-task-request",
    windows: [
      {
        windowId: "window-001",
        documentRef: document.ref,
        sourceView,
        ownedRanges: [{ start: 0, end: document.canonical.text.length }],
        contextRanges: [],
      },
    ],
  });
  return {
    binding,
    window: {
      windowId: "window-001",
      sourceRef: sourceView.ref,
      text: sourceView.text,
    },
  };
}

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ text: "{}", inputTokens: 1, outputTokens: 1 });
});

describe("citation-id Chronicle prompts and prompt cache", () => {
  it("observation: the static prefix excludes the bound catalog text and is stable across scenes", async () => {
    const first = await fixture("同じ文。門が開いた。");
    const second = await fixture("全く別の場面の本文。扉が閉じた。");
    const a = splitChroniclePromptForCache(
      await buildCitationIdObservationPromptArtifact(
        [first.window],
        first.binding,
      ),
    )!;
    const b = splitChroniclePromptForCache(
      await buildCitationIdObservationPromptArtifact(
        [second.window],
        second.binding,
      ),
    )!;
    expect(a).not.toBeNull();
    expect(a.staticPrefix).toBe(b.staticPrefix);
    expect(a.staticPrefix.length).toBeGreaterThanOrEqual(
      CHRONICLE_PROMPT_CACHE_MIN_PREFIX_CHARS,
    );
    expect(a.staticPrefix).not.toContain("門が開いた");
    expect(a.staticPrefix).not.toContain("window-001");
    expect(a.dynamicRest).toContain("門が開いた");
    expect(b.dynamicRest).toContain("扉が閉じた");
  });

  it("observation task: citation-id mode sends the cache segment on Anthropic", async () => {
    for (const text of ["同じ文。門が開いた。", "別の本文。扉が閉じた。"]) {
      const { binding, window } = await fixture(text);
      await runObservationExtractionTask({
        windows: [window],
        evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
        evidenceSpanCatalogBinding: binding,
        repairOnFailure: false,
        projectId: "citation-task-test",
      }).catch(() => undefined);
    }
    expect(sendMock).toHaveBeenCalledTimes(2);
    const [first, second] = sendMock.mock.calls;
    const firstSegments = first![3] as string[];
    expect(firstSegments).toHaveLength(1);
    expect(firstSegments).toEqual(second![3]);
    expect(firstSegments[0]).not.toContain("門が開いた");
    expect(
      (first![0] as { role: string; content: string }[]).map((m) => m.role),
    ).toEqual(["system", "user"]);
    expect((first![0] as { content: string }[])[1]!.content).toContain(
      "門が開いた",
    );
  });

  it("citation-id repair: the prefix never carries the broken response or catalog", async () => {
    const { binding } = await fixture();
    const artifact = await buildCitationIdRepairPromptArtifact({
      expectedShape: CITATION_ID_OBSERVATION_EXPECTED_SHAPE,
      brokenText: "BROKEN-MARKER",
      binding,
    });
    const split = splitChroniclePromptForCache(artifact)!;
    expect(split.staticPrefix + split.dynamicRest).toBe(
      artifact.messages[0].content,
    );
    expect(split.staticPrefix).not.toContain("BROKEN-MARKER");
    expect(split.staticPrefix).not.toContain("門が開いた");
    expect(split.dynamicRest).toContain("BROKEN-MARKER");
  });

  it("citation-id repair task: sends the long contract as a cache segment, not the broken text", async () => {
    const { binding } = await fixture();
    await runStructuredRepairTask({
      brokenText: "BROKEN-MARKER",
      expectedShape: CITATION_ID_OBSERVATION_EXPECTED_SHAPE,
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
      evidenceSpanCatalogBinding: binding,
      projectId: "citation-task-test",
      responseValidator: () => "invalid",
    }).catch(() => undefined);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [messages, , , segments] = sendMock.mock.calls[0]! as [
      { role: string; content: string }[],
      unknown,
      unknown,
      string[],
    ];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toBe(messages[0]!.content);
    expect(segments[0]!.length).toBeGreaterThanOrEqual(
      CHRONICLE_PROMPT_CACHE_MIN_PREFIX_CHARS,
    );
    expect(segments[0]).not.toContain("BROKEN-MARKER");
    expect(messages[1]!.content).toContain("BROKEN-MARKER");
  });
});
