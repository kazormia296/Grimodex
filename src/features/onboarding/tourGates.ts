import { useEffect, useState } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useChatStore } from "@/features/chat/chatStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useTabStore } from "@/features/editor/tabStore";

/**
 * True once the user opens at least one scene in the editor (tabs becomes
 * non-empty). A fresh sample workspace has tabs:[] after loadTabState resets,
 * so any tab opening is a clear user action.
 */
export function useSceneOpenGate(): boolean {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;

    function check() {
      if (useTabStore.getState().tabs.length > 0) setDone(true);
    }

    check();
    const unsub = useTabStore.subscribe(check);
    return unsub;
  }, [done]);

  return done;
}

/**
 * True once the user writes at least `threshold` chars beyond the baseline
 * captured when the tree store finishes loading.
 *
 * Uses "settle-then-track": subscribes immediately, captures baseline on the
 * first settled observation (!isLoading && activeSceneId set), then detects
 * increases from that point. This avoids the race where the baseline is read
 * before seeded data has loaded.
 */
export function useEditorWriteGate(threshold = 5): boolean {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;

    let settled = false;
    let baseline = 0;

    function check() {
      const { isLoading, activeSceneId, charCounts } = useTreeStore.getState();
      if (isLoading || !activeSceneId) return;
      const count = charCounts[activeSceneId] ?? 0;
      if (!settled) {
        baseline = count;
        settled = true;
        return;
      }
      if (count > baseline + threshold) setDone(true);
    }

    check(); // handle already-settled state at mount
    const unsub = useTreeStore.subscribe(check);
    return unsub;
  }, [done, threshold]);

  return done;
}

/**
 * True once the user sends a chat message after the session has loaded.
 *
 * Settled = sessions not loading AND an active session exists (messages are
 * loaded synchronously with activeSessionId in selectSession).
 */
export function useChatSentGate(): boolean {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;

    let settled = false;
    let baseline = 0;

    function check() {
      const { isLoadingSessions, activeSessionId, messages } =
        useChatStore.getState();
      if (isLoadingSessions || activeSessionId === null) return;
      const userMsgs = messages.filter((m) => m.role === "user").length;
      if (!settled) {
        baseline = userMsgs;
        settled = true;
        return;
      }
      if (userMsgs > baseline) setDone(true);
    }

    check();
    const unsub = useChatStore.subscribe(check);
    return unsub;
  }, [done]);

  return done;
}

/**
 * True once a codex entry is added after the initial load.
 *
 * Settled = not loading AND entries.length > 0 (the seeded workspace always
 * has entries; this guards against the initial empty state before first load).
 */
export function useCodexExtractGate(): boolean {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;

    let settled = false;
    let baseline = 0;

    function check() {
      const { isLoading, entries } = useCodexStore.getState();
      if (isLoading || entries.length === 0) return;
      if (!settled) {
        baseline = entries.length;
        settled = true;
        return;
      }
      if (entries.length > baseline) setDone(true);
    }

    check();
    const unsub = useCodexStore.subscribe(check);
    return unsub;
  }, [done]);

  return done;
}

/** True once any annotations appear (post-effect run completed). */
export function usePostEffectRunGate(): boolean {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;
    const unsub = useAnnotationStore.subscribe((state) => {
      let total = 0;
      for (const anns of state.annotationsByScene.values()) {
        total += anns.length;
      }
      if (total > 0) {
        setDone(true);
        unsub();
      }
    });
    return unsub;
  }, [done]);

  return done;
}
