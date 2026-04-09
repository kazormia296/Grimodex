import type { Editor } from "@tiptap/core";
import { rebuildMatcher, matchText } from "@/features/codex/rustMatcher";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";

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
 */
export function scheduleMatch(
  text: string,
  editor: Editor,
  entries: CodexMatchTarget[],
  excludeEntryIds: string[] = [],
  debounceMs = 150,
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
        const tr = editor.state.tr.setMeta("codexHighlightResult", matches);
        editor.view.dispatch(tr);
      } catch {
        // Silently ignore match errors (e.g. workspace not open yet)
      }
    })();
  }, debounceMs);
}

/**
 * Immediately rebuild the Rust matcher and schedule a match.
 * Call this when the entries list changes.
 */
export async function rebuildAndSchedule(
  editor: Editor,
  entries: CodexMatchTarget[],
  excludeEntryIds: string[] = [],
): Promise<void> {
  if (entries.length === 0) {
    // Clear decorations
    const tr = editor.state.tr.setMeta("codexHighlightResult", []);
    editor.view.dispatch(tr);
    return;
  }
  await rebuildMatcher(entries);
  const text = editor.state.doc.textContent;
  scheduleMatch(text, editor, entries, excludeEntryIds, 0);
}
