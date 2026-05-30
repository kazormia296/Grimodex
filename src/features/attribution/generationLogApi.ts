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
      promptFull: null,
      model: input.model ?? null,
      traceId: input.traceId,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    if (isUniqueTraceError(err)) return;
    throw err;
  }
}
