import { describe, expect, it, vi } from "vitest";
import { importWebEditorWorkspaceHandoff } from "./webEditorWorkspaceImport";

const handoff = {
  schemaVersion: "grimodex/web-editor-workspace-handoff/1",
  encoding: "base64",
  databaseBase64: "U1FMaXRlIGZvcm1hdCAzAA==",
  createdAt: "2026-07-19T03:04:05.000Z",
  sourceMode: "scan",
  uiLanguage: "ja",
  projectId: "project-1",
  title: "白い灯台",
} as const;

describe("importWebEditorWorkspaceHandoff", () => {
  it("validates the selected handoff, materializes it natively, and opens the new workspace", async () => {
    const handoffJson = JSON.stringify(handoff);
    const openTextFile = vi.fn(async () => ({
      name: "白い灯台.grimodex-handoff",
      content: handoffJson,
    }));
    const parseHandoff = vi.fn(() => ({ ok: true as const, value: handoff }));
    const invoke = vi.fn(async () => ({
      path: "/app-data/web-editor-workspace-1",
      projectId: "project-1",
    }));
    const openWorkspace = vi.fn(async () => undefined);

    const result = await importWebEditorWorkspaceHandoff({
      openTextFile,
      parseHandoff,
      invoke,
      openWorkspace,
    });

    expect(openTextFile).toHaveBeenCalledWith({
      name: "Grimodex Web Editor handoff",
      extensions: ["grimodex-handoff"],
    });
    expect(parseHandoff).toHaveBeenCalledWith(JSON.parse(handoffJson));
    expect(invoke).toHaveBeenCalledWith("import_web_editor_workspace", {
      handoffJson,
    });
    expect(openWorkspace).toHaveBeenCalledWith(
      "/app-data/web-editor-workspace-1",
    );
    expect(result).toEqual({
      status: "imported",
      fileName: "白い灯台.grimodex-handoff",
      handoff,
      path: "/app-data/web-editor-workspace-1",
      projectId: "project-1",
    });
  });

  it("returns canceled without invoking native import", async () => {
    const invoke = vi.fn();
    const result = await importWebEditorWorkspaceHandoff({
      openTextFile: vi.fn(async () => null),
      parseHandoff: vi.fn(),
      invoke,
      openWorkspace: vi.fn(),
    });

    expect(result).toEqual({ status: "canceled" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid handoff contracts before native import", async () => {
    const invoke = vi.fn();
    await expect(
      importWebEditorWorkspaceHandoff({
        openTextFile: vi.fn(async () => ({
          name: "bad.grimodex-handoff",
          content: "{bad json",
        })),
        parseHandoff: vi.fn(),
        invoke,
        openWorkspace: vi.fn(),
      }),
    ).rejects.toThrow(/valid JSON/i);
    expect(invoke).not.toHaveBeenCalled();

    await expect(
      importWebEditorWorkspaceHandoff({
        openTextFile: vi.fn(async () => ({
          name: "bad.grimodex-handoff",
          content: JSON.stringify({ schemaVersion: "wrong" }),
        })),
        parseHandoff: vi.fn(() => ({
          ok: false as const,
          errors: [{ code: "schema", path: "/", message: "invalid" }],
        })),
        invoke,
        openWorkspace: vi.fn(),
      }),
    ).rejects.toThrow(/invalid Web Editor handoff/i);
    expect(invoke).not.toHaveBeenCalled();
  });
});
