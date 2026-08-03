import { useCodexStore } from "@/features/codex/codexStore";
import type { CodexMatchRow } from "@/features/codex/api";
import {
  getCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import type { LintCodexEntry } from "./types";

export interface CodexLintInputSnapshot {
  projectId: string;
  codexRevision: number;
  entries: LintCodexEntry[];
}

let nextCodexRevision = 0;
let cached:
  | {
      projectId: string;
      targets: readonly CodexMatchRow[];
      snapshot: CodexLintInputSnapshot;
    }
  | undefined;

function parseAliases(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (alias): alias is string => typeof alias === "string" && alias.length > 0,
    );
  } catch {
    return [];
  }
}

function toLintEntries(targets: readonly CodexMatchRow[]): LintCodexEntry[] {
  const entries: LintCodexEntry[] = [];
  for (const target of targets) {
    if (!target.name || !target.name.trim()) continue;
    entries.push({
      entry_id: target.id,
      canonical: target.name,
      aliases: parseAliases(target.aliases),
    });
  }
  return entries;
}

/**
 * Return a stable project-scoped Codex input snapshot. `completionTargets` is
 * immutable in CodexStore, so its reference is the revision source: create,
 * update, delete, undo/redo, external reload, and project hydration all
 * replace it. Lint passes therefore reuse parsed aliases with no DB round-trip.
 */
export function getCodexLintInputSnapshot(): CodexLintInputSnapshot {
  const projectId = getCurrentProjectId();
  const targets = useCodexStore.getState().completionTargets;
  if (cached && cached.projectId === projectId && cached.targets === targets) {
    return cached.snapshot;
  }

  const snapshot: CodexLintInputSnapshot = {
    projectId,
    codexRevision: ++nextCodexRevision,
    entries: toLintEntries(targets),
  };
  cached = { projectId, targets, snapshot };
  return snapshot;
}

/**
 * Notify only when the effective `{ projectId, codexRevision }` changes.
 * Project startup hydrates CodexStore independently from the editor; this
 * subscription schedules one fresh pass when that snapshot arrives.
 */
export function subscribeCodexLintInput(
  listener: (snapshot: CodexLintInputSnapshot) => void,
): () => void {
  let revision = getCodexLintInputSnapshot().codexRevision;
  const notifyIfChanged = () => {
    const snapshot = getCodexLintInputSnapshot();
    if (snapshot.codexRevision === revision) return;
    revision = snapshot.codexRevision;
    listener(snapshot);
  };
  const unsubscribeCodex = useCodexStore.subscribe(notifyIfChanged);
  const unsubscribeProject = useProjectStore.subscribe(notifyIfChanged);
  return () => {
    unsubscribeCodex();
    unsubscribeProject();
  };
}

export function resetCodexLintInputCacheForTests(): void {
  cached = undefined;
  nextCodexRevision = 0;
}
