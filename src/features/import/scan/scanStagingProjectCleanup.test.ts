import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/client";
import { projectSettings, projects } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { SCAN_IMPORT_STATE_KEY, SCAN_IMPORT_STAGING } from "./scanImportState";
import { cleanupStaleScanStagingProjects } from "./scanStagingProject";

const NOW = new Date("2026-07-16T12:00:00.000Z");

async function insertProject(
  id: string,
  createdAt: string,
  staging: boolean,
): Promise<void> {
  await db.insert(projects).values({
    id,
    title: id,
    language: "ja",
    createdAt,
    updatedAt: createdAt,
  });
  if (staging) {
    await db.insert(projectSettings).values({
      projectId: id,
      key: SCAN_IMPORT_STATE_KEY,
      value: SCAN_IMPORT_STAGING,
    });
  }
}

describe("cleanupStaleScanStagingProjects", () => {
  beforeEach(async () => {
    for (const id of ["scan-stale", "scan-live", "scan-published"]) {
      await db.delete(projects).where(eq(projects.id, id));
    }
  });

  it("deletes only hidden staging projects older than the crash grace period", async () => {
    await insertProject("scan-stale", "2026-07-15T11:59:59.000Z", true);
    await insertProject("scan-live", "2026-07-16T11:00:00.000Z", true);
    await insertProject("scan-published", "2026-07-14T00:00:00.000Z", false);

    await expect(cleanupStaleScanStagingProjects(NOW)).resolves.toBe(1);

    const remaining = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        inArray(projects.id, ["scan-stale", "scan-live", "scan-published"]),
      );
    expect(remaining.map((row) => row.id).sort()).toEqual([
      "scan-live",
      "scan-published",
    ]);
  });
});
