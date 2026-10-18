import { describe, expect, it, vi } from "vitest";
import statementVector from "../../../evals/nir1-packing/final-request-create-session-statement.v1.json";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

import { createSession } from "./chatApi";

// DP-H (K6/2 "setup の前提と history 枠" 7): the chat session of every request
// is created with the statement the renderer's createSession sends to
// db_execute. The Rust harness builds the same statement from the vector file;
// this test fixes that the renderer function still sends exactly that statement,
// so the harness cannot drift from the renderer.

const PROJECT_ID = "dph-project";
const NODE_ID = "dph-scene";
const TITLE = "dph chat session";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function columnsOf(sql: string): string[] {
  const match = /^insert into "chat_sessions" \(([^)]*)\)/.exec(sql);
  if (!match) throw new Error("not an insert into chat_sessions");
  return match[1].split(",").map((column) => column.trim().replace(/"/g, ""));
}

describe("createSession statement (DP-H harness pin)", () => {
  it("sends the vector's statement through db_execute", async () => {
    invokeMock.mockReset();
    // The renderer reads the inserted row back (`returning`): answer with the
    // row it just inserted, columns in statement order.
    invokeMock.mockImplementation(
      async (command: string, args?: { sql: string; params: unknown[] }) => {
        expect(command).toBe("db_execute");
        const columns = columnsOf(args?.sql ?? "");
        return {
          rows: [
            Object.fromEntries(
              columns.map((column, index) => [column, args?.params[index]]),
            ),
          ],
        };
      },
    );

    await createSession(PROJECT_ID, TITLE, NODE_ID);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0] as [
      string,
      { sql: string; params: unknown[]; method: string },
    ];
    expect(command).toBe("db_execute");
    expect(args.sql).toBe(statementVector.sql);
    expect(args.method).toBe(statementVector.method);
    expect(args.params).toHaveLength(statementVector.paramSlots.length);

    // Each parameter is the kind the vector's slot names.
    statementVector.paramSlots.forEach((slot, index) => {
      const value = args.params[index];
      switch (slot) {
        case "generated-uuid":
          expect(value).toMatch(UUID_PATTERN);
          break;
        case "project-id":
          expect(value).toBe(PROJECT_ID);
          break;
        case "node-id":
          expect(value).toBe(NODE_ID);
          break;
        case "title":
          expect(value).toBe(TITLE);
          break;
        case "null":
          expect(value).toBeNull();
          break;
        case "constant:0":
          expect(value).toBe(0);
          break;
        case "schema-default-model":
          expect(value).toBe(statementVector.schemaDefaultModel);
          break;
        case "generated-instant":
          expect(value).toMatch(INSTANT_PATTERN);
          break;
        default:
          throw new Error(`unknown vector slot ${slot}`);
      }
    });
    // createdAt and updatedAt are one instant.
    expect(args.params[8]).toBe(args.params[9]);
  });
});
