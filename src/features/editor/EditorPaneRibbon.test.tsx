// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { createEditorInstanceId } from "./document/documentKey";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/license/LicenseRestrictionBanner", () => ({
  LicenseRestrictionBanner: () => <div data-testid="license-warning" />,
}));
vi.mock("@/features/editor/ExternalEditConflictBanner", () => ({
  ExternalEditConflictBanner: () => <div data-testid="conflict-warning" />,
}));
vi.mock("@/features/external-mount/components/FileBackedSceneBanner", () => ({
  FileBackedSceneBanner: () => <div data-testid="file-backed-banner" />,
}));
vi.mock("@/features/editor/NoteContextControls", () => ({
  NoteContextControls: () => <div data-testid="note-controls" />,
}));

import { EditorPaneRibbon } from "./EditorPaneRibbon";

function renderRibbon() {
  return render(
    <EditorPaneRibbon
      nodeId="scene-1"
      isEntryMode={false}
      isFileBacked
      isNote
      isCodexMode
      isSnippetMode
      isChronicleEventMode
      activeCodexEntry={{ name: "人物" }}
      activeSnippetEntry={{ title: "断片" }}
      loadedPhaseLabel="第二幕"
      chronicleEventTitle="事件"
      documentKey={{ kind: "tree", id: "scene-1", storage: "database" }}
      editorInstanceId={createEditorInstanceId("ribbon-test")}
    />,
  );
}

describe("EditorPaneRibbon Zen visibility", () => {
  beforeEach(() => {
    useCursorSettingsStore.setState({ zenMode: false });
  });

  it("keeps safety warnings but removes persistent context chrome in Zen", () => {
    useCursorSettingsStore.setState({ zenMode: true });
    renderRibbon();

    expect(screen.getByTestId("license-warning")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-warning")).toBeInTheDocument();
    expect(screen.queryByTestId("file-backed-banner")).toBeNull();
    expect(screen.queryByTestId("note-controls")).toBeNull();
    expect(screen.queryByText("editor.ribbon.codexEditing")).toBeNull();
    expect(screen.queryByText("editor.ribbon.snippetEditing")).toBeNull();
    expect(
      screen.queryByText("editor.ribbon.chronicleEventEditing"),
    ).toBeNull();
  });
});
