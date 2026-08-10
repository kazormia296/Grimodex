import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projectCalendar, projects } from "@/db/schema";
import { getProjectCalendar, upsertProjectCalendar } from "./api";
import { ProjectCalendarVersionConflictError } from "./calendarOcc";

const PROJECT_ID = "calendar-occ-project";

const calendarInput = {
  projectId: PROJECT_ID,
  daysPerYear: 360,
  seasonBoundaries: "[]",
  startYear: 100,
  months: "[]",
  weekdayNames: "[]",
  weekdayStartIndex: 0,
  leapRule: '{"kind":"none"}',
  ageReckoning: "full",
  eras: "[]",
  reform: "null",
  timezone: "null",
  lunarTzMinutes: 480,
};

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, title: PROJECT_ID });
});

beforeEach(async () => {
  await db
    .delete(projectCalendar)
    .where(eq(projectCalendar.projectId, PROJECT_ID));
});

describe("upsertProjectCalendar OCC", () => {
  it("creates only when the caller observed an absent row", async () => {
    const created = await upsertProjectCalendar(calendarInput, {
      baseVersion: null,
    });

    expect(created.version).toBe(0);
    await expect(
      upsertProjectCalendar(calendarInput, { baseVersion: null }),
    ).rejects.toBeInstanceOf(ProjectCalendarVersionConflictError);
  });

  it("increments version on a matching update and returns the persisted row", async () => {
    const created = await upsertProjectCalendar(calendarInput, {
      baseVersion: null,
    });
    const updated = await upsertProjectCalendar(
      { ...calendarInput, daysPerYear: 400 },
      { baseVersion: created.version },
    );

    expect(updated.daysPerYear).toBe(400);
    expect(updated.version).toBe(1);
    await expect(getProjectCalendar(PROJECT_ID)).resolves.toMatchObject({
      daysPerYear: 400,
      version: 1,
    });
  });

  it("rejects a stale update without changing calendar data or version", async () => {
    await upsertProjectCalendar(calendarInput, { baseVersion: null });
    await upsertProjectCalendar(
      { ...calendarInput, daysPerYear: 365 },
      { baseVersion: 0 },
    );

    await expect(
      upsertProjectCalendar(
        { ...calendarInput, daysPerYear: 999 },
        { baseVersion: 0 },
      ),
    ).rejects.toBeInstanceOf(ProjectCalendarVersionConflictError);
    await expect(getProjectCalendar(PROJECT_ID)).resolves.toMatchObject({
      daysPerYear: 365,
      version: 1,
    });
  });

  it("chains consecutive saves with the returned version token", async () => {
    const created = await upsertProjectCalendar(calendarInput, {
      baseVersion: null,
    });
    const first = await upsertProjectCalendar(calendarInput, {
      baseVersion: created.version,
    });
    const second = await upsertProjectCalendar(calendarInput, {
      baseVersion: first.version,
    });

    expect(second.version).toBe(2);
  });
});
