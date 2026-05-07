/**
 * Codex Entry 復元 (設計書 §6, §16.3)。
 * 新 ID 発行、parentId が現存しないときはルート。
 */
import {
  createCodexEntry,
  getCodexEntry,
  updateCodexEntry,
} from "@/features/codex/api";
import type { CodexEntryPayload, TrashItemData } from "../types";
import type { RestoreOutcome } from "./types";

export interface CodexRestoreOptions {
  projectId: string;
}

export async function restoreCodexEntry(
  item: TrashItemData,
  options: CodexRestoreOptions,
): Promise<RestoreOutcome> {
  if (item.subKind !== "codex-entry") {
    return { ok: false, reason: "rejected", message: "subKind mismatch" };
  }
  const payload = item.payload as CodexEntryPayload;
  const newId = crypto.randomUUID();
  const brokenLinks: string[] = [];

  let parentId: string | null = payload.parentId;
  if (parentId) {
    const parent = await getCodexEntry(parentId);
    if (!parent) {
      parentId = null;
      brokenLinks.push("parent");
    }
  }

  try {
    await createCodexEntry({
      id: newId,
      projectId: options.projectId,
      type: payload.category,
      name: payload.name,
      summary: payload.summary ?? undefined,
      aliases: payload.aliases ?? undefined,
      excludedAliases: payload.excludedAliases ?? undefined,
      parentId: parentId ?? undefined,
    });
    // body / icon / notes / contextMode / childrenBudget は createCodexEntry 経由で
    // 渡せないので updateCodexEntry で 2 段階に上書き。
    await updateCodexEntry(newId, {
      content: payload.body,
      icon: payload.icon ?? undefined,
      notes: payload.notes ?? undefined,
      contextMode: payload.contextMode,
      childrenBudget: payload.childrenBudget,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "internal-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  return { ok: true, newId, brokenLinks };
}
