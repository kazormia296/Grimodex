import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const recordChangeEventMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./chronicleStore", () => ({
  useChronicleStore: {
    getState: () => ({ bumpRevision: vi.fn() }),
  },
}));

vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "calendar-session",
  recordChangeEvent: recordChangeEventMock,
}));

import { upsertProjectCalendar } from "./api";
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

function row(version: number) {
  return {
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
    version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("upsertProjectCalendar OCC adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    recordChangeEventMock.mockReset();
  });

  it("invokes Native typed command and returns the persisted row", async () => {
    invokeMock.mockResolvedValue(row(0));
    const created = await upsertProjectCalendar(calendarInput, {
      baseVersion: null,
    });
    expect(invokeMock).toHaveBeenCalledWith("project_calendar_upsert", {
      payload: expect.objectContaining({
        projectId: PROJECT_ID,
        requestId: expect.any(String),
        sessionId: "calendar-session",
        eventUid: expect.any(String),
        baseVersion: null,
        daysPerYear: 360,
      }),
    });
    const payload = invokeMock.mock.calls[0]?.[1]?.payload as
      | { requestId?: string; eventUid?: string }
      | undefined;
    expect(payload?.eventUid).toBe(payload?.requestId);
    expect(recordChangeEventMock).not.toHaveBeenCalled();
    expect(created.version).toBe(0);
  });

  it("maps Native null to ProjectCalendarVersionConflictError", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(
      upsertProjectCalendar(calendarInput, { baseVersion: 0 }),
    ).rejects.toBeInstanceOf(ProjectCalendarVersionConflictError);
  });

  it("passes observed baseVersion through for OCC updates", async () => {
    invokeMock.mockResolvedValue(row(1));
    const updated = await upsertProjectCalendar(
      { ...calendarInput, daysPerYear: 365 },
      { baseVersion: 0 },
    );
    expect(invokeMock).toHaveBeenCalledWith("project_calendar_upsert", {
      payload: expect.objectContaining({
        baseVersion: 0,
        daysPerYear: 365,
      }),
    });
    expect(updated.version).toBe(1);
  });
});
