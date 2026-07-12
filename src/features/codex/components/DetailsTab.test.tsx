// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CodexEntry } from "../api";
import { buildSceneTimeIndex } from "../context/sceneTimeIndex";
import { DetailsTab } from "./DetailsTab";

vi.mock("./CodexContentEditor", () => ({
  CodexContentEditor: ({ readOnly }: { readOnly?: boolean }) => (
    <div
      data-testid="mock-codex-content-editor"
      data-read-only={String(Boolean(readOnly))}
    />
  ),
}));

vi.mock("./DetailsSection", () => ({
  DetailsSection: () => <div data-testid="mock-details-section" />,
}));

vi.mock("./PhaseIndicator", () => ({
  PhaseIndicator: () => <div data-testid="mock-phase-indicator" />,
}));

const phase = {
  id: "phase-1",
  entryId: "entry-1",
  label: "Preview",
  anchorNodeId: "scene-1",
  summaryOverride: "Preview summary",
  contentOverride: '{"type":"doc","content":[]}',
  contextModeOverride: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const phaseState = {
  phasesByEntry: { "entry-1": [phase] },
  detailOverrides: {},
  sceneTimeIndex: buildSceneTimeIndex([
    {
      id: "scene-1",
      projectId: "project-1",
      parentId: null,
      nodeType: "scene" as const,
      title: "Scene",
      synopsis: null,
      intent: null,
      sortOrder: "a0",
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]),
  resolutionMode: "reading" as const,
  updatePhase: vi.fn(),
};

vi.mock("../phaseStore", () => ({
  usePhaseStore: (selector: (state: typeof phaseState) => unknown) =>
    selector(phaseState),
}));

const codexState = {
  previewPhaseByEntry: { "entry-1": phase.id },
  setPreviewPhase: vi.fn(),
};

vi.mock("../codexStore", () => ({
  useCodexStore: (selector: (state: typeof codexState) => unknown) =>
    selector(codexState),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (selector: (state: { activeSceneId: string }) => unknown) =>
    selector({ activeSceneId: "scene-1" }),
}));

vi.mock("@/hooks/useAutoSave", () => ({
  useAutoSave: () => ({ schedule: vi.fn() }),
}));

const entry: CodexEntry = {
  id: "entry-1",
  projectId: "project-1",
  parentId: null,
  type: "character",
  name: "Alice",
  summary: "Base summary",
  content: '{"type":"doc","content":[]}',
  icon: null,
  aliases: null,
  excludedAliases: null,
  readings: null,
  tagsCache: null,
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  version: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("DetailsTab Phase preview", () => {
  it("forces the content editor read-only while previewing an exact Phase", () => {
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mock-codex-content-editor")).toHaveAttribute(
      "data-read-only",
      "true",
    );
  });
});
