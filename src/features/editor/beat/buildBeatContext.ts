import type { Editor } from "@tiptap/core";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { getProject } from "@/features/project/api";
import { useCodexStore } from "@/features/codex/codexStore";
// NOTE: findBeatById must come from "./insertBeatStream" — generateBeatOnce's
// tests mock that module and assert the call goes through the mock.
import { findBeatById } from "./insertBeatStream";
import type { BeatType } from "@/features/editor/SceneBeatNode";

type TreeNode = ReturnType<typeof useTreeStore.getState>["nodes"][number];
type CodexEntries = ReturnType<typeof useCodexStore.getState>["entries"];

export interface BeatGenerationContext {
  beatPos: number;
  instructions: string;
  beatType: BeatType;
  beatModel: string | null;
  projectTitle: string;
  sceneTitle: string;
  sceneTextSoFar: string;
  povName: string | null;
  lang: string;
  /** Scene tree node — useBeatGeneration needs it for the pending-beats section. */
  node: TreeNode | undefined;
  codexEntries: CodexEntries;
}

export type BuildBeatContextResult =
  | { ok: true; ctx: BeatGenerationContext }
  | { ok: false; reason: "no-beat" | "empty-instructions" };

/**
 * Resolve the shared generation context for a beat: instructions and attrs
 * from the beat node, scene/project titles, POV name, language, and the doc
 * text preceding the beat. Shared by the three generation paths
 * (useBeatGeneration / generateBeatOnce / generateBeatAlternative).
 *
 * Returns a discriminated result instead of throwing so each caller keeps
 * its own failure behavior (silent return vs. error state) — only
 * useBeatGeneration surfaces "empty-instructions" as an error.
 */
export async function buildBeatContextForGeneration(
  editor: Editor,
  beatId: string,
  sceneId: string,
): Promise<BuildBeatContextResult> {
  const beat = findBeatById(editor, beatId);
  if (!beat) return { ok: false, reason: "no-beat" };

  const beatNode = editor.state.doc.nodeAt(beat.beatPos);
  if (!beatNode) return { ok: false, reason: "no-beat" };

  const instructions = beatNode.textContent;
  if (instructions.trim().length === 0) {
    return { ok: false, reason: "empty-instructions" };
  }

  const beatType = (beatNode.attrs.beatType ?? "free") as BeatType;
  const beatPov = (beatNode.attrs.pov ?? null) as string | null;
  const beatModel = (beatNode.attrs.model as string | null) ?? null;

  const node = useTreeStore.getState().nodes.find((n) => n.id === sceneId);
  const projectTitle = useWorkspaceStore.getState().activeWorkspaceName ?? "";
  const sceneTitle = node?.title ?? "";
  const codexEntries = useCodexStore.getState().entries;
  let project;
  try {
    project = await getProject(useTreeStore.getState().projectId);
  } catch {
    // ignore
  }
  const lang = project?.language ?? "ja";

  const povCharId = beatPov ?? node?.povCharacterId ?? null;
  const povName = povCharId
    ? (codexEntries.find((e) => e.id === povCharId)?.name ?? null)
    : null;

  const sceneTextSoFar = editor.state.doc.textBetween(
    0,
    beat.beatPos,
    "\n",
    " ",
  );

  return {
    ok: true,
    ctx: {
      beatPos: beat.beatPos,
      instructions,
      beatType,
      beatModel,
      projectTitle,
      sceneTitle,
      sceneTextSoFar,
      povName,
      lang,
      node,
      codexEntries,
    },
  };
}
