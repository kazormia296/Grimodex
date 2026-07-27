// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexMatchRow } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { useProjectStore } from "@/features/project/projectStore";
import {
  getCodexLintInputSnapshot,
  resetCodexLintInputCacheForTests,
  subscribeCodexLintInput,
} from "./codexLintInputCache";

function target(
  id: string,
  name: string,
  aliases: string | null = null,
): CodexMatchRow {
  return {
    id,
    name,
    aliases,
    type: "character",
    excludedAliases: null,
  };
}

beforeEach(() => {
  resetCodexLintInputCacheForTests();
  useProjectStore.setState({ currentProjectId: "project-a" });
  useCodexStore.setState({
    completionTargets: [
      target("entry-1", "刹那", JSON.stringify(["せつな", "", 42])),
      target("entry-2", " ", "malformed"),
    ],
  });
});

afterEach(() => {
  useCodexStore.setState({ completionTargets: [] });
  useProjectStore.setState({ currentProjectId: null });
  resetCodexLintInputCacheForTests();
});

describe("codexLintInputCache", () => {
  it("reuses parsed aliases while the project and target revision are stable", () => {
    const first = getCodexLintInputSnapshot();
    useCodexStore.setState({ searchQuery: "unrelated UI state" });
    const second = getCodexLintInputSnapshot();

    expect(second).toBe(first);
    expect(first).toEqual({
      projectId: "project-a",
      codexRevision: 1,
      entries: [
        {
          entry_id: "entry-1",
          canonical: "刹那",
          aliases: ["せつな"],
        },
      ],
    });
  });

  it("advances the revision when Codex targets or the project changes", () => {
    const first = getCodexLintInputSnapshot();
    useCodexStore.setState({
      completionTargets: [target("entry-1", "セツナ", '["Setsuna"]')],
    });
    const updated = getCodexLintInputSnapshot();
    useProjectStore.setState({ currentProjectId: "project-b" });
    const switched = getCodexLintInputSnapshot();

    expect(updated.codexRevision).toBe(first.codexRevision + 1);
    expect(updated.entries[0]).toEqual({
      entry_id: "entry-1",
      canonical: "セツナ",
      aliases: ["Setsuna"],
    });
    expect(switched.projectId).toBe("project-b");
    expect(switched.codexRevision).toBe(updated.codexRevision + 1);
  });

  it("notifies only for effective Codex input changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCodexLintInput(listener);

    useCodexStore.setState({ searchQuery: "no revision" });
    expect(listener).not.toHaveBeenCalled();

    useCodexStore.setState({
      completionTargets: [target("entry-3", "月")],
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].entries[0].canonical).toBe("月");

    unsubscribe();
  });
});
