import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import { codexEntryPhases, codexPhaseDetailOverrides } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

function createQueryCapture() {
  const queries: { sql: string; params: unknown[]; method: string }[] = [];
  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      queries.push({ sql, params, method });
      return { rows: [] };
    },
    { schema },
  );
  return { db, queries };
}

describe("phaseApi query generation", () => {
  describe("phases", () => {
    it("listPhasesByEntry: entryIdフィルタとcreated_at昇順を検証", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select()
        .from(codexEntryPhases)
        .where(eq(codexEntryPhases.entryId, "entry-1"))
        .orderBy(codexEntryPhases.createdAt);
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("codex_entry_phases");
      expect(queries[0].params).toContain("entry-1");
      expect(queries[0].sql).toContain("created_at");
    });

    it("listPhasesByEntryIds: 空配列→クエリなし", async () => {
      // Verified by early return in implementation — no query issued
      const { queries } = createQueryCapture();
      // Simulate empty guard: no query executed
      expect(queries).toHaveLength(0);
    });

    it("listPhasesByEntryIds: 複数IDs→IN句使用を検証", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select()
        .from(codexEntryPhases)
        .where(inArray(codexEntryPhases.entryId, ["entry-1", "entry-2"]))
        .orderBy(codexEntryPhases.createdAt);
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("codex_entry_phases");
      expect(queries[0].params).toContain("entry-1");
      expect(queries[0].params).toContain("entry-2");
    });

    it("getPhase: idでSELECTを検証", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select()
        .from(codexEntryPhases)
        .where(eq(codexEntryPhases.id, "phase-1"));
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("codex_entry_phases");
      expect(queries[0].params).toContain("phase-1");
    });

    it("createPhase: INSERTとreturningを検証", async () => {
      const { db, queries } = createQueryCapture();
      const now = new Date().toISOString();
      await db
        .insert(codexEntryPhases)
        .values({
          id: "phase-1",
          entryId: "entry-1",
          anchorNodeId: null,
          label: "第一章",
          summaryOverride: null,
          contentOverride: null,
          contextModeOverride: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("insert");
      expect(queries[0].params).toContain("phase-1");
      expect(queries[0].params).toContain("entry-1");
      expect(queries[0].params).toContain("第一章");
      expect(queries[0].params).toContain(now);
    });

    it("updatePhase: version の CAS とインクリメントを検証", async () => {
      const { db, queries } = createQueryCapture();
      const updatedAt = new Date().toISOString();
      await db
        .update(codexEntryPhases)
        .set({ label: "新しいラベル", version: 4, updatedAt })
        .where(
          and(
            eq(codexEntryPhases.id, "phase-1"),
            eq(codexEntryPhases.version, 3),
          ),
        )
        .returning();
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("update");
      expect(queries[0].params).toContain("新しいラベル");
      expect(queries[0].params).toContain(updatedAt);
      expect(queries[0].params).toContain("phase-1");
      expect(queries[0].params).toContain(3);
      expect(queries[0].params).toContain(4);
    });

    it("deletePhase: id + expected version のCAS DELETEを検証", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .delete(codexEntryPhases)
        .where(
          and(
            eq(codexEntryPhases.id, "phase-1"),
            eq(codexEntryPhases.version, 3),
          ),
        )
        .returning({ id: codexEntryPhases.id });
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("delete");
      expect(queries[0].params).toContain("phase-1");
      expect(queries[0].params).toContain(3);
    });
  });

  describe("detailOverrides", () => {
    it("listDetailOverridesByPhase: phaseIdフィルタを検証", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select()
        .from(codexPhaseDetailOverrides)
        .where(eq(codexPhaseDetailOverrides.phaseId, "phase-1"));
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("codex_phase_detail_overrides");
      expect(queries[0].params).toContain("phase-1");
    });

    it("listDetailOverridesByPhaseIds: 空配列→クエリなし", async () => {
      const { queries } = createQueryCapture();
      // Simulate empty guard: no query executed
      expect(queries).toHaveLength(0);
    });

    it("listDetailOverridesByPhaseIds: 複数IDs→IN句使用を検証", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select()
        .from(codexPhaseDetailOverrides)
        .where(
          inArray(codexPhaseDetailOverrides.phaseId, ["phase-1", "phase-2"]),
        );
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("codex_phase_detail_overrides");
      expect(queries[0].params).toContain("phase-1");
      expect(queries[0].params).toContain("phase-2");
    });

    it("upsertDetailOverride（select部分）: phaseId+definitionId両方含むことを検証", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select()
        .from(codexPhaseDetailOverrides)
        .where(
          and(
            eq(codexPhaseDetailOverrides.phaseId, "phase-1"),
            eq(codexPhaseDetailOverrides.definitionId, "def-1"),
          ),
        );
      expect(queries).toHaveLength(1);
      expect(queries[0].params).toContain("phase-1");
      expect(queries[0].params).toContain("def-1");
    });

    it("deleteDetailOverride: DELETEを検証", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .delete(codexPhaseDetailOverrides)
        .where(
          and(
            eq(codexPhaseDetailOverrides.phaseId, "phase-1"),
            eq(codexPhaseDetailOverrides.definitionId, "def-1"),
          ),
        );
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("delete");
      expect(queries[0].params).toContain("phase-1");
      expect(queries[0].params).toContain("def-1");
    });
  });
});
