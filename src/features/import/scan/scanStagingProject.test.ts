import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, invokeMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: { insert: insertMock } }));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import { createScanStagingProject } from "./scanStagingProject";

describe("createScanStagingProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock
      .mockReturnValueOnce({
        values: () => ({
          toSQL: () => ({
            sql: "INSERT INTO projects (id, title) VALUES (?, ?)",
            params: ["project-1", "Imported novel"],
          }),
        }),
      })
      .mockReturnValueOnce({
        values: () => ({
          onConflictDoUpdate: () => ({
            toSQL: () => ({
              sql: "INSERT INTO project_settings (project_id, key, value) VALUES (?, ?, ?)",
              params: ["project-1", "scan.import.state", "staging"],
            }),
          }),
        }),
      });
    invokeMock.mockResolvedValue({ rows: [] });
  });

  it("creates the project and hidden marker in one native transaction", async () => {
    await createScanStagingProject({
      id: "project-1",
      title: "Imported novel",
      language: "en",
    });

    expect(invokeMock).toHaveBeenCalledOnce();
    const [command, payload] = invokeMock.mock.calls[0]!;
    expect(command).toBe("db_execute_batch");
    const statements = (
      payload as {
        statements: Array<{ sql: string; params: unknown[]; method: string }>;
      }
    ).statements;
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("INSERT INTO projects");
    expect(statements[1]?.sql).toContain("INSERT INTO project_settings");
    expect(statements.every((statement) => statement.method === "run")).toBe(
      true,
    );
  });
});
