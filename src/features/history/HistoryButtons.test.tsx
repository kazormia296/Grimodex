// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { HistoryButtons } from "./HistoryButtons";

vi.mock("@/lib/platform", () => ({
  formatShortcut: (shortcut: string) => shortcut,
}));

describe("HistoryButtons lifecycle barrier", () => {
  beforeEach(() => {
    _resetQuiescenceLeasesForTests();
    useGlobalHistoryStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    useGlobalHistoryStore.getState().clear();
    _resetQuiescenceLeasesForTests();
  });

  it("disables desktop undo while destructive lifecycle work is active", () => {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "Create scene",
      undo: async () => {},
      redo: async () => {},
    });
    acquireQuiescenceLease("workspace-open");

    render(<HistoryButtons />);

    expect(screen.getByTitle(/Create scene/)).toBeDisabled();
  });
});
