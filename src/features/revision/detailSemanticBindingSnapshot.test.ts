import { describe, expect, it } from "vitest";

import {
  AUX_PROJECT_FILTER,
  AUX_SCOPES,
  AUX_SCOPE_OWNER,
  AUX_TABLE,
} from "./projectSnapshotScopes";
import { SNAPSHOT_RESTORE_TABLES } from "./projectSnapshotNative";

const BINDING_SCOPE = "codex_detail_semantic_bindings";

describe("detail semantic binding snapshot declarations", () => {
  it("captures semantic bindings as Project-scoped Codex state", () => {
    const scopes = AUX_SCOPES as readonly string[];
    expect(scopes).toContain(BINDING_SCOPE);
    if (!scopes.includes(BINDING_SCOPE)) return;

    const scope = BINDING_SCOPE as keyof typeof AUX_SCOPE_OWNER;
    expect(AUX_SCOPE_OWNER[scope]).toBe("codex");
    expect(AUX_TABLE[scope]).toBe(BINDING_SCOPE);
    expect(AUX_PROJECT_FILTER[scope]).toEqual({
      where: "project_id = ?",
      binds: 1,
    });
  });

  it("restores bindings after their detail definition parent", () => {
    const scopes = AUX_SCOPES as readonly string[];
    expect(scopes).toContain(BINDING_SCOPE);
    expect(SNAPSHOT_RESTORE_TABLES as readonly string[]).toContain(
      BINDING_SCOPE,
    );

    expect(scopes.indexOf("codex_detail_definitions")).toBeLessThan(
      scopes.indexOf(BINDING_SCOPE),
    );
    expect(
      (SNAPSHOT_RESTORE_TABLES as readonly string[]).indexOf(
        "codex_detail_definitions",
      ),
    ).toBeLessThan(
      (SNAPSHOT_RESTORE_TABLES as readonly string[]).indexOf(BINDING_SCOPE),
    );
  });
});
