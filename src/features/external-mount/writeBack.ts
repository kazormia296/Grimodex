import { saveSceneContent, updateNode } from "@/features/tree/api";
import { parseSourceUri } from "./sourceUri";
import { pmJsonToMarkdown } from "./markdownBridge";
import * as mountApi from "./api";
import { useExternalRootStore } from "./externalRootStore";
import { scheduleSceneIndex } from "@/features/semantic-search/scheduler";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

export function scheduleWriteBack(
  sceneId: string,
  sourceUri: string,
  pmJson: string,
): void {
  const existing = timers.get(sceneId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(sceneId);
    void flushWriteBack(sceneId, sourceUri, pmJson);
  }, DEBOUNCE_MS);
  timers.set(sceneId, t);
}

export function cancelWriteBack(sceneId: string): void {
  const t = timers.get(sceneId);
  if (t) {
    clearTimeout(t);
    timers.delete(sceneId);
  }
}

async function flushWriteBack(
  sceneId: string,
  sourceUri: string,
  pmJson: string,
): Promise<void> {
  const parsed = parseSourceUri(sourceUri);
  if (!parsed) return;

  const markdown = pmJsonToMarkdown(pmJson);
  useExternalRootStore.getState().mutePath(parsed.rootId, parsed.relPath);
  await mountApi.writeExternalFile(parsed.rootId, parsed.relPath, markdown);
  await saveSceneContent(sceneId, pmJson);
  await updateNode(sceneId, { sourceMtime: new Date().toISOString() });
  scheduleSceneIndex(sceneId);
}

/** Test helper */
export function _resetWriteBackTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
