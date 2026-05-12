import { useEffect, useState } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useChatStore } from "@/features/chat/chatStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";

/** True once the active scene has more chars than the captured baseline. */
export function useEditorWriteGate(baseline: number | null): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || baseline === null) return;
    const unsub = useTreeStore.subscribe((state) => {
      const count = state.charCounts[state.activeSceneId] ?? 0;
      if (count > baseline + 5) {
        setDone(true);
        unsub();
      }
    });
    return unsub;
  }, [baseline, done]);
  return done;
}

/** True once at least one user message was sent after the captured baseline. */
export function useChatSentGate(baselineMsgCount: number): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return;
    const unsub = useChatStore.subscribe((state) => {
      const userMsgs = state.messages.filter((m) => m.role === "user").length;
      if (userMsgs > baselineMsgCount) {
        setDone(true);
        unsub();
      }
    });
    return unsub;
  }, [baselineMsgCount, done]);
  return done;
}

/** True once codex entries count exceeds the captured baseline. */
export function useCodexExtractGate(baselineCount: number): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return;
    const unsub = useCodexStore.subscribe((state) => {
      if (state.entries.length > baselineCount) {
        setDone(true);
        unsub();
      }
    });
    return unsub;
  }, [baselineCount, done]);
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
