import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";
import { BEAT_TYPES } from "@/features/editor/SceneBeatNode";
import type { BeatType } from "@/features/editor/SceneBeatNode";

interface GenerateBeatsCallbacks {
  onStart?: () => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

interface RawBeat {
  beatType?: unknown;
  instructions?: unknown;
}

function parseBeatJson(raw: string): RawBeat[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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

  const beatTypeList = BEAT_TYPES.join(" | ");

  const messages: { role: string; content: string }[] = [
    {
      role: "system",
      content: `あなたは小説執筆アシスタントです。プロジェクト「${projectTitle}」のシーン「${sceneTitle}」のシノプシスから、実行可能なビートリストを提案します。
必ず以下の JSON 形式のみを出力してください（他のテキストは一切出力しないこと）:
{"beats": [{"beatType": "${beatTypeList}", "instructions": "日本語の指示文"}]}`,
    },
    {
      role: "user",
      content: `以下のシノプシスから、このシーンのビートを3〜6件提案してください。\n\n## シノプシス\n${synopsis}`,
    },
  ];

  callbacks?.onStart?.();

  const buffer: string[] = [];

  await new Promise<void>((resolve) => {
    sendInlineAiStream(messages, {
      onTextDelta: (delta) => {
        buffer.push(delta);
      },
      onDone: () => {
        const raw = buffer.join("").trim();
        const rawBeats = parseBeatJson(raw);
        if (!rawBeats) {
          callbacks?.onError?.("AIの出力をパースできませんでした");
          resolve();
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
        resolve();
      },
      onError: (message) => {
        callbacks?.onError?.(message);
        resolve();
      },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks?.onError?.(msg);
      resolve();
    });
  });
}
