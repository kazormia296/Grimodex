import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { getProject } from "@/features/project/api";
import { streamInlineAiText } from "./streamInlineAiText";
import { BEAT_TYPES } from "@/features/editor/SceneBeatNode";
import type { BeatType } from "@/features/editor/SceneBeatNode";
import { getPromptCatalog } from "@/prompts/index";
import i18next from "@/lib/i18n";

interface GenerateBeatsCallbacks {
  onStart?: () => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

interface RawBeat {
  beatType?: unknown;
  instructions?: unknown;
}

function extractJsonString(raw: string): string {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Extract first {...} block in case of leading prose
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];
  return raw;
}

function parseBeatJson(raw: string): RawBeat[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonString(raw));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).beats)
  ) {
    return null;
  }
  return (parsed as { beats: unknown[] }).beats as RawBeat[];
}

function toBeatType(value: unknown): BeatType {
  if (
    typeof value === "string" &&
    (BEAT_TYPES as readonly string[]).includes(value)
  ) {
    return value as BeatType;
  }
  return "free";
}

/**
 * Ask AI to propose beats from the current scene synopsis.
 * The AI must return strict JSON: {"beats": [{"beatType": "...", "instructions": "..."}]}.
 * On success, each beat is added to useUnplacedBeatsStore as an unplaced beat.
 */
export async function generateBeatsFromSynopsis(
  sceneId: string,
  callbacks?: GenerateBeatsCallbacks,
): Promise<void> {
  const state = useTreeStore.getState();
  const treeNode = state.nodes.find((n) => n.id === sceneId);
  const synopsis = treeNode?.synopsis?.trim() ?? "";
  if (!synopsis) return;

  const projectTitle = useWorkspaceStore.getState().activeWorkspaceName ?? "";
  const sceneTitle = treeNode?.title ?? "";
  let project;
  try {
    project = await getProject(state.projectId);
  } catch {
    // ignore
  }
  const lang = project?.language ?? "ja";

  const messages = getPromptCatalog(
    lang,
  ).beatGenerate.buildGenerateBeatsMessages(projectTitle, sceneTitle, synopsis);

  callbacks?.onStart?.();

  const result = await streamInlineAiText(messages, { usageSurface: "beat" });
  if (!result.ok) {
    callbacks?.onError?.(result.error);
    return;
  }

  const rawBeats = parseBeatJson(result.text.trim());
  if (!rawBeats) {
    callbacks?.onError?.(i18next.t("beat.generateBeats.parseError"));
    return;
  }

  const store = useUnplacedBeatsStore.getState();
  for (const rb of rawBeats) {
    const instructions =
      typeof rb.instructions === "string" ? rb.instructions.trim() : "";
    if (!instructions) continue;
    store.addBeat(sceneId, {
      id: crypto.randomUUID(),
      beatType: toBeatType(rb.beatType),
      pov: null,
      collapsed: false,
      content: [{ type: "text", text: instructions }],
    });
  }

  callbacks?.onDone?.();
}
