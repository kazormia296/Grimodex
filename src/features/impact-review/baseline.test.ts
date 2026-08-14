import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSnapshot } from "./diff";
import { createBrowserMock } from "@/lib/browser-mock";

const { mockInvoke, mockRecordChangeEvent } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRecordChangeEvent: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));
vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: mockRecordChangeEvent,
}));

import { getBaseline, saveBaseline } from "./baseline";

const BASELINE_CONTENT_HASH_SYMBOL = Symbol.for(
  "grimodex.impactReviewBaseline.contentHash",
);
const snapshot: CodexSnapshot = {
  name: "アリス",
  aliases: ["アリー"],
  summary: "15歳。",
  contentPlain: "町に住む。",
  details: [{ name: "年齢", value: "15" }],
};
const sourceGuard = {
  kind: "sqlite_revision_v1" as const,
  expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
  expected_total_changes: "42",
  expected_data_version: "7",
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockRecordChangeEvent.mockReset();
});

describe("impact review baseline", () => {
  it("attaches the stored content hash as non-enumerable snapshot metadata", async () => {
    mockInvoke.mockResolvedValue({
      rows: [
        {
          snapshotJson: JSON.stringify(snapshot),
          contentHash: "stored-hash",
        },
      ],
    });

    const result = await getBaseline("entry-1");

    expect(result).toEqual(snapshot);
    expect(Reflect.get(result as object, BASELINE_CONTENT_HASH_SYMBOL)).toBe(
      "stored-hash",
    );
    expect(
      Object.getOwnPropertyDescriptor(result, BASELINE_CONTENT_HASH_SYMBOL)
        ?.enumerable,
    ).toBe(false);
    expect({ ...result }).toEqual(snapshot);
  });

  it("uses expectedContentHash in a conditional update before recording success", async () => {
    mockInvoke.mockResolvedValue({ rows: [{ entryId: "entry-1" }] });

    const contentHash = await saveBaseline(
      "project-1",
      "entry-1",
      snapshot,
      "expected-hash",
    );

    expect(contentHash).toMatch(/^[0-9a-f]{8}$/);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [command, args] = mockInvoke.mock.calls[0] as unknown as [
      string,
      { sql: string; params: unknown[]; method: string },
    ];
    expect(command).toBe("db_execute");
    expect(args.method).toBe("all");
    expect(args.sql).toMatch(/^update\s+"impact_review_baselines"/i);
    expect(args.sql).toMatch(/"entry_id"\s*=\s*\?/i);
    expect(args.sql).toMatch(/"content_hash"\s*=\s*\?/i);
    expect(args.params).toEqual(
      expect.arrayContaining(["entry-1", "expected-hash"]),
    );
    expect(mockRecordChangeEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects a conditional-update conflict without recording a save", async () => {
    mockInvoke.mockResolvedValue({ rows: [] });

    await expect(
      saveBaseline("project-1", "entry-1", snapshot, "stale-hash"),
    ).rejects.toThrow("Impact baseline changed concurrently");

    expect(mockRecordChangeEvent).not.toHaveBeenCalled();
  });

  it("combines the baseline CAS and SQLite source guard in one statement", async () => {
    mockInvoke.mockResolvedValue({ rows: [{ entryId: "entry-1" }] });

    await saveBaseline(
      "project-1",
      "entry-1",
      snapshot,
      "expected-hash",
      sourceGuard,
    );

    const [, args] = mockInvoke.mock.calls[0] as unknown as [
      string,
      { sql: string; params: unknown[]; method: string },
    ];
    expect(args.sql).toContain("temp.grimodex_connection_meta");
    expect(args.sql).toContain("total_changes()");
    expect(args.sql).toContain("pragma_data_version");
    expect(args.params).toEqual(
      expect.arrayContaining([
        "expected-hash",
        sourceGuard.expected_connection_epoch,
        sourceGuard.expected_total_changes,
        sourceGuard.expected_data_version,
      ]),
    );
  });

  it("reports a guarded baseline race as a retryable source change", async () => {
    mockInvoke.mockResolvedValue({ rows: [] });

    await expect(
      saveBaseline(
        "project-1",
        "entry-1",
        snapshot,
        "expected-hash",
        sourceGuard,
      ),
    ).rejects.toThrow("IMPACT_SOURCE_CHANGED");
    expect(mockRecordChangeEvent).not.toHaveBeenCalled();
  });

  it("executes a guarded first-baseline insert against the browser SQLite connection", async () => {
    const browser = await createBrowserMock({
      allowProtectedWriterTestFixtures: true,
    });
    const now = new Date().toISOString();
    await browser.invoke("db_execute", {
      sql: `INSERT INTO codex_entries
        (id, project_id, type, name, content, context_mode,
         children_budget, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        "entry-browser-baseline",
        "default-project",
        "character",
        "アリス",
        "{}",
        "mentioned",
        "compact",
        now,
        now,
      ],
      method: "run",
    });
    const revision = await browser.invoke<{
      rows: Array<{
        epoch: string;
        totalChanges: string;
        dataVersion: string;
      }>;
    }>("db_execute", {
      sql: `SELECT epoch,
                   CAST(total_changes() AS TEXT) AS totalChanges,
                   CAST((SELECT data_version FROM pragma_data_version) AS TEXT) AS dataVersion
              FROM temp.grimodex_connection_meta
             WHERE singleton = 1`,
      params: [],
      method: "all",
    });
    const current = revision.rows[0];
    mockInvoke.mockImplementation(browser.invoke);

    await saveBaseline(
      "default-project",
      "entry-browser-baseline",
      snapshot,
      null,
      {
        kind: "sqlite_revision_v1",
        expected_connection_epoch: current.epoch,
        expected_total_changes: current.totalChanges,
        expected_data_version: current.dataVersion,
      },
    );

    expect(await getBaseline("entry-browser-baseline")).toEqual(snapshot);
  });
});
