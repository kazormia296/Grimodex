import { db } from "@/db/client";
import {
  foreshadows,
  foreshadowSetups,
  foreshadowCodexLinks,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { NewForeshadow, NewForeshadowSetup } from "@/db/schema";
import type { ForeshadowRow, ForeshadowSetupRow } from "./types";

// ── Foreshadow CRUD ───────────────────────────────────────────────

export async function createForeshadow(
  data: Omit<NewForeshadow, "createdAt" | "updatedAt">,
): Promise<ForeshadowRow> {
  const now = new Date();
  const row: NewForeshadow = { ...data, createdAt: now, updatedAt: now };
  await db.insert(foreshadows).values(row);
  const [created] = await db
    .select()
    .from(foreshadows)
    .where(eq(foreshadows.id, data.id));
  return created as ForeshadowRow;
}

export async function getForeshadow(id: string): Promise<ForeshadowRow | null> {
  const [row] = await db
    .select()
    .from(foreshadows)
    .where(eq(foreshadows.id, id));
  return (row as ForeshadowRow) ?? null;
}

export async function listForeshadows(
  projectId: string,
): Promise<ForeshadowRow[]> {
  return db
    .select()
    .from(foreshadows)
    .where(eq(foreshadows.projectId, projectId)) as Promise<ForeshadowRow[]>;
}

export async function updateForeshadow(
  id: string,
  patch: Partial<
    Pick<
      ForeshadowRow,
      | "title"
      | "intent"
      | "notes"
      | "payoffConfirmed"
      | "abandoned"
      | "payoffSceneId"
      | "payoffFromPos"
      | "payoffToPos"
    >
  >,
): Promise<void> {
  await db
    .update(foreshadows)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(foreshadows.id, id));
}

export async function deleteForeshadow(id: string): Promise<void> {
  await db.delete(foreshadows).where(eq(foreshadows.id, id));
}

// ── ForeshadowSetup CRUD ──────────────────────────────────────────

export async function createForeshadowSetup(
  data: Omit<NewForeshadowSetup, "createdAt" | "updatedAt">,
): Promise<ForeshadowSetupRow> {
  const now = new Date();
  const row: NewForeshadowSetup = { ...data, createdAt: now, updatedAt: now };
  await db.insert(foreshadowSetups).values(row);
  const [created] = await db
    .select()
    .from(foreshadowSetups)
    .where(eq(foreshadowSetups.id, data.id));
  return created as ForeshadowSetupRow;
}

export async function listSetups(
  foreshadowId: string,
): Promise<ForeshadowSetupRow[]> {
  return db
    .select()
    .from(foreshadowSetups)
    .where(eq(foreshadowSetups.foreshadowId, foreshadowId)) as Promise<
    ForeshadowSetupRow[]
  >;
}

export async function updateSetup(
  id: string,
  patch: Partial<
    Pick<
      ForeshadowSetupRow,
      "strength" | "aiStrength" | "aiReasoning" | "isOrphan"
    >
  >,
): Promise<void> {
  await db
    .update(foreshadowSetups)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(foreshadowSetups.id, id));
}

export async function deleteSetup(id: string): Promise<void> {
  await db.delete(foreshadowSetups).where(eq(foreshadowSetups.id, id));
}

// ── Codex link CRUD ───────────────────────────────────────────────

export async function addCodexLink(
  foreshadowId: string,
  codexEntryId: string,
): Promise<void> {
  await db
    .insert(foreshadowCodexLinks)
    .values({ foreshadowId, codexEntryId })
    .onConflictDoNothing();
}

export async function removeCodexLink(
  foreshadowId: string,
  codexEntryId: string,
): Promise<void> {
  await db
    .delete(foreshadowCodexLinks)
    .where(
      and(
        eq(foreshadowCodexLinks.foreshadowId, foreshadowId),
        eq(foreshadowCodexLinks.codexEntryId, codexEntryId),
      ),
    );
}

// ── AI propose stub ───────────────────────────────────────────────

export interface ProposedSetup {
  sceneId: string;
  sceneTitle: string;
  excerpt: string;
  reasoning: string;
}

/**
 * Stub for Phase 1: returns an empty array.
 * Phase 3 will invoke a Rust command that calls the AI to propose
 * retroactive setup positions in past scenes.
 */
export async function proposePastSetups(
  _foreshadowId: string,
): Promise<ProposedSetup[]> {
  return [];
}
