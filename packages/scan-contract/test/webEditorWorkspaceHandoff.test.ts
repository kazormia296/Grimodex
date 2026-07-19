import { describe, expect, it } from "vitest";
import {
  WEB_EDITOR_WORKSPACE_HANDOFF_SCHEMA_VERSION,
  buildWebEditorHandoffFilename,
  buildWebEditorWorkspaceHandoff,
  parseWebEditorWorkspaceHandoff,
} from "../src/index.js";

const SQLITE_MAGIC = new TextEncoder().encode("SQLite format 3\0");

function sqliteDatabaseBytes(size = 100): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, SQLITE_MAGIC.byteLength));
  bytes.set(SQLITE_MAGIC);
  // A conventional 4 KiB SQLite page-size header keeps the fixture
  // recognisable while the contract intentionally validates only the magic.
  if (bytes.byteLength >= 18) {
    bytes[16] = 0x10;
    bytes[17] = 0x00;
  }
  return bytes;
}

function validHandoff() {
  return buildWebEditorWorkspaceHandoff({
    databaseBytes: sqliteDatabaseBytes(),
    createdAt: "2026-07-19T03:04:05.000Z",
    sourceMode: "scan",
    uiLanguage: "ja",
    projectId: "project-scan-1",
    title: "白い灯台",
  });
}

function expectInvalid(input: unknown): void {
  const result = parseWebEditorWorkspaceHandoff(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
}

describe("Web Editor workspace handoff contract", () => {
  it("builds a versioned JSON-safe base64 envelope and parses it losslessly", () => {
    const databaseBytes = sqliteDatabaseBytes(128);
    databaseBytes[99] = 0xa5;

    const built = buildWebEditorWorkspaceHandoff({
      databaseBytes,
      createdAt: "2026-07-19T03:04:05.000Z",
      sourceMode: "standalone",
      uiLanguage: "en",
      projectId: "project-standalone-1",
      title: "The White Lighthouse",
    });

    expect(built).toEqual({
      schemaVersion: WEB_EDITOR_WORKSPACE_HANDOFF_SCHEMA_VERSION,
      encoding: "base64",
      databaseBase64: Buffer.from(databaseBytes).toString("base64"),
      createdAt: "2026-07-19T03:04:05.000Z",
      sourceMode: "standalone",
      uiLanguage: "en",
      projectId: "project-standalone-1",
      title: "The White Lighthouse",
    });

    // Exercise the actual file boundary, rather than passing object identity
    // from builder to parser.
    const parsed = parseWebEditorWorkspaceHandoff(
      JSON.parse(JSON.stringify(built)) as unknown,
    );
    expect(parsed).toEqual({ ok: true, value: built });
    if (parsed.ok) {
      expect(
        new Uint8Array(Buffer.from(parsed.value.databaseBase64, "base64")),
      ).toEqual(databaseBytes);
    }
  });

  it("uses an exact, versioned top-level schema", () => {
    expect(WEB_EDITOR_WORKSPACE_HANDOFF_SCHEMA_VERSION).toBe(
      "grimodex/web-editor-workspace-handoff/1",
    );
    const valid = validHandoff();
    const { title: _title, ...missingRequiredProperty } = valid;

    expectInvalid(missingRequiredProperty);
    expectInvalid({ ...valid, unexpected: true });
    expectInvalid({
      ...valid,
      schemaVersion: "grimodex/web-editor-workspace-handoff/999",
    });
  });

  it.each([
    ["encoding", { encoding: "hex" }],
    ["createdAt", { createdAt: "yesterday" }],
    ["sourceMode", { sourceMode: "desktop" }],
    ["uiLanguage", { uiLanguage: "fr" }],
    ["projectId", { projectId: "" }],
    ["title", { title: "" }],
  ])("rejects an invalid %s", (_label, patch) => {
    expectInvalid({ ...validHandoff(), ...patch });
  });

  it.each([
    "not-base64!",
    "U1FMaXRlIGZvcm1hdCAzAA", // missing canonical padding
    "U1FMaXRlIGZvcm1hdCAzAA==\n", // whitespace is not canonical JSON base64
  ])("rejects malformed or non-canonical base64: %s", (databaseBase64) => {
    expectInvalid({ ...validHandoff(), databaseBase64 });
  });

  it("rejects base64 bytes that are not a SQLite database", () => {
    const bytes = sqliteDatabaseBytes();
    bytes[0] = "X".charCodeAt(0);

    expectInvalid({
      ...validHandoff(),
      databaseBase64: Buffer.from(bytes).toString("base64"),
    });
  });

  it("rejects decoded database bytes over the configured upper bound", () => {
    const bytes = sqliteDatabaseBytes(101);
    const handoff = {
      ...validHandoff(),
      databaseBase64: Buffer.from(bytes).toString("base64"),
    };

    const result = parseWebEditorWorkspaceHandoff(handoff, {
      maxDatabaseBytes: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "limit",
            path: "/databaseBase64",
          }),
        ]),
      );
    }
  });
});

describe("buildWebEditorHandoffFilename", () => {
  it("sanitizes path separators, control characters, traversal, and reserved punctuation", () => {
    const filename = buildWebEditorHandoffFilename(
      " ../白い/灯台\\第1章:*?\"<>|\u0000.. ",
    );

    expect(filename).toMatch(/\.grimodex-handoff$/u);
    expect(filename).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/u);
    expect(filename).not.toContain("..");
    expect(filename).not.toMatch(/^\./u);
  });

  it("returns a non-empty bounded JSON filename for an empty or huge title", () => {
    const fallback = buildWebEditorHandoffFilename(" . \u0000 ");
    const bounded = buildWebEditorHandoffFilename("灯".repeat(1_000));

    expect(fallback).toMatch(/^[^.].*\.grimodex-handoff$/u);
    expect(bounded).toMatch(/\.grimodex-handoff$/u);
    expect(bounded.length).toBeLessThanOrEqual(128);
  });
});
