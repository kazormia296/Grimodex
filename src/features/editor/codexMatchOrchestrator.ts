import type { Editor } from "@tiptap/core";
import { rebuildMatcher, matchText } from "@/features/codex/rustMatcher";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import { useCodexHighlightStore } from "./codexHighlightStore";
import { getDocText } from "./RubyNode";
import { markStart, markEnd } from "@/lib/perfLog";

// ---------------------------------------------------------------------------
// Per-editor orchestrator state
// ---------------------------------------------------------------------------

interface OrchestratorState {
  version: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const states = new WeakMap<Editor, OrchestratorState>();

function getState(editor: Editor): OrchestratorState {
  if (!states.has(editor)) {
    states.set(editor, { version: 0, timer: null });
  }
  return states.get(editor)!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Debounce-schedule an async codex match for `editor`.
 * Dispatches a transaction with "codexHighlightResult" meta when the match
 * completes. Stale results (superseded by a newer call) are discarded.
 *
 * @param skipMatchedIds - When true, skip updating the global matchedEntryIds
 *   store (e.g. for mini-editors that should not affect CodexQuick).
 */
export function scheduleMatch(
  text: string,
  editor: Editor,
  entries: CodexMatchTarget[],
  excludeEntryIds: string[] = [],
  debounceMs = 150,
  skipMatchedIds = false,
): void {
  const state = getState(editor);

  // Cancel pending timer
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const myVersion = ++state.version;

  state.timer = setTimeout(() => {
    state.timer = null;
    void (async () => {
      try {
        const matches = await matchText(text, entries, excludeEntryIds);
        // Discard stale result
        if (state.version !== myVersion) return;
        if (editor.isDestroyed) return;
        markStart("codexMatch.applyResult");
        const uniqueIds = [...new Set(matches.map((m) => m.entryId))];
        if (!skipMatchedIds) {
          useCodexHighlightStore.getState().setMatchedEntryIds(uniqueIds);
        }
        const tr = editor.state.tr.setMeta("codexHighlightResult", matches);
        editor.view.dispatch(tr);
        markEnd("codexMatch.applyResult");
      } catch {
        // Silently ignore match errors (e.g. workspace not open yet)
      }
    })();
  }, debounceMs);
}

/**
 * Immediately rebuild the Rust matcher and schedule a match.
 * Call this when the entries list changes.
 *
 * @param skipMatchedIds - When true, skip updating the global matchedEntryIds store.
 */
export async function rebuildAndSchedule(
  editor: Editor,
  entries: CodexMatchTarget[],
  excludeEntryIds: string[] = [],
  skipMatchedIds = false,
): Promise<void> {
  if (entries.length === 0) {
    // Clear decorations
    if (!skipMatchedIds) {
      useCodexHighlightStore.getState().setMatchedEntryIds([]);
    }
    const tr = editor.state.tr.setMeta("codexHighlightResult", []);
    editor.view.dispatch(tr);
    return;
  }
  await rebuildMatcher(entries);
  const text = getDocText(editor.state.doc);
  scheduleMatch(text, editor, entries, excludeEntryIds, 0, skipMatchedIds);
}
