import { db } from "@/db/client";
import { generationLogs } from "@/db/schema";
import { useTreeStore } from "@/features/tree/treeStore";

export interface InsertGenerationLogInput {
  kind: "inline-ai" | "beat";
  commandId?: string | null;
  instruction?: string | null;
  sceneNodeId?: string | null;
  model?: string | null;
  traceId: string;
  /** Full prompt (system + user) actually sent to the model. Populates the
   * process-disclosure export for slash/beat generations. Chat carries its own
   * snapshot via chat_message_prompts, so this is only wired for inline-ai/beat.
   * Legacy rows are null (the column was never populated before this). */
  promptFull?: string | null;
}

/**
 * Serialize the prompt messages actually sent to the model into a single
 * disclosure-ready string, stored in generation_logs.promptFull. Lets the
 * process-disclosure export show the full prompt input for slash/beat
 * generations.
 */
export function serializePromptMessages(
  messages: { role: string; content: string }[],
): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

function isUniqueTraceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("UNIQUE") &&
    message.includes("generation_logs") &&
    message.includes("trace")
  );
}

export async function insertGenerationLog(
  input: InsertGenerationLogInput,
): Promise<void> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) return;

  try {
    await db.insert(generationLogs).values({
      id: crypto.randomUUID(),
      projectId,
      sceneNodeId: input.sceneNodeId ?? null,
      kind: input.kind,
      commandId: input.commandId ?? null,
      instruction: input.instruction ?? null,
      promptFull: input.promptFull ?? null,
      model: input.model ?? null,
      traceId: input.traceId,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    if (isUniqueTraceError(err)) return;
    throw err;
  }
}
